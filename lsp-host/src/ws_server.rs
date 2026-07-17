use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::auth::is_authorized;
use crate::config::HostConfig;
use crate::fetch;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::rust_analyzer::RustAnalyzerSession;

#[derive(Clone)]
pub struct AppState {
    pub config: HostConfig,
    pub expected_origin: String,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_authorized(&headers, &state.expected_origin, &state.config.token) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let token = state.config.token.clone();
    ws.protocols([token]).on_upgrade(handle_socket)
}

/// `dir` as a `file:///`-prefixed URI, built with the `url` crate rather
/// than a hand-rolled string (percent-encoding spaces/special characters
/// correctly — a workspace path like `C:\Users\John Doe\project` needs
/// `%20`, not a literal space, to be a valid URI). Windows drive-letter
/// casing may still not byte-match whatever rust-analyzer echoes back in
/// diagnostics/definition responses, which is why the browser side compares
/// URIs case-insensitively rather than assuming exact string identity (see
/// uriTranslation.ts).
fn root_uri(dir: &Path) -> String {
    url::Url::from_file_path(dir)
        .map(|u| u.to_string())
        .unwrap_or_else(|()| {
            let normalized = dir.to_string_lossy().replace('\\', "/");
            format!("file:///{}", normalized.trim_start_matches('/'))
        })
}

/// This host's own launch directory — the same `std::env::current_dir()`
/// convention terminal-host uses for its default PTY cwd (see
/// `pty_session.rs::default_cwd()`). Used only when the browser doesn't send
/// an explicit `workspace_root` override; in practice this rarely matches
/// the user's actual Cargo project when lsp-host was auto-launched via
/// Native Messaging (its cwd is then lsp-host.exe's own directory, not the
/// project folder — there's no browser API that can supply the real one, so
/// the browser has to tell us explicitly instead; see docs/lsp_protocol.md).
fn default_root_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

struct ActiveSession {
    analyzer: RustAnalyzerSession,
    root_dir: PathBuf,
}

async fn ensure_rust_analyzer_session(
    out_tx: mpsc::UnboundedSender<ServerMessage>,
    root_dir: PathBuf,
) -> anyhow::Result<RustAnalyzerSession> {
    let exe_path = if let Some(cached) = fetch::find_cached_exe() {
        cached
    } else {
        let progress_tx = out_tx.clone();
        fetch::ensure_rust_analyzer(move |downloaded, total| {
            let _ = progress_tx.send(ServerMessage::FetchProgress { downloaded, total });
        })
        .await?
    };

    RustAnalyzerSession::spawn(&exe_path, &root_dir, out_tx)
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Dedicated writer task: the fetch-progress reporter and the LSP reader
    // thread (via a std::sync::mpsc-to-tokio bridge inside RustAnalyzerSession)
    // both funnel outgoing frames through `out_tx`, serialized here so only
    // one task ever touches the WebSocket sink — same pattern as
    // terminal-host/src/ws_server.rs.
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

    // Only "rust" is supported today, so a single optional session (rather
    // than terminal-host's HashMap<session_id, _>) is enough. Wrapped in a
    // tokio Mutex (not a plain Option) because OpenSession's fetch step runs
    // in a detached task so it doesn't block this loop from being able to
    // process a CloseSession/disconnect while a download is in flight.
    let session: Arc<Mutex<Option<ActiveSession>>> = Arc::new(Mutex::new(None));

    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else { continue };
        let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
        let Ok(client_msg) = parsed else {
            let _ = out_tx.send(ServerMessage::Error {
                message: "invalid message".into(),
            });
            continue;
        };

        match client_msg {
            ClientMessage::OpenSession {
                language,
                workspace_root,
            } => {
                if language != "rust" {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("unsupported language: {language}"),
                    });
                    continue;
                }

                let requested_root = workspace_root.map(PathBuf::from).unwrap_or_else(default_root_dir);
                if !requested_root.is_dir() {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("フォルダが見つかりません: {}", requested_root.display()),
                    });
                    continue;
                }

                {
                    let mut guard = session.lock().await;
                    if let Some(active) = guard.as_ref() {
                        if active.root_dir == requested_root {
                            let _ = out_tx.send(ServerMessage::Ready {
                                root_uri: root_uri(&active.root_dir),
                            });
                            continue;
                        }
                        // Workspace root changed (e.g. the user corrected it
                        // via the status bar) — the running rust-analyzer is
                        // rooted at the old folder and has to be replaced,
                        // not reused.
                        if let Some(mut old) = guard.take() {
                            let _ = old.analyzer.kill();
                        }
                    }
                }

                let session_slot = session.clone();
                let out_tx2 = out_tx.clone();
                tokio::spawn(async move {
                    match ensure_rust_analyzer_session(out_tx2.clone(), requested_root.clone()).await {
                        Ok(analyzer) => {
                            let root_uri_str = root_uri(&requested_root);
                            *session_slot.lock().await = Some(ActiveSession {
                                analyzer,
                                root_dir: requested_root,
                            });
                            let _ = out_tx2.send(ServerMessage::Ready { root_uri: root_uri_str });
                        }
                        Err(err) => {
                            let _ = out_tx2.send(ServerMessage::FetchError {
                                message: err.to_string(),
                            });
                        }
                    }
                });
            }
            ClientMessage::Lsp { payload } => {
                let guard = session.lock().await;
                if let Some(active) = guard.as_ref()
                    && let Err(err) = active.analyzer.send(&payload)
                {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: err.to_string(),
                    });
                }
            }
            ClientMessage::CloseSession => {
                if let Some(mut active) = session.lock().await.take() {
                    let _ = active.analyzer.kill();
                }
            }
        }
    }

    // Connection closed: the rust-analyzer process is connection-scoped
    // (same lifecycle as terminal-host's PTY sessions) — reconnecting (e.g.
    // reloading the editor tab) respawns it and its analysis index rebuilds.
    if let Some(mut active) = session.lock().await.take() {
        let _ = active.analyzer.kill();
    }
    writer_task.abort();
}
