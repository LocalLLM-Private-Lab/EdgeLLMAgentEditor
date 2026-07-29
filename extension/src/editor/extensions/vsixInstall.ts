import { unzipSync } from 'fflate';
import { useExtensionsStore, type InstalledExtension, type ConfigPropertySchema } from '../state/extensionsStore';
import { bytesToBase64 } from '../terminal/wsTerminalClient';

interface ConfigurationSection {
  properties?: Record<string, Omit<ConfigPropertySchema, 'key'>>;
}

interface ExtensionManifest {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  publisher?: string;
  icon?: string;
  activationEvents?: string[];
  contributes?: {
    configuration?: ConfigurationSection | ConfigurationSection[];
    commands?: CommandContribution[];
    viewsContainers?: {
      activitybar?: ViewContainerContribution[];
      panel?: ViewContainerContribution[];
    };
    views?: Record<string, ViewContribution[]>;
  };
}

/** One `contributes.commands` entry — VS Code's FEATURES tab lists these
 * as "declared" commands, distinct from what actually got registered at
 * runtime (see extStatus.commands in ExtensionDetailView.tsx, sourced from
 * the shim's own observation of activate()). */
export interface CommandContribution {
  command: string;
  title: string;
  category?: string;
}

/** One `contributes.viewsContainers.{activitybar,panel}` entry — flattened
 * into a single list (which bar it was declared for isn't tracked, since
 * this app's own activity bar/panel docking is unrelated to VS Code's). */
export interface ViewContainerContribution {
  id: string;
  title: string;
  icon?: string;
}

/** One entry from a `contributes.views` container's array. */
export interface ViewContribution {
  id: string;
  name: string;
}

// `contributes.configuration` may be a single section or an array of them
// (VS Code allows both) — flattened into one list of properties for the
// settings UI (ExtensionConfigFields.tsx). An extension with none of this
// simply gets no settings button (see ExtensionsPanel.tsx's configSchema
// length check).
function flattenConfigurationSchema(
  configuration: ConfigurationSection | ConfigurationSection[] | undefined,
): ConfigPropertySchema[] {
  if (!configuration) return [];
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const result: ConfigPropertySchema[] = [];
  for (const section of sections) {
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      result.push({ key, ...schema });
    }
  }
  return result;
}

// Not strict about the real VSIX spec (extension.vsixmanifest XML etc.) —
// per the plan, this app treats "an extension" as "a zip with a
// package.json-rooted VS Code-shaped manifest somewhere inside it".
// `extension/package.json` is the real vsix layout; a bare root
// `package.json` is accepted too for a plain zip that isn't a vsix at all.
// The matched prefix is returned alongside the bytes since icon/readme
// paths (both declared relative to the manifest) need to resolve against
// the same base.
function findManifestEntry(files: Record<string, Uint8Array>): { bytes: Uint8Array; prefix: string } | null {
  if (files['extension/package.json']) return { bytes: files['extension/package.json'], prefix: 'extension/' };
  if (files['package.json']) return { bytes: files['package.json'], prefix: '' };
  return null;
}

const ICON_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

/** `manifest.icon` (e.g. "resources/icon.png") resolved against the
 * manifest's own folder and converted to a data URL so it can be stored
 * as plain persisted text (chrome.storage) and shown without re-touching
 * OPFS. Returns undefined whenever there's no icon field, the referenced
 * file isn't actually in the archive, or its extension isn't one of the
 * handful of image formats VS Code extensions actually use. */
function extractIcon(files: Record<string, Uint8Array>, prefix: string, manifest: ExtensionManifest): string | undefined {
  if (!manifest.icon) return undefined;
  const bytes = files[`${prefix}${manifest.icon}`];
  if (!bytes) return undefined;
  const extension = manifest.icon.split('.').pop()?.toLowerCase() ?? '';
  const mime = ICON_MIME_BY_EXTENSION[extension];
  if (!mime) return undefined;
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

const README_CANDIDATES = ['readme.md', 'README.md', 'Readme.md'];

/** VS Code's own Extensions view renders the extension's README as the
 * main body of its detail page — same idea here (see
 * ExtensionDetailView.tsx). Zip entry names are case-sensitive, so a
 * couple of common casings are tried explicitly. */
function findReadme(files: Record<string, Uint8Array>, prefix: string): string | undefined {
  for (const name of README_CANDIDATES) {
    const bytes = files[`${prefix}${name}`];
    if (bytes) return new TextDecoder().decode(bytes);
  }
  return undefined;
}

function deriveExtensionId(manifest: ExtensionManifest): string {
  return manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name;
}

async function getExtensionsRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory();
  return opfsRoot.getDirectoryHandle('extensions', { create: true });
}

// Only the raw archive bytes are persisted (OPFS, origin-private — never
// the opened workspace or this repo, so there's nothing to .gitignore).
// Re-activation resends these same bytes to terminal-host, which does its
// own extraction on real disk; nothing here needs the extracted file tree.
async function saveArchive(id: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const root = await getExtensionsRoot();
  const fileHandle = await root.getFileHandle(`${id}.zip`, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

export async function loadArchiveBytes(id: string): Promise<Uint8Array<ArrayBuffer>> {
  const root = await getExtensionsRoot();
  const fileHandle = await root.getFileHandle(`${id}.zip`);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Everything about an installed extension that's derived from its
 * manifest/archive contents, as opposed to install-time bookkeeping
 * (`id`, `installedAt`). Shared by `pickAndInstallExtension` (fresh
 * install) and `backfillMetadataFromArchive` (re-derives the same fields
 * for a record that predates one of them being captured at all — see
 * extensionsStore.ts's `loadExtensions`). */
export type ExtractedMetadata = Pick<
  InstalledExtension,
  | 'name'
  | 'displayName'
  | 'version'
  | 'description'
  | 'publisher'
  | 'configSchema'
  | 'iconDataUrl'
  | 'readme'
  | 'activationEvents'
  | 'commandContributions'
  | 'viewContainers'
  | 'views'
>;

function extractMetadata(bytes: Uint8Array): { id: string; metadata: ExtractedMetadata } {
  const files = unzipSync(bytes);
  const manifestEntry = findManifestEntry(files);
  if (!manifestEntry) {
    throw new Error('package.json が見つかりませんでした(extension/package.json またはルート直下を探しました)。');
  }
  const manifest: ExtensionManifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  return {
    id: deriveExtensionId(manifest),
    metadata: {
      name: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      version: manifest.version,
      description: manifest.description,
      publisher: manifest.publisher,
      configSchema: flattenConfigurationSchema(manifest.contributes?.configuration),
      iconDataUrl: extractIcon(files, manifestEntry.prefix, manifest),
      readme: findReadme(files, manifestEntry.prefix),
      activationEvents: manifest.activationEvents ?? [],
      commandContributions: manifest.contributes?.commands ?? [],
      viewContainers: [
        ...(manifest.contributes?.viewsContainers?.activitybar ?? []),
        ...(manifest.contributes?.viewsContainers?.panel ?? []),
      ],
      views: manifest.contributes?.views ?? {},
    },
  };
}

/** Opens a file picker for a .vsix (or any zip shaped like one — see the
 * module doc comment above), extracts just enough to show metadata, and
 * persists the raw archive to OPFS for later activation. */
export async function pickAndInstallExtension(): Promise<InstalledExtension> {
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: 'VSIX / ZIP拡張機能', accept: { 'application/zip': ['.vsix', '.zip'] } }],
    excludeAcceptAllOption: false,
    multiple: false,
  });
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { id, metadata } = extractMetadata(bytes);
  await saveArchive(id, bytes);

  const entry: InstalledExtension = { id, installedAt: Date.now(), ...metadata };
  await useExtensionsStore.getState().addExtension(entry);
  return entry;
}

/** Re-derives `description`/`iconDataUrl`/`readme`/`configSchema` for a
 * record persisted before this app started capturing them (installed in
 * an older version) — its raw archive is still sitting in OPFS
 * (`saveArchive` always keeps it, needed for activation anyway), so
 * there's no need to ask the user to reinstall. Returns null if the
 * archive is gone (e.g. OPFS was cleared) or no longer parses; callers
 * should just leave the record as-is in that case. */
export async function backfillMetadataFromArchive(id: string): Promise<ExtractedMetadata | null> {
  try {
    const bytes = await loadArchiveBytes(id);
    return extractMetadata(bytes).metadata;
  } catch {
    return null;
  }
}

export async function uninstallExtension(id: string): Promise<void> {
  const root = await getExtensionsRoot();
  await root.removeEntry(`${id}.zip`).catch(() => {});
  // Defensive cleanup for the case an active extension gets uninstalled
  // without being deactivated first (the UI has no guard against it) —
  // drops any lingering dock panel(s)/cached webview HTML the same way
  // deactivateExtension does.
  useExtensionsStore.getState().clearWebviewHtml(id);
  await useExtensionsStore.getState().removeExtension(id);
}
