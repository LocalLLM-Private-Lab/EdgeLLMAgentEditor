use axum::{
    Router,
    body::Body,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};

use crate::auth::is_authorized;
use crate::config::HostConfig;
use crate::debug_adapter::{self, DebugSession};
use crate::ext_host::{self, ExtHostProcess};
use crate::protocol::{ClientMessage, ServerMessage};
use crate::pty_session::PtySession;

#[derive(Clone)]
pub struct AppState {
    pub config: HostConfig,
    pub expected_origin: String,
    pub active_connections: Arc<AtomicUsize>,
    /// The port actually bound (main.rs falls back through
    /// `config::PORT_FALLBACKS` if `config.port` is taken) — distinct from
    /// `config.port`, which is only the *preferred* one. Used to build
    /// `http://127.0.0.1:<port>/ext-resource/...` URLs for
    /// `vscode.Webview.asWebviewUri` (see ext_host.rs).
    pub actual_port: u16,
}

// Same pattern as lsp-host (ws_server.rs there) — a plain connection
// counter, checked again after a short grace period once it hits zero.
// terminal-host is a detached background process (survives independently
// of any one browser tab/session, so a page reload doesn't need a fresh
// launch), but that also means nothing else ever stops it once the last
// client is gone for good — without this it just sits there as a zombie
// process that has to be found and `taskkill`'d by hand before the next
// `cargo build` can even overwrite the .exe.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .route(
            "/ext-resource/{extension_id}/{*rel_path}",
            get(serve_ext_resource),
        )
        .with_state(state)
}

pub const HEALTH_RESPONSE: &str = "m365-copilot-editor-terminal-host";

async fn health() -> &'static str {
    HEALTH_RESPONSE
}

fn guess_content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Serves a single extension's own bundled files (icons, webview JS/CSS,
/// ...) over plain HTTP so a sandboxed webview iframe — which cannot load
/// `file://` URLs at all, browsers refuse it outright — can actually fetch
/// them. This is what `vscode.Webview.asWebviewUri` rewrites a `file://`
/// path into (see ext_host.rs's `ExtHostProcess::spawn` and
/// extension-host/vscode-shim.js). Deliberately unauthenticated, matching
/// `/health`: this only ever serves an already-installed extension's own
/// static assets on the loopback interface, nothing workspace- or
/// session-sensitive — but path traversal is still explicitly guarded
/// against below, since `rel_path` is attacker-controlled input.
async fn serve_ext_resource(
    Path((extension_id, rel_path)): Path<(String, String)>,
) -> impl IntoResponse {
    let extension_dir = crate::ext_host::extension_root_dir(&extension_id);
    let requested = extension_dir.join(&rel_path);

    // Canonicalize both sides and check containment — the crate's own
    // sanitize_extension_id already keeps `extension_id` traversal-safe,
    // but `rel_path` is arbitrary attacker-controlled input, so it needs
    // its own check (`..` segments, symlink escapes, etc.).
    let (Ok(canonical_root), Ok(canonical_requested)) = (
        std::fs::canonicalize(&extension_dir),
        std::fs::canonicalize(&requested),
    ) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !canonical_requested.starts_with(&canonical_root) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    match std::fs::read(&canonical_requested) {
        Ok(bytes) => {
            let content_type = guess_content_type(&canonical_requested);
            ([(header::CONTENT_TYPE, content_type)], Body::from(bytes)).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn ws_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_authorized(&headers, &state.expected_origin, &state.config.token) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    // Echo the token back as the selected Sec-WebSocket-Protocol. RFC 6455
    // allows a server to omit this when it offers no subprotocol, but some
    // clients (and possibly some browsers/proxies) treat a client-offered,
    // server-unacknowledged subprotocol as a handshake failure — so select
    // it explicitly rather than relying on the lenient reading of the spec.
    let token = state.config.token.clone();
    let active_connections = state.active_connections.clone();
    let actual_port = state.actual_port;
    active_connections.fetch_add(1, Ordering::AcqRel);
    ws.protocols([token])
        .on_upgrade(move |socket| handle_socket(socket, active_connections, actual_port))
}

async fn handle_socket(socket: WebSocket, active_connections: Arc<AtomicUsize>, actual_port: u16) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Dedicated writer task: every PTY reader thread and the message
    // handler below funnel outgoing frames through `out_tx`, serialized
    // here so only one task ever touches the WebSocket sink.
    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let Ok(json) = serde_json::to_string(&msg) else {
                continue;
            };
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    let mut sessions: HashMap<String, PtySession> = HashMap::new();
    let mut debug_sessions: HashMap<String, DebugSession> = HashMap::new();
    let mut ext_hosts: HashMap<String, ExtHostProcess> = HashMap::new();

    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else { continue };
        let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
        let Ok(client_msg) = parsed else {
            let _ = out_tx.send(ServerMessage::Error {
                session_id: None,
                message: "invalid message".into(),
            });
            continue;
        };

        match client_msg {
            ClientMessage::OpenSession {
                session_id,
                cwd,
                cols,
                rows,
                shell,
            } => {
                match PtySession::spawn(session_id.clone(), cwd, cols, rows, shell, out_tx.clone())
                {
                    Ok((session, pid)) => {
                        sessions.insert(session_id.clone(), session);
                        let _ = out_tx.send(ServerMessage::SessionOpened { session_id, pid });
                    }
                    Err(err) => {
                        let _ = out_tx.send(ServerMessage::Error {
                            session_id: Some(session_id),
                            message: err.to_string(),
                        });
                    }
                }
            }
            ClientMessage::Stdin { session_id, data } => {
                let Ok(bytes) = STANDARD.decode(&data) else {
                    continue;
                };
                if let Some(session) = sessions.get_mut(&session_id)
                    && let Err(err) = session.write_stdin(&bytes)
                {
                    let _ = out_tx.send(ServerMessage::Error {
                        session_id: Some(session_id),
                        message: err.to_string(),
                    });
                }
            }
            ClientMessage::Resize {
                session_id,
                cols,
                rows,
            } => {
                if let Some(session) = sessions.get(&session_id) {
                    let _ = session.resize(cols, rows);
                }
            }
            ClientMessage::Close { session_id } => {
                if let Some(mut session) = sessions.remove(&session_id) {
                    let _ = session.kill();
                }
            }
            ClientMessage::DebugStart {
                session_id,
                adapter_command,
                adapter_args,
                adapter_transport,
                adapter_port,
                cwd,
            } => {
                if let Some(old) = debug_sessions.remove(&session_id) {
                    old.stop();
                }
                match debug_adapter::spawn(
                    adapter_command,
                    adapter_args,
                    adapter_transport,
                    adapter_port,
                    cwd,
                    session_id.clone(),
                    out_tx.clone(),
                ) {
                    Ok((session, pid)) => {
                        debug_sessions.insert(session_id.clone(), session);
                        let _ = out_tx.send(ServerMessage::DebugStarted { session_id, pid });
                    }
                    Err(err) => {
                        let _ = out_tx.send(ServerMessage::DebugError {
                            session_id,
                            message: err.to_string(),
                        });
                    }
                }
            }
            ClientMessage::DebugRequest {
                session_id,
                message,
            } => {
                if let Some(session) = debug_sessions.get(&session_id)
                    && let Err(err) = session.send(message)
                {
                    let _ = out_tx.send(ServerMessage::DebugError {
                        session_id,
                        message: err.to_string(),
                    });
                }
            }
            ClientMessage::DebugStop { session_id } => {
                if let Some(session) = debug_sessions.remove(&session_id) {
                    session.stop();
                }
            }
            ClientMessage::DebugEnsureAdapter {
                request_id,
                language,
            } => {
                let progress_tx = out_tx.clone();
                let progress_language = language.clone();
                let progress_request_id = request_id.clone();
                let _ = progress_tx.send(ServerMessage::DebugAdapterInstalling {
                    request_id: progress_request_id,
                    language: progress_language,
                    message: "DAPアダプターを確認しています...".into(),
                });
                tokio::spawn(async move {
                    match debug_adapter::ensure_adapter(language.clone()).await {
                        Ok(spec) => {
                            let _ = progress_tx.send(ServerMessage::DebugAdapterReady {
                                request_id,
                                language,
                                adapter_command: spec.command,
                                adapter_args: spec.args,
                                adapter_transport: spec.transport,
                                adapter_port: spec.port,
                                message: spec.message,
                            });
                        }
                        Err(err) => {
                            let _ = progress_tx.send(ServerMessage::DebugAdapterError {
                                request_id,
                                language,
                                message: err.to_string(),
                            });
                        }
                    }
                });
            }
            ClientMessage::ExtHostInstall {
                extension_id,
                archive_base64,
            } => match ext_host::install_extension(&extension_id, &archive_base64) {
                Ok(_) => {
                    let _ = out_tx.send(ServerMessage::ExtHostInstalled { extension_id });
                }
                Err(err) => {
                    let _ = out_tx.send(ServerMessage::ExtHostError {
                        extension_id,
                        message: err.to_string(),
                    });
                }
            },
            ClientMessage::ExtHostActivate {
                extension_id,
                config,
                workspace_root,
            } => {
                // Re-activating an already-active extension replaces the
                // old process rather than stacking a second one.
                if let Some(mut old) = ext_hosts.remove(&extension_id) {
                    let _ = old.kill();
                }
                let extension_dir = ext_host::extension_cache_dir(&extension_id);
                if !extension_dir.exists() {
                    let _ = out_tx.send(ServerMessage::ExtHostError {
                        extension_id,
                        message:
                            "拡張機能がインストールされていません(先にインストールしてください)。"
                                .into(),
                    });
                    continue;
                }
                match ExtHostProcess::spawn(
                    extension_id.clone(),
                    extension_dir,
                    actual_port,
                    config,
                    workspace_root,
                    out_tx.clone(),
                ) {
                    Ok(process) => {
                        ext_hosts.insert(extension_id, process);
                    }
                    Err(err) => {
                        let _ = out_tx.send(ServerMessage::ExtHostError {
                            extension_id,
                            message: err.to_string(),
                        });
                    }
                }
            }
            ClientMessage::ExtHostDeactivate { extension_id } => {
                if let Some(mut process) = ext_hosts.remove(&extension_id) {
                    let _ = process.deactivate();
                }
            }
            ClientMessage::ExtHostConfigUpdate {
                extension_id,
                key,
                value,
            } => {
                if let Some(process) = ext_hosts.get_mut(&extension_id) {
                    let _ = process.send_config_update(&key, value);
                }
            }
            ClientMessage::ExtHostExecuteCommand {
                extension_id,
                command,
                args,
            } => {
                if let Some(process) = ext_hosts.get_mut(&extension_id) {
                    let _ = process.execute_command(&command, args);
                }
            }
            ClientMessage::ExtHostQuickPickResult {
                extension_id,
                request_id,
                selected_index,
            } => {
                if let Some(process) = ext_hosts.get_mut(&extension_id) {
                    let _ = process.send_quick_pick_result(&request_id, selected_index);
                }
            }
            ClientMessage::ExtHostWebviewMessage {
                extension_id,
                view_id,
                message,
            } => {
                if let Some(process) = ext_hosts.get_mut(&extension_id) {
                    let _ = process.send_webview_message(&view_id, message);
                }
            }
            ClientMessage::ExtHostWebviewVisibilityChanged {
                extension_id,
                view_id,
                visible,
            } => {
                if let Some(process) = ext_hosts.get_mut(&extension_id) {
                    let _ = process.send_webview_visibility_changed(&view_id, visible);
                }
            }
        }
    }

    // Connection closed: PTY sessions and extension hosts are both
    // connection-scoped, so tear them all down rather than leaving
    // orphaned shells/processes running.
    for (_, mut session) in sessions.drain() {
        let _ = session.kill();
    }
    for (_, session) in debug_sessions.drain() {
        session.stop();
    }
    for (_, mut process) in ext_hosts.drain() {
        let _ = process.kill();
    }
    writer_task.abort();

    if active_connections.fetch_sub(1, Ordering::AcqRel) == 1 {
        tokio::spawn(async move {
            // Allow a quick reconnect (e.g. an editor tab reload) before
            // shutting down the detached host — mirrors lsp-host's same
            // grace-period pattern.
            sleep(SHUTDOWN_GRACE).await;
            if active_connections.load(Ordering::Acquire) == 0 {
                std::process::exit(0);
            }
        });
    }
}
