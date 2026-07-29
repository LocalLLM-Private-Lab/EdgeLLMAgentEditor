use serde::{Deserialize, Serialize};

/// Messages sent from the extension to this host over the WebSocket.
/// Mirrored by hand in `extension/src/editor/terminal/terminalProtocol.ts` —
/// keep both in sync when changing this file (see docs/protocol.md).
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    OpenSession {
        session_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        shell: Option<String>,
    },
    Stdin {
        session_id: String,
        /// base64-encoded raw bytes — PTY output/input is not guaranteed UTF-8.
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Close {
        session_id: String,
    },
    /// Unpacks a base64-encoded zip (vsix or otherwise) to this host's
    /// on-disk extension cache (`ext-cache/<extension_id>/`). Separate from
    /// `ExtHostActivate` so the browser can install now and activate later
    /// without re-sending the (potentially several-MB) archive.
    ExtHostInstall {
        extension_id: String,
        /// base64-encoded raw zip bytes.
        archive_base64: String,
    },
    /// Spawns a Node.js child process to `require()` the previously-
    /// installed extension's `main` entry point and call `activate()`.
    /// Node itself resolves `package.json`/`main` — this host only knows
    /// the extension id and its own cache directory.
    ExtHostActivate {
        extension_id: String,
        /// Persisted per-extension config overrides (flat key -> value),
        /// injected as the extension host process's initial
        /// `workspace.getConfiguration()` state — see ext_host.rs's
        /// `M365CE_INITIAL_CONFIG` env var. The browser is the source of
        /// truth for these values (chrome.storage), since the Node
        /// process itself is thrown away on every deactivate.
        config: serde_json::Value,
        /// The workspace's real OS path (`workspaceStore.ts`'s
        /// `workspaceRealPath` — same value `open_session`'s `cwd` and
        /// lsp-host's `workspace_root` already use), if known. Set as the
        /// spawned Node process's own cwd (see ext_host.rs's `spawn`) so
        /// `vscode.workspace.workspaceFolders`/`process.cwd()` — and thus
        /// any extension tool that resolves paths against them — sees the
        /// actual project instead of terminal-host's own launch directory
        /// (the same wrong-default class of bug `docs/protocol.md`'s
        /// "cwd(作業フォルダ)の扱い" section already covers for terminals).
        /// `None` when the workspace hasn't been linked yet — falls back
        /// to terminal-host's own cwd, same as before.
        workspace_root: Option<String>,
    },
    ExtHostDeactivate {
        extension_id: String,
    },
    /// A setting was changed from the browser's own settings UI while the
    /// extension is active — pushed live so `onDidChangeConfiguration`
    /// fires inside the running process (e.g. so it can reconnect using
    /// the new value) without requiring a full re-activation.
    ExtHostConfigUpdate {
        extension_id: String,
        key: String,
        value: serde_json::Value,
    },
    /// A `command:...` link clicked from the browser's own settings UI
    /// (see MarkdownDescription.tsx) — asks the running extension host to
    /// run one of its own registered commands. Fire-and-forget: any
    /// resulting UI change (a notification, a config update, ...) arrives
    /// through the existing ExtHost* channels, not a reply to this message.
    ExtHostExecuteCommand {
        extension_id: String,
        command: String,
        args: serde_json::Value,
    },
    /// A message the webview's own content (running inside the sandboxed
    /// iframe bridge — see extension/src/editor/webview-sandbox/) sent via
    /// `acquireVsCodeApi().postMessage(...)`, on its way to the
    /// extension's `webview.onDidReceiveMessage` handler.
    ExtHostWebviewMessage {
        extension_id: String,
        view_id: String,
        message: serde_json::Value,
    },
    /// The user's answer to a `vscode.window.showQuickPick(...)` prompt
    /// (see ExtHostShowQuickPick) — `null`/absent selection means
    /// cancelled, a number is a single-select index, an array of numbers
    /// is a multi-select (`canPickMany`) index list.
    ExtHostQuickPickResult {
        extension_id: String,
        request_id: String,
        selected_index: serde_json::Value,
    },
    /// The dock panel hosting this webview became actually shown/hidden
    /// (see extensionHostClient.ts's dockStore-watching sync) — pushed into
    /// the running process so `webviewView.visible`/`onDidChangeVisibility`
    /// reflect reality instead of the shim's static `visible: true` default.
    ExtHostWebviewVisibilityChanged {
        extension_id: String,
        view_id: String,
        visible: bool,
    },
}

/// Messages sent from this host back to the extension.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    SessionOpened {
        session_id: String,
        pid: u32,
    },
    Stdout {
        session_id: String,
        data: String,
    },
    Exited {
        session_id: String,
        exit_code: Option<i32>,
    },
    Error {
        session_id: Option<String>,
        message: String,
    },
    ExtHostInstalled {
        extension_id: String,
    },
    /// `commands` is whatever `vscode.commands.registerCommand` calls the
    /// shim actually observed during `activate()` — proof the extension
    /// wired itself up, not a promise that any of them fully work (the
    /// vscode API surface behind them is a minimal shim, see vscode-shim.js).
    ExtHostActivated {
        extension_id: String,
        commands: Vec<String>,
    },
    ExtHostLog {
        extension_id: String,
        level: String,
        message: String,
    },
    /// `vscode.window.show{Information,Warning,Error}Message` — a real
    /// user-facing notification, distinct from ExtHostLog (which covers
    /// output-channel appends and internal shim warnings that have no UI
    /// surface). See vscode-shim.js's `notify` helper.
    ExtHostNotification {
        extension_id: String,
        level: String,
        message: String,
    },
    ExtHostError {
        extension_id: String,
        message: String,
    },
    /// The extension itself called `getConfiguration().update(...)` (not a
    /// browser-driven edit — that side already knows what it just set) —
    /// e.g. a "pick a model" command writing its own choice back. Lets the
    /// browser's settings UI (and its chrome.storage persistence) stay in
    /// sync with self-initiated changes.
    ExtHostConfigChanged {
        extension_id: String,
        key: String,
        value: serde_json::Value,
    },
    /// The extension called `executeCommand('workbench.action.openSettings', ...)`
    /// — no real Settings UI exists inside the Node host, so this asks the
    /// browser to open this extension's settings modal instead.
    ExtHostOpenSettings {
        extension_id: String,
        filter: Option<String>,
    },
    /// The extension set `webview.html` — full (re)render.
    ExtHostWebviewHtml {
        extension_id: String,
        view_id: String,
        html: String,
    },
    /// The extension called `webview.postMessage(...)`, bound for the
    /// webview's own content via the sandbox bridge.
    ExtHostWebviewMessage {
        extension_id: String,
        view_id: String,
        message: serde_json::Value,
    },
    /// `vscode.window.showQuickPick(...)` — unlike ExtHostOpenSettings'
    /// native file dialog, a quick pick is VS Code's own in-app overlay
    /// UI, not something the OS provides, so (unlike show_open_dialog)
    /// this one *does* reach the browser — see
    /// ExtensionQuickPick.tsx. `items` is a JSON array of plain
    /// `{label, description?, detail?, ...}` objects (already
    /// JSON-round-trip-safe; the shim keeps the real, possibly richer
    /// original objects on the Node side and only sends back the selected
    /// index — see vscode-shim.js's `showQuickPick`).
    ExtHostShowQuickPick {
        extension_id: String,
        request_id: String,
        items: serde_json::Value,
        place_holder: Option<String>,
        can_pick_many: bool,
    },
    /// The extension called `webviewView.show()` — no real VS Code panel
    /// stack exists here, so this just asks the browser to make that dock
    /// panel visible and active in its zone (see extensionHostClient.ts).
    ExtHostShowWebview {
        extension_id: String,
        view_id: String,
    },
}
