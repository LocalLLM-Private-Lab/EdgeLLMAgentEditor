import * as monaco from 'monaco-editor';
import { useLspStore, getUriForModel } from './lspStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { ensureFileAtPath } from '../copilot/resolveWorkspaceFile';
import { monacoPositionToLsp, lspRangeToMonaco, uriToPathSegments, type LspRange } from './uriTranslation';

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspHover {
  contents: string | { value: string } | Array<string | { value: string }>;
  range?: LspRange;
}

function hoverContentsToString(contents: LspHover['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n');
  }
  return contents.value;
}

/** rust-analyzer's definition location is a `file://` URI, which never
 * matches a Monaco model URI directly (models use the app's own
 * `inmemory://workspace/<tabId>` scheme — see editorTabsStore.ts). If the
 * target file is already open, its model is reused; otherwise the file is
 * resolved through the FSA workspace tree and opened as a new tab first,
 * the same way Copilot's own file-resolution flow does
 * (copilot/resolveWorkspaceFile.ts). Returns null for a location outside
 * the workspace (e.g. Rust standard library source) or if the workspace
 * itself isn't connected. */
async function resolveLocationToMonaco(loc: LspLocation): Promise<{ uri: monaco.Uri; range: monaco.IRange } | null> {
  const rootUri = useLspStore.getState().rootUri;
  if (!rootUri) return null;
  const segments = uriToPathSegments(rootUri, loc.uri);
  if (!segments) return null;

  const tabsState = useEditorTabsStore.getState();
  const existing = tabsState.openFiles.find((f) => f.pathSegments.join('/') === segments.join('/'));
  if (existing) {
    return { uri: existing.model.uri, range: lspRangeToMonaco(loc.range) };
  }

  const rootHandle = useWorkspaceStore.getState().rootHandle;
  if (!rootHandle) return null;
  const node = await ensureFileAtPath(rootHandle, segments.join('/'));
  await tabsState.openFile(node);
  const opened = useEditorTabsStore
    .getState()
    .openFiles.find((f) => f.pathSegments.join('/') === segments.join('/'));
  return opened ? { uri: opened.model.uri, range: lspRangeToMonaco(loc.range) } : null;
}

let registered = false;

/** Registers Monaco definition/hover providers for the 'rust' language id
 * once per extension-page lifetime. Idempotent — safe to call from every
 * mount of MonacoEditorPane. Diagnostics don't need a provider registration;
 * they're pushed by lspStore.ts's publishDiagnostics handler directly via
 * monaco.editor.setModelMarkers as they arrive. */
export function ensureLspProvidersRegistered(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider('rust', {
    provideDefinition: async (model, position) => {
      const uri = getUriForModel(model);
      if (!uri) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] provideDefinition: model has no tracked LSP uri (textDocument/didOpen never sent?)');
        return null;
      }
      let result: unknown;
      try {
        result = await useLspStore.getState().requestDefinition(uri, monacoPositionToLsp(position));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/definition request failed:', err);
        return null;
      }
      if (!result) return null;
      const locations = (Array.isArray(result) ? result : [result]) as LspLocation[];
      const resolved = await Promise.all(
        locations.filter((loc) => loc && typeof loc.uri === 'string').map((loc) => resolveLocationToMonaco(loc)),
      );
      return resolved.filter((r): r is { uri: monaco.Uri; range: monaco.IRange } => r !== null);
    },
  });

  monaco.languages.registerHoverProvider('rust', {
    provideHover: async (model, position) => {
      const uri = getUriForModel(model);
      if (!uri) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] provideHover: model has no tracked LSP uri (textDocument/didOpen never sent?)');
        return null;
      }
      let result: LspHover | null;
      try {
        result = (await useLspStore.getState().requestHover(uri, monacoPositionToLsp(position))) as LspHover | null;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/hover request failed:', err);
        return null;
      }
      if (!result) return null;
      return {
        contents: [{ value: hoverContentsToString(result.contents) }],
        range: result.range ? lspRangeToMonaco(result.range) : undefined,
      };
    },
  });
}
