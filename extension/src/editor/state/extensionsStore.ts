import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { useDockStore } from './dockStore';
import { makeExtensionPanelId } from '../extensions/extensionPanelId';
import { useEditorTabsStore } from './editorTabsStore';
import {
  backfillMetadataFromArchive,
  type CommandContribution,
  type ViewContainerContribution,
  type ViewContribution,
} from '../extensions/vsixInstall';

export type ExtensionActivationStatus =
  | { kind: 'inactive' }
  | { kind: 'activating' }
  | { kind: 'active'; commands: string[] }
  | { kind: 'error'; message: string };

/** One `contributes.configuration.properties` entry from an extension's
 * package.json (VS Code's own configuration schema shape), flattened with
 * its key attached — see vsixInstall.ts's flattenConfigurationSchema. Only
 * the fields ExtensionSettingsModal.tsx actually renders are typed here;
 * the schema can carry more (VS Code has many), everything else is ignored. */
export interface ConfigPropertySchema {
  key: string;
  type?: string | string[];
  enum?: string[];
  enumDescriptions?: string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  items?: { type?: string };
}

export interface InstalledExtension {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description?: string;
  publisher?: string;
  installedAt: number;
  /** Empty when the extension declares no `contributes.configuration` —
   * ExtensionsPanel.tsx only shows a settings button when this is non-empty. */
  configSchema: ConfigPropertySchema[];
  /** `manifest.icon` converted to a data URL at install time (see
   * vsixInstall.ts's extractIcon) — undefined when the manifest declares
   * none, or it couldn't be found/decoded. ExtensionsPanel.tsx/
   * ExtensionDetailView.tsx fall back to a generic icon in that case. */
  iconDataUrl?: string;
  /** The extension's own readme.md, raw markdown text — rendered by
   * ExtensionDetailView.tsx via MarkdownContent.tsx. Undefined if the
   * archive didn't include one. */
  readme?: string;
  /** `manifest.activationEvents`, verbatim — shown as-is on the FEATURES
   * tab (ExtensionDetailView.tsx), same as VS Code's own Marketplace page.
   * This app's shim doesn't actually gate activation on these (see
   * vscode-shim.js) — they're informational only here. */
  activationEvents: string[];
  /** `contributes.commands`, as *declared* in the manifest — distinct from
   * the commands actually observed at runtime (`ExtensionActivationStatus`'s
   * `commands` field), which only exist once the extension has been
   * activated at least once this session. */
  commandContributions: CommandContribution[];
  /** `contributes.viewsContainers.{activitybar,panel}`, flattened. */
  viewContainers: ViewContainerContribution[];
  /** `contributes.views`, keyed by container id (matching the manifest's
   * own shape — VS Code's FEATURES tab groups by container the same way). */
  views: Record<string, ViewContribution[]>;
  /** Persisted per-extension setting (ExtensionDetailView.tsx's checkbox):
   * whether this extension should activate automatically on every app
   * startup (see extensionHostClient.ts's activateAutoStartExtensions),
   * rather than staying inactive until manually enabled each session.
   * Undefined/false is the default — an existing install doesn't suddenly
   * start auto-running just because this feature shipped. */
  autoActivate?: boolean;
}

const STORAGE_KEY = 'installedExtensions';
const CONFIG_VALUES_STORAGE_KEY = 'extensionConfigValues';

interface ExtensionsState {
  extensions: InstalledExtension[];
  loaded: boolean;
  /** Activation status per extension id — deliberately NOT persisted
   * (chrome.storage survives reloads, but a running extension-host process
   * on the terminal-host side does not; every fresh page load starts every
   * installed extension back at 'inactive' until the user activates it
   * again). */
  status: Record<string, ExtensionActivationStatus>;
  /** Latest known HTML per webview, keyed by `${extensionId}:${viewId}` —
   * populated by a listener that's always subscribed from app startup
   * (see extensionHostClient.ts's initExtensionHostBridge), independent of
   * whether the panel showing it is currently mounted. An extension
   * commonly sets `webview.html` synchronously inside `resolveWebviewView`,
   * which runs *during* activate() — before this webview's dock panel
   * (registered the moment its first HTML arrives, see setWebviewHtml)
   * even exists — so without this always-on capture, that first render
   * would just be missed. */
  webviewHtml: Record<string, string>;
  /** Persisted settings overrides, keyed by extensionId -> flat config key
   * -> value (chrome.storage — the source of truth, since the Node
   * extension-host process is thrown away on every deactivate and has no
   * durable storage of its own). Injected into the host process at
   * activation and kept live-synced while active — see
   * extensionHostClient.ts's updateExtensionConfig / initExtensionHostBridge. */
  configValues: Record<string, Record<string, unknown>>;
  configValuesLoaded: boolean;
  /** Set when the extension itself called
   * `executeCommand('workbench.action.openSettings', ...)` (e.g. a
   * "settings" button inside its own webview) — there's no real Settings
   * UI inside the Node host, so this asks the browser to open
   * ExtensionSettingsModal instead. Consumed (and cleared) by
   * ExtensionsPanel.tsx once it opens the modal. */
  openSettingsRequest: string | null;
  /** Which extension's detail page is currently open, as a real tab
   * alongside source-file tabs in whichever editor group it was opened
   * into (`viewingExtensionGroupId`) — VS Code's own "Extension: <name>"
   * tab. Rendered by EditorGroupPane.tsx inside that group's own tab strip
   * and body, not as an app-wide overlay — editorTabsStore's own
   * `EditorTab`/Monaco machinery is untouched since an extension tab needs
   * none of it (no model, no disk I/O, no LSP). */
  viewingExtensionId: string | null;
  /** The editor group whose tab strip/body hosts the extension tab —
   * captured once from editorTabsStore's `focusedGroupId` when the tab is
   * (re)opened, same as a file tab's own `groupId`, so it stays put even
   * if focus later moves to a different group. */
  viewingExtensionGroupId: string | null;
  /** Whether the extension tab is the currently *shown* content in its
   * group (vs. present in the strip but switched away from in favor of a
   * file tab) — EditorGroupPane.tsx clears this (not `viewingExtensionId`)
   * when a file tab in the same group is clicked, so switching back to the
   * extension tab doesn't need to re-fetch/re-open anything. */
  viewingExtensionActive: boolean;
  loadExtensions: () => Promise<void>;
  addExtension: (entry: InstalledExtension) => Promise<void>;
  removeExtension: (id: string) => Promise<void>;
  /** Persists the "起動時に自動的に有効化する" checkbox (ExtensionDetailView.tsx). */
  setAutoActivate: (id: string, autoActivate: boolean) => Promise<void>;
  setStatus: (id: string, status: ExtensionActivationStatus) => void;
  setWebviewHtml: (extensionId: string, viewId: string, html: string) => void;
  /** Removes every recorded webview HTML entry for an extension, and
   * unregisters the matching dockStore panel(s) for each — called on
   * deactivation (extensionHostClient.ts) and uninstall (vsixInstall.ts)
   * so a stale iframe doesn't linger in the dock after the extension host
   * process that was feeding it is gone. */
  clearWebviewHtml: (extensionId: string) => void;
  loadConfigValues: () => Promise<void>;
  setConfigValue: (extensionId: string, key: string, value: unknown) => Promise<void>;
  requestOpenSettings: (extensionId: string) => void;
  clearOpenSettingsRequest: () => void;
  /** Opens `extensionId`'s detail tab, or just re-activates it if it's
   * already open (e.g. clicking its own tab after switching away to a
   * file) — a *different* extension than whatever's currently open
   * re-captures the focused group fresh, same as opening a new file tab
   * would. */
  viewExtension: (extensionId: string) => void;
  /** Switches away from the extension tab in favor of a file tab in the
   * same group, without closing it — it stays in the tab strip, just
   * unselected. No-op if the given group isn't the one hosting it. */
  deactivateExtensionView: (groupId: string) => void;
  /** Closes the extension tab outright (its own × in the tab strip). */
  closeExtensionView: () => void;
}

export const useExtensionsStore = create<ExtensionsState>((set, get) => ({
  extensions: [],
  loaded: false,
  status: {},
  webviewHtml: {},
  configValues: {},
  configValuesLoaded: false,
  openSettingsRequest: null,
  viewingExtensionId: null,
  viewingExtensionGroupId: null,
  viewingExtensionActive: false,

  loadExtensions: async () => {
    const stored = await getStoredValue<InstalledExtension[]>(STORAGE_KEY);
    // Defends against records persisted before these fields existed —
    // without this, an old entry's missing field would crash any code
    // that reads e.g. `.configSchema.length` (ExtensionsPanel.tsx).
    const normalized = (stored ?? []).map((e) => ({
      ...e,
      configSchema: e.configSchema ?? [],
      activationEvents: e.activationEvents ?? [],
      commandContributions: e.commandContributions ?? [],
      viewContainers: e.viewContainers ?? [],
      views: e.views ?? {},
    }));
    set({ extensions: normalized, loaded: true });

    // Records installed before this app started capturing
    // commandContributions (a field no fresh install has ever omitted
    // since it landed) predate one or more of the manifest-derived fields
    // entirely — re-derive all of them from the archive still sitting in
    // OPFS rather than making the user reinstall (see vsixInstall.ts's
    // backfillMetadataFromArchive). Checking this one specific field
    // (rather than e.g. "description is falsy") avoids re-checking a
    // record forever just because that extension genuinely has no
    // description. Runs after the initial render so the UI isn't blocked
    // on it; best-effort (a missing/corrupt archive just leaves that
    // entry as-is).
    const candidates = (stored ?? []).filter((e) => e.commandContributions === undefined);
    for (const candidate of candidates) {
      const metadata = await backfillMetadataFromArchive(candidate.id);
      if (!metadata) continue;
      set((state) => {
        const extensions = state.extensions.map((e) => (e.id === candidate.id ? { ...e, ...metadata } : e));
        void setStoredValue(STORAGE_KEY, extensions);
        return { extensions };
      });
    }
  },

  addExtension: async (entry) => {
    const next = [...get().extensions.filter((e) => e.id !== entry.id), entry];
    await setStoredValue(STORAGE_KEY, next);
    set({ extensions: next });
  },

  setAutoActivate: async (id, autoActivate) => {
    const next = get().extensions.map((e) => (e.id === id ? { ...e, autoActivate } : e));
    await setStoredValue(STORAGE_KEY, next);
    set({ extensions: next });
  },

  removeExtension: async (id) => {
    const next = get().extensions.filter((e) => e.id !== id);
    await setStoredValue(STORAGE_KEY, next);
    set((state) => {
      const status = { ...state.status };
      delete status[id];
      const isViewed = state.viewingExtensionId === id;
      return {
        extensions: next,
        status,
        // Don't leave the detail tab open on an extension that no longer exists.
        viewingExtensionId: isViewed ? null : state.viewingExtensionId,
        viewingExtensionGroupId: isViewed ? null : state.viewingExtensionGroupId,
        viewingExtensionActive: isViewed ? false : state.viewingExtensionActive,
      };
    });
  },

  setStatus: (id, status) => {
    set((state) => ({ status: { ...state.status, [id]: status } }));
  },

  setWebviewHtml: (extensionId, viewId, html) => {
    const key = `${extensionId}:${viewId}`;
    const isNewView = !(key in get().webviewHtml);
    set((state) => ({ webviewHtml: { ...state.webviewHtml, [key]: html } }));
    if (isNewView) {
      // A webview view behaves exactly like Terminal/Copilot/BuildConsole
      // once it exists — dockable, draggable, splittable — so register it
      // the moment it's known to exist, defaulting to the right-hand dock
      // zone (confirmed with the user as the default placement for
      // extension panels).
      useDockStore.getState().registerPanel(makeExtensionPanelId(extensionId, viewId), 'right');
    }
  },

  clearWebviewHtml: (extensionId) => {
    const prefix = `${extensionId}:`;
    set((state) => {
      const webviewHtml = { ...state.webviewHtml };
      for (const key of Object.keys(webviewHtml)) {
        if (!key.startsWith(prefix)) continue;
        delete webviewHtml[key];
        useDockStore.getState().unregisterPanel(makeExtensionPanelId(extensionId, key.slice(prefix.length)));
      }
      return { webviewHtml };
    });
  },

  loadConfigValues: async () => {
    const stored = await getStoredValue<Record<string, Record<string, unknown>>>(CONFIG_VALUES_STORAGE_KEY);
    set({ configValues: stored ?? {}, configValuesLoaded: true });
  },

  setConfigValue: async (extensionId, key, value) => {
    const next = {
      ...get().configValues,
      [extensionId]: { ...get().configValues[extensionId], [key]: value },
    };
    await setStoredValue(CONFIG_VALUES_STORAGE_KEY, next);
    set({ configValues: next });
  },

  requestOpenSettings: (extensionId) => set({ openSettingsRequest: extensionId }),
  clearOpenSettingsRequest: () => set({ openSettingsRequest: null }),

  viewExtension: (extensionId) => {
    if (get().viewingExtensionId === extensionId) {
      // Already open (just switched away to a file tab) — reactivate in
      // place rather than re-capturing the focused group, so clicking the
      // same extension's row again doesn't relocate its tab.
      set({ viewingExtensionActive: true });
      return;
    }
    set({
      viewingExtensionId: extensionId,
      viewingExtensionGroupId: useEditorTabsStore.getState().focusedGroupId,
      viewingExtensionActive: true,
    });
  },

  deactivateExtensionView: (groupId) => {
    if (get().viewingExtensionGroupId !== groupId) return;
    set({ viewingExtensionActive: false });
  },

  closeExtensionView: () =>
    set({ viewingExtensionId: null, viewingExtensionGroupId: null, viewingExtensionActive: false }),
}));
