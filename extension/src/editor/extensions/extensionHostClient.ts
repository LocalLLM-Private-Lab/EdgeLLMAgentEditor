import { useTerminalStore } from '../state/terminalStore';
import { bytesToBase64 } from '../terminal/wsTerminalClient';
import { useExtensionsStore } from '../state/extensionsStore';
import { useExtensionNotificationsStore } from '../state/extensionNotificationsStore';
import { useExtensionQuickPickStore } from '../state/extensionQuickPickStore';
import { useDockStore } from '../state/dockStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { makeExtensionPanelId, parseExtensionPanelId } from './extensionPanelId';
import { loadArchiveBytes } from './vsixInstall';

const CONNECT_TIMEOUT_MS = 8000;

/** Waits for an actual `connectionState: 'connected'` transition, not just
 * for `store.ensureConnected()`'s own promise to settle — that promise
 * resolves as soon as it *calls* `connect()`, well before the real
 * WebSocket handshake finishes, so racing it against a timeout and then
 * checking `connectionState` once immediately after used to report "not
 * connected" almost every time terminal-host hadn't already been
 * connected from some earlier, unrelated trigger (e.g. a user's manual
 * click landing long enough after page load for App.tsx's own startup
 * auto-connect to have quietly finished first). That slack disappears for
 * an auto-triggered activation (activateAutoStartExtensions) firing in
 * the very same tick as that startup auto-connect, which is what exposed
 * this — subscribing to the real state change instead of guessing at
 * timing fixes both call sites at once. */
async function ensureConnected(): Promise<boolean> {
  if (useTerminalStore.getState().connectionState === 'connected') return true;
  void useTerminalStore.getState().ensureConnected();
  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      unsubscribe();
      resolve(useTerminalStore.getState().connectionState === 'connected');
    }, CONNECT_TIMEOUT_MS);
    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (state.connectionState !== 'connected') return;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve(true);
    });
  });
}

/** Whether a dock panel is actually *shown* right now — not just "not
 * explicitly hidden", but the one thing on screen: for a zone shared as
 * tabs (not a split), a panel sitting behind another active tab is
 * `visible: true` in dockStore's own bookkeeping (it stays that way so
 * re-selecting its tab doesn't need special-casing) but isn't what the
 * user actually sees. This is what an extension's `webviewView.visible`
 * needs to mean instead — see syncExtensionWebviewVisibility below. */
function isDockPanelActuallyVisible(panelId: string): boolean {
  const dock = useDockStore.getState();
  const placement = dock.panels[panelId];
  if (!placement?.visible) return false;
  const split = dock.splitByZone[placement.zone];
  if (split?.order.includes(panelId)) return true;
  return dock.activeByZone[placement.zone] === panelId;
}

/** Last visibility sent per dock panel id, so a dockStore change that
 * doesn't actually flip any extension webview's shown/hidden state
 * doesn't spam a redundant message down to its (possibly nonexistent,
 * possibly inactive) extension host process. */
const lastKnownWebviewVisibility = new Map<string, boolean>();

/** Pushes real dock-visibility changes down to every *active* extension's
 * webview(s) — see vscode-shim.js's `applyWebviewVisibilityChange`. Called
 * (a) on every dockStore change (module-scope subscribe below) and (b)
 * once right after an extension activates, since its process starts with
 * the shim's static `visible: true` default that may already be wrong by
 * the time it's ready (e.g. activated while its panel is hidden behind
 * another tab). */
function syncExtensionWebviewVisibility(): void {
  for (const panelId of Object.keys(useDockStore.getState().panels)) {
    const parsed = parseExtensionPanelId(panelId);
    if (!parsed) continue;
    if (useExtensionsStore.getState().status[parsed.extensionId]?.kind !== 'active') continue;
    const visible = isDockPanelActuallyVisible(panelId);
    if (lastKnownWebviewVisibility.get(panelId) === visible) continue;
    lastKnownWebviewVisibility.set(panelId, visible);
    useTerminalStore.getState().send({
      type: 'ext_host_webview_visibility_changed',
      extension_id: parsed.extensionId,
      view_id: parsed.viewId,
      visible,
    });
  }
}

useDockStore.subscribe(syncExtensionWebviewVisibility);

/** Sends the extension's archive (reloaded from OPFS — see vsixInstall.ts)
 * to terminal-host for on-disk extraction, then requests activation once
 * that's acked. Resolves once activation succeeds or fails; the outcome
 * itself is reported through extensionsStore's `status`, not the return
 * value, so any UI subscribed to that store updates live regardless of
 * who triggered the activation. */
export async function activateExtension(id: string): Promise<void> {
  const { setStatus } = useExtensionsStore.getState();
  setStatus(id, { kind: 'activating' });

  if (!(await ensureConnected())) {
    setStatus(id, { kind: 'error', message: 'terminal-hostに接続できませんでした。' });
    return;
  }

  let archiveBase64: string;
  try {
    archiveBase64 = bytesToBase64(await loadArchiveBytes(id));
  } catch (err) {
    setStatus(id, { kind: 'error', message: `保存済みの拡張機能を読み込めませんでした: ${String(err)}` });
    return;
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = useTerminalStore.getState().subscribe((msg) => {
      if (!('extension_id' in msg) || msg.extension_id !== id) return;
      if (msg.type === 'ext_host_installed') {
        // Persisted settings overrides (chrome.storage — see
        // extensionsStore.ts's configValues) are injected as this run's
        // starting `workspace.getConfiguration()` state, so an extension
        // that reads its config during activate() itself already sees
        // the user's saved values, not just the schema defaults.
        useTerminalStore.getState().send({
          type: 'ext_host_activate',
          extension_id: id,
          config: useExtensionsStore.getState().configValues[id] ?? {},
          // Spawns the Node extension-host process with this as its cwd
          // (see ext_host.rs's spawn) so `vscode.workspace.workspaceFolders`
          // — and thus any extension tool that resolves paths against it,
          // e.g. a coding-agent's read_file/write_file/edit_file — sees the
          // actual project instead of terminal-host's own launch directory.
          // Same value terminal cwd/lsp-host's workspace_root already use;
          // null until the workspace has been linked once (see
          // WorkspacePathBanner.tsx) — falls back to the old (wrong-by-
          // default) behavior in that case, same as before this existed.
          workspace_root: useWorkspaceStore.getState().workspaceRealPath,
        });
      } else if (msg.type === 'ext_host_activated') {
        setStatus(id, { kind: 'active', commands: msg.commands });
        // The freshly-spawned process starts with the shim's static
        // `visible: true` default — correct it immediately in case its
        // panel is actually hidden/behind another tab by now (its
        // `webview_html` message, and thus dockStore's registerPanel call,
        // has already been processed by this point — see setWebviewHtml).
        syncExtensionWebviewVisibility();
        unsubscribe();
        resolve();
      } else if (msg.type === 'ext_host_error') {
        setStatus(id, { kind: 'error', message: msg.message });
        unsubscribe();
        resolve();
      }
      // ext_host_log: no dedicated UI slot yet — visible in terminal-host's
      // own console output in the meantime.
    });

    useTerminalStore.getState().send({ type: 'ext_host_install', extension_id: id, archive_base64: archiveBase64 });
  });
}

/** Activates every installed extension with its "起動時に自動的に有効化する"
 * setting on (`InstalledExtension.autoActivate` — see
 * ExtensionDetailView.tsx's checkbox) — called once from App.tsx's startup
 * effect, unconditionally (not gated behind ever opening the Extensions
 * panel, unlike ExtensionsPanel.tsx's own `loadExtensions()` call). Every
 * other extension stays inactive with no dock panel until manually
 * enabled, matching the "最初は無効で表示もなし" half of that same setting's
 * two states — loadExtensions() itself already drops any stale ext: dock
 * panel left over from a past session, so an extension that *isn't*
 * auto-starting never shows so much as an empty panel. */
export async function activateAutoStartExtensions(): Promise<void> {
  await useExtensionsStore.getState().loadExtensions();
  const toActivate = useExtensionsStore.getState().extensions.filter((e) => e.autoActivate);
  for (const ext of toActivate) {
    void activateExtension(ext.id);
  }
}

const FILE_TREE_POLL_INTERVAL_MS = 2000;

/** A coding-agent extension (e.g. local-llm-client) commonly writes files
 * via plain Node `fs` rather than `vscode.workspace.fs`, so its changes
 * never go through any create/write call this app's own workspaceStore.ts
 * makes — the file tree has no way to notice them on its own. Chromium
 * doesn't yet expose a broadly-available "watch this real directory for
 * external changes" API (`FileSystemObserver` isn't in this build), so
 * this polls workspaceStore's `refreshTree` periodically while at least
 * one extension is actually active (skipped entirely when idle, so a
 * workspace with no extensions running costs nothing extra), plus once on
 * window focus for the case an extension went idle again before the user
 * switched back. Called once from App.tsx's startup effect. */
export function startFileTreeAutoRefresh(): void {
  window.addEventListener('focus', () => {
    void useWorkspaceStore.getState().refreshTree();
  });

  setInterval(() => {
    const anyExtensionActive = Object.values(useExtensionsStore.getState().status).some((s) => s.kind === 'active');
    if (!anyExtensionActive) return;
    void useWorkspaceStore.getState().refreshTree();
  }, FILE_TREE_POLL_INTERVAL_MS);
}

/** Persists a settings edit (chrome.storage, via extensionsStore) and, if
 * the extension is currently active, pushes it live into the running host
 * process too so `onDidChangeConfiguration` fires there immediately
 * (rather than only taking effect on the next activation). Called from
 * ExtensionSettingsModal.tsx. */
export async function updateExtensionConfig(extensionId: string, key: string, value: unknown): Promise<void> {
  await useExtensionsStore.getState().setConfigValue(extensionId, key, value);
  const status = useExtensionsStore.getState().status[extensionId];
  if (status?.kind === 'active') {
    useTerminalStore.getState().send({ type: 'ext_host_config_update', extension_id: extensionId, key, value });
  }
}

/** Runs one of an active extension's own registered commands from the
 * browser — used by MarkdownDescription.tsx's `command:...` link handling.
 * Fire-and-forget: whatever the command does (show a notification, update
 * a config value, ...) arrives back through the existing ExtHost*
 * channels, not a reply to this message. */
export function executeExtensionCommand(extensionId: string, command: string, args: unknown): void {
  useTerminalStore.getState().send({ type: 'ext_host_execute_command', extension_id: extensionId, command, args });
}

/** The user answered a `vscode.window.showQuickPick(...)` prompt (see
 * ExtensionQuickPick.tsx) — `selectedIndex` is `null` for cancelled, a
 * single index, or an array of indices for a `canPickMany` pick. */
export function resolveExtensionQuickPick(
  extensionId: string,
  requestId: string,
  selectedIndex: number | number[] | null,
): void {
  useTerminalStore.getState().send({
    type: 'ext_host_quick_pick_result',
    extension_id: extensionId,
    request_id: requestId,
    selected_index: selectedIndex,
  });
  useExtensionQuickPickStore.getState().clear();
}

export function deactivateExtension(id: string): void {
  useTerminalStore.getState().send({ type: 'ext_host_deactivate', extension_id: id });
  useExtensionsStore.getState().setStatus(id, { kind: 'inactive' });
  // The extension host process feeding these webviews is gone — drop their
  // dock panels along with the cached HTML, rather than leaving a dead
  // iframe sitting in the layout until the extension is reactivated.
  useExtensionsStore.getState().clearWebviewHtml(id);
  // A future reactivation's freshly-spawned process starts from the shim's
  // own `visible: true` default again — without dropping these cached
  // entries, syncExtensionWebviewVisibility could wrongly skip sending its
  // real initial state (thinking nothing changed from before this deactivation).
  for (const panelId of lastKnownWebviewVisibility.keys()) {
    if (parseExtensionPanelId(panelId)?.extensionId === id) lastKnownWebviewVisibility.delete(panelId);
  }
}

/** Captures every `ext_host_webview_html` into extensionsStore regardless
 * of whether WebviewHost is currently mounted — an extension commonly
 * sets `webview.html` synchronously inside `resolveWebviewView`, which
 * runs *during* activate(), before the 'active' status (and thus
 * WebviewHost's mount) exists yet. Also forwards `ext_host_notification`
 * (vscode.window.show*Message) into extensionNotificationsStore, whose
 * toast UI (ExtensionNotifications.tsx) is always mounted regardless of
 * which panel/view is currently visible; `ext_host_config_changed`
 * (the extension updated its own setting) into extensionsStore's
 * persisted configValues; and `ext_host_open_settings`
 * (`workbench.action.openSettings` called from inside the extension) into
 * a request ExtensionsPanel.tsx picks up to open ExtensionSettingsModal;
 * and `ext_host_show_quick_pick` (`vscode.window.showQuickPick`) into
 * extensionQuickPickStore, rendered by the always-mounted
 * ExtensionQuickPick.tsx. Called once from App.tsx's startup effect, same
 * pattern as the other one-time store initializers there. */
export function initExtensionHostBridge(): void {
  useTerminalStore.getState().subscribe((msg) => {
    if (msg.type === 'ext_host_webview_html') {
      useExtensionsStore.getState().setWebviewHtml(msg.extension_id, msg.view_id, msg.html);
    } else if (msg.type === 'ext_host_notification') {
      useExtensionNotificationsStore.getState().push(msg.extension_id, msg.level, msg.message);
    } else if (msg.type === 'ext_host_config_changed') {
      // The extension changed its own setting (e.g. a "pick a model"
      // command) — keep the browser's persisted copy/settings UI in sync.
      void useExtensionsStore.getState().setConfigValue(msg.extension_id, msg.key, msg.value);
    } else if (msg.type === 'ext_host_open_settings') {
      useExtensionsStore.getState().requestOpenSettings(msg.extension_id);
    } else if (msg.type === 'ext_host_show_quick_pick') {
      useExtensionQuickPickStore.getState().open({
        extensionId: msg.extension_id,
        requestId: msg.request_id,
        items: msg.items as { label: string; description?: string; detail?: string }[],
        placeHolder: msg.place_holder,
        canPickMany: msg.can_pick_many,
      });
    } else if (msg.type === 'ext_host_show_webview') {
      // The extension called webviewView.show()/webviewPanel.reveal() —
      // there's no real panel stack to reveal into here, so just make its
      // dock panel the shown one in its zone (setVisible already sets
      // activeByZone, so this also wins any tab it was sharing a zone with).
      const panelId = makeExtensionPanelId(msg.extension_id, msg.view_id);
      if (useDockStore.getState().panels[panelId]) {
        useDockStore.getState().setVisible(panelId, true);
      }
    }
  });
}
