use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::{BufRead, BufReader, Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

/// Where installed extensions get unzipped to on real disk — fixed,
/// relative to this crate's own source location (see `extension_host_script_path`
/// for why `CARGO_MANIFEST_DIR` rather than the launch cwd), so extension
/// data never lands inside whatever folder the user happens to have open
/// as their workspace.
fn ext_cache_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("ext-cache")
}

/// Where `context.globalState`/`context.workspaceState` actually persist
/// to disk — see vscode-shim.js's `createExtensionContext`. Deliberately a
/// *sibling* of `ext_cache_root()`, never a subdirectory of any single
/// extension's own cache dir: `install_extension` does a full
/// `remove_dir_all` + re-unzip of that dir on every (re)install, which
/// would otherwise silently wipe an extension's saved state (chat
/// history, settings, ...) on a simple update/reinstall — not just on an
/// explicit uninstall, which is the only time real VS Code does that.
fn ext_state_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("ext-state")
}

/// Where one extension's persisted state lives — exposed so `ExtHostProcess::spawn`
/// can hand it to the Node process (see `M365CE_STATE_DIR`).
pub fn extension_state_dir(extension_id: &str) -> PathBuf {
    ext_state_root().join(sanitize_extension_id(extension_id))
}

/// The Node.js launcher script every extension host process runs — see
/// terminal-host/extension-host/index.js. `CARGO_MANIFEST_DIR` is baked in
/// at compile time, so this only works on the machine that built this
/// binary — consistent with the rest of this project (native-messaging
/// manifests are generated per-machine too; nothing here is meant to be
/// copied to a different machine as a standalone binary).
fn extension_host_script_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("extension-host").join("index.js")
}

fn sanitize_extension_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Where a given extension's unzipped files live (or would live) on disk —
/// exposed so `ws_server.rs` can check whether an extension is actually
/// installed before trying to activate it, without duplicating the same
/// sanitize+join logic `install_extension` uses internally.
pub fn extension_cache_dir(extension_id: &str) -> PathBuf {
    ext_cache_root().join(sanitize_extension_id(extension_id))
}

/// The extension's *actual* root — wherever its package.json lives. A real
/// vsix's payload sits under an `extension/` subfolder of the cache dir
/// (vsix-level metadata like extension.vsixmanifest lives alongside it,
/// not inside it); a bare zip with package.json at its own root has no
/// such subfolder. Mirrors extension-host/index.js's `findManifestPath` —
/// both sides need to agree on this, since the browser computes
/// `asWebviewUri`'s relative paths against index.js's answer, and
/// `serve_ext_resource` (ws_server.rs) needs to resolve them against the
/// same base or every webview resource 404s.
pub fn extension_root_dir(extension_id: &str) -> PathBuf {
    let cache_dir = extension_cache_dir(extension_id);
    let nested = cache_dir.join("extension");
    if nested.join("package.json").exists() { nested } else { cache_dir }
}

/// Unzips a base64-encoded archive (vsix or any zip containing a
/// package.json-rooted extension) to this extension's cache directory,
/// replacing whatever was there before. Returns that directory so the
/// caller can hand it to `ExtHostProcess::spawn`.
///
/// `ZipFile::enclosed_name()` is the zip crate's own zip-slip guard — an
/// entry whose path would escape the destination (via `..` or an absolute
/// path) yields `None` and is skipped, so no extra path sanitization is
/// needed on top of it.
pub fn install_extension(extension_id: &str, archive_base64: &str) -> anyhow::Result<PathBuf> {
    let bytes = STANDARD.decode(archive_base64)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;

    let extension_dir = ext_cache_root().join(sanitize_extension_id(extension_id));
    if extension_dir.exists() {
        std::fs::remove_dir_all(&extension_dir)?;
    }
    std::fs::create_dir_all(&extension_dir)?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(relative_path) = entry.enclosed_name() else {
            continue;
        };
        let out_path = extension_dir.join(relative_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out_file = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out_file)?;
    }

    Ok(extension_dir)
}

/// Runs a native file/folder picker (blocking — always called from a
/// throwaway OS thread, never the stdout-reader loop) for
/// `vscode.window.showOpenDialog`. Unlike a browser File System Access
/// picker, this returns real OS paths — required here since the extension
/// writes the result straight into a config value it later reads as a real
/// filesystem path (see local-llm-client's `browseSshKey`/`addRagPath`).
/// Mirrors `lsp-host/src/native_messaging.rs`'s `handle_pick_folder` (same
/// `rfd` crate, same "only ever runs in direct response to an explicit
/// user click" safety property — see that function's doc comment for why
/// a silent/background native dialog is a real footgun).
fn run_open_dialog(options: &serde_json::Value) -> Option<Vec<String>> {
    let title = options.get("title").and_then(|v| v.as_str());
    let default_path = options.get("defaultPath").and_then(|v| v.as_str());
    let can_select_folders = options.get("canSelectFolders").and_then(|v| v.as_bool()).unwrap_or(false);
    let can_select_many = options.get("canSelectMany").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(dir) = default_path {
        dialog = dialog.set_directory(dir);
    }
    if let Some(filters) = options.get("filters").and_then(|v| v.as_object()) {
        for (name, exts) in filters {
            let extensions: Vec<String> = exts
                .as_array()
                .map(|arr| arr.iter().filter_map(|e| e.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if extensions.is_empty() {
                continue;
            }
            let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(name, &ext_refs);
        }
    }

    // `rfd` has no combined files+folders mode (native OS dialogs mostly
    // don't either) — folders win when both are requested, matching this
    // shim's documented limitation (neither of the two real callers in
    // this project asks for both at once).
    let picked: Option<Vec<PathBuf>> = match (can_select_folders, can_select_many) {
        (true, true) => dialog.pick_folders(),
        (true, false) => dialog.pick_folder().map(|p| vec![p]),
        (false, true) => dialog.pick_files(),
        (false, false) => dialog.pick_file().map(|p| vec![p]),
    };

    picked.map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

pub struct ExtHostProcess {
    child: Child,
    /// All writes to the child's stdin (deactivate/webview messages/config
    /// updates/command execs/dialog results) funnel through this channel
    /// to a single dedicated writer thread — see `spawn`'s doc comment for
    /// why (the stdout-reader thread also needs to write back dialog
    /// results, and `ChildStdin` itself isn't `Clone`).
    stdin_tx: Sender<String>,
}

impl ExtHostProcess {
    /// Spawns the Node.js extension-host launcher against a previously
    /// installed (unzipped) extension directory, and wires its stdout/
    /// stderr to `out_tx` as `ServerMessage::ExtHost*` events. Mirrors
    /// `PtySession::spawn`'s shape (reader thread(s) forwarding to the
    /// same outgoing channel every other session type uses), just with
    /// NDJSON framing instead of raw PTY bytes.
    ///
    /// stdin writes are funneled through an `mpsc` channel to a dedicated
    /// writer thread, rather than this struct holding the raw `ChildStdin`
    /// directly: `showOpenDialog` results need to be written back from
    /// *within* the stdout-reader thread (see below), and `ChildStdin`
    /// can't be cloned/shared to make that possible any other way.
    pub fn spawn(
        extension_id: String,
        extension_dir: PathBuf,
        terminal_host_port: u16,
        initial_config: serde_json::Value,
        workspace_root: Option<String>,
        out_tx: UnboundedSender<ServerMessage>,
    ) -> anyhow::Result<Self> {
        let node = which::which("node").or_else(|_| which::which("node.exe")).map_err(|_| {
            anyhow::anyhow!(
                "Node.js が見つかりません。拡張機能を実行するには、あらかじめNode.jsをインストールしてPATHに追加してください。"
            )
        })?;

        // Passed via env var (not a stdin message) so it's available
        // synchronously before activate() runs — a stdin message could
        // arrive too late for extensions that read their config during
        // activation. Base64-encoded to avoid any env-var quoting/escaping
        // issues with arbitrary JSON content on Windows.
        let initial_config_b64 = STANDARD.encode(initial_config.to_string());

        let mut command = Command::new(node);
        command
            .arg(extension_host_script_path())
            .arg(&extension_dir)
            .env("M365CE_EXTENSION_ID", &extension_id)
            .env("M365CE_TERMINAL_HOST_PORT", terminal_host_port.to_string())
            .env("M365CE_INITIAL_CONFIG", initial_config_b64)
            .env("M365CE_STATE_DIR", extension_state_dir(&extension_id))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Without this, `process.cwd()` (and thus vscode-shim.js's
        // `workspace.workspaceFolders`) defaults to *this Rust process's*
        // own cwd — which for the normal Native-Messaging auto-launch flow
        // is terminal-host's own install directory, never the user's real
        // project (see protocol.rs's `ExtHostActivate.workspace_root` doc
        // comment). `None` (workspace never linked yet) leaves the old
        // behavior in place rather than failing the spawn outright.
        if let Some(root) = &workspace_root {
            command.current_dir(root);
        }

        // Without this, spawning node.exe pops up its own visible console
        // window (same fix already applied to lsp-host's language-server
        // spawns — see lsp-host/src/rust_analyzer.rs) since node.exe is a
        // console-subsystem binary and Rust's Command otherwise lets
        // Windows allocate a fresh console for it.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("failed to open extension host stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("failed to open extension host stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("failed to open extension host stderr"))?;

        let (stdin_tx, stdin_rx) = mpsc::channel::<String>();
        {
            // The one and only thread that ever touches the real
            // ChildStdin — every other write path (this struct's own
            // methods, plus the stdout-reader thread below for dialog
            // results) just sends a pre-serialized line into the channel.
            let mut stdin: ChildStdin = stdin;
            std::thread::spawn(move || {
                while let Ok(line) = stdin_rx.recv() {
                    if writeln!(stdin, "{line}").is_err() {
                        break;
                    }
                }
            });
        }

        {
            let out_tx = out_tx.clone();
            let extension_id = extension_id.clone();
            // Cloned so this thread can write a showOpenDialog result back
            // (see the "show_open_dialog" branch below) without touching
            // the raw ChildStdin itself.
            let stdin_tx = stdin_tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    let msg = match value.get("type").and_then(|v| v.as_str()) {
                        Some("activated") => {
                            let commands = value
                                .get("commands")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|c| c.as_str().map(String::from)).collect())
                                .unwrap_or_default();
                            Some(ServerMessage::ExtHostActivated { extension_id: extension_id.clone(), commands })
                        }
                        Some("log") => {
                            let level = value.get("level").and_then(|v| v.as_str()).unwrap_or("info").to_string();
                            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            Some(ServerMessage::ExtHostLog { extension_id: extension_id.clone(), level, message })
                        }
                        Some("notification") => {
                            let level = value.get("level").and_then(|v| v.as_str()).unwrap_or("info").to_string();
                            let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            Some(ServerMessage::ExtHostNotification { extension_id: extension_id.clone(), level, message })
                        }
                        Some("error") => {
                            let message = value
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown error")
                                .to_string();
                            Some(ServerMessage::ExtHostError { extension_id: extension_id.clone(), message })
                        }
                        Some("config_changed") => {
                            let key = value.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let msg_value = value.get("value").cloned().unwrap_or(serde_json::Value::Null);
                            Some(ServerMessage::ExtHostConfigChanged {
                                extension_id: extension_id.clone(),
                                key,
                                value: msg_value,
                            })
                        }
                        Some("open_settings") => {
                            let filter = value.get("filter").and_then(|v| v.as_str()).map(String::from);
                            Some(ServerMessage::ExtHostOpenSettings { extension_id: extension_id.clone(), filter })
                        }
                        Some("show_quick_pick") => {
                            let request_id =
                                value.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let items = value.get("items").cloned().unwrap_or(serde_json::Value::Array(vec![]));
                            let place_holder =
                                value.get("placeHolder").and_then(|v| v.as_str()).map(String::from);
                            let can_pick_many =
                                value.get("canPickMany").and_then(|v| v.as_bool()).unwrap_or(false);
                            Some(ServerMessage::ExtHostShowQuickPick {
                                extension_id: extension_id.clone(),
                                request_id,
                                items,
                                place_holder,
                                can_pick_many,
                            })
                        }
                        Some("show_open_dialog") => {
                            // Handled entirely within terminal-host/Node —
                            // the browser never sees this message type. A
                            // fresh thread runs the (blocking, modal)
                            // native dialog so the stdout-reader loop keeps
                            // flowing for anything else the extension logs
                            // while the dialog is open.
                            let request_id =
                                value.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let options = value.get("options").cloned().unwrap_or(serde_json::Value::Null);
                            let stdin_tx = stdin_tx.clone();
                            std::thread::spawn(move || {
                                let paths = run_open_dialog(&options);
                                let result = serde_json::json!({
                                    "type": "dialog_result",
                                    "request_id": request_id,
                                    "paths": paths,
                                });
                                let _ = stdin_tx.send(result.to_string());
                            });
                            None
                        }
                        Some("webview_html") => {
                            let view_id = value.get("view_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let html = value.get("html").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            Some(ServerMessage::ExtHostWebviewHtml { extension_id: extension_id.clone(), view_id, html })
                        }
                        Some("webview_message") => {
                            let view_id = value.get("view_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let message = value.get("message").cloned().unwrap_or(serde_json::Value::Null);
                            Some(ServerMessage::ExtHostWebviewMessage {
                                extension_id: extension_id.clone(),
                                view_id,
                                message,
                            })
                        }
                        Some("show_webview") => {
                            let view_id = value.get("view_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            Some(ServerMessage::ExtHostShowWebview { extension_id: extension_id.clone(), view_id })
                        }
                        _ => None,
                    };
                    if let Some(msg) = msg {
                        let _ = out_tx.send(msg);
                    }
                }
            });
        }

        // Node crashes before our own try/catch runs (module-load syntax
        // errors, etc.) land on stderr, not the NDJSON stdout channel —
        // surface those as log lines rather than silently dropping them.
        {
            let out_tx = out_tx.clone();
            let extension_id = extension_id.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = out_tx.send(ServerMessage::ExtHostLog {
                        extension_id: extension_id.clone(),
                        level: "error".to_string(),
                        message: line,
                    });
                }
            });
        }

        Ok(Self { child, stdin_tx })
    }

    pub fn deactivate(&mut self) -> anyhow::Result<()> {
        self.stdin_tx.send(serde_json::json!({ "type": "deactivate" }).to_string())?;
        Ok(())
    }

    /// Forwards a message from the webview's own content (browser side, via
    /// the sandbox bridge) down to the extension's `onDidReceiveMessage`.
    pub fn send_webview_message(&mut self, view_id: &str, message: serde_json::Value) -> anyhow::Result<()> {
        self.stdin_tx.send(
            serde_json::json!({ "type": "webview_incoming_message", "view_id": view_id, "message": message })
                .to_string(),
        )?;
        Ok(())
    }

    /// Pushes a browser-driven settings change into the running process —
    /// see vscode-shim.js's `applyExternalConfigUpdate`.
    pub fn send_config_update(&mut self, key: &str, value: serde_json::Value) -> anyhow::Result<()> {
        self.stdin_tx
            .send(serde_json::json!({ "type": "config_update", "key": key, "value": value }).to_string())?;
        Ok(())
    }

    /// Pushes the dock panel's real shown/hidden state into the running
    /// process so `webviewView.visible`/`onDidChangeVisibility` reflect
    /// reality — see vscode-shim.js's `applyWebviewVisibilityChange`.
    pub fn send_webview_visibility_changed(&mut self, view_id: &str, visible: bool) -> anyhow::Result<()> {
        self.stdin_tx.send(
            serde_json::json!({ "type": "webview_visibility_changed", "view_id": view_id, "visible": visible })
                .to_string(),
        )?;
        Ok(())
    }

    /// The user's answer to a `vscode.window.showQuickPick(...)` prompt —
    /// see vscode-shim.js's `resolveQuickPick`.
    pub fn send_quick_pick_result(&mut self, request_id: &str, selected_index: serde_json::Value) -> anyhow::Result<()> {
        self.stdin_tx.send(
            serde_json::json!({ "type": "quick_pick_result", "request_id": request_id, "selected_index": selected_index })
                .to_string(),
        )?;
        Ok(())
    }

    /// A `command:...` link clicked from the browser's settings UI — see
    /// vscode-shim.js's `executeShimCommand`.
    pub fn execute_command(&mut self, command: &str, args: serde_json::Value) -> anyhow::Result<()> {
        self.stdin_tx
            .send(serde_json::json!({ "type": "execute_command", "command": command, "args": args }).to_string())?;
        Ok(())
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        self.child.kill()?;
        Ok(())
    }
}
