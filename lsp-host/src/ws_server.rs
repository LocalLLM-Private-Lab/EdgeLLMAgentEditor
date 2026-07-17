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
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::auth::is_authorized;
use crate::config::HostConfig;
use crate::fetch;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::rust_analyzer::LanguageServerSession;

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
/// `%20`, not a literal space). Windows drive-letter casing may still not
/// byte-match server responses; the browser compares URI keys
/// case-insensitively for that reason.
fn root_uri(dir: &Path) -> String {
    url::Url::from_file_path(dir)
        .map(|u| u.to_string())
        .unwrap_or_else(|()| {
            let normalized = dir.to_string_lossy().replace('\\', "/");
            format!("file:///{}", normalized.trim_start_matches('/'))
        })
}

fn default_root_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

struct ActiveSession {
    server: LanguageServerSession,
    root_dir: PathBuf,
}

/// Returns the external executable candidates for a language. The `.cmd`
/// variants are important on Windows because npm global binaries are command
/// files rather than native executables; `resolve_program` handles them via
/// cmd.exe after locating them on PATH.
fn external_server_candidates(language: &str) -> Vec<(&'static str, Vec<&'static str>)> {
    match language {
        "c" | "cpp" => vec![("clangd", vec![])],
        "python" => vec![
            ("pyright-langserver", vec!["--stdio"]),
            ("pylsp", vec![]),
        ],
        "ruby" => vec![
            ("solargraph", vec!["stdio"]),
            ("ruby-lsp", vec![]),
        ],
        "html" => vec![("vscode-html-language-server", vec!["--stdio"])],
        "css" => vec![("vscode-css-language-server", vec!["--stdio"])],
        "javascript" | "typescript" => vec![("typescript-language-server", vec!["--stdio"])],
        _ => vec![],
    }
}

fn resolve_program(program: &str) -> anyhow::Result<PathBuf> {
    let lookup = if cfg!(windows) { "where.exe" } else { "which" };
    let output = Command::new(lookup).arg(program).output()?;
    if !output.status.success() {
        anyhow::bail!("executable not found on PATH: {program}");
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| anyhow::anyhow!("executable not found on PATH: {program}"))?;
    Ok(PathBuf::from(path))
}

fn spawn_external_server(
    program: &str,
    args: &[&str],
    root_dir: &Path,
    language: &str,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
) -> anyhow::Result<LanguageServerSession> {
    let resolved = resolve_program(program)?;
    let is_cmd = resolved
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));

    if !is_cmd {
        return LanguageServerSession::spawn(&resolved, args, root_dir, language, out_tx);
    }

    // Command files need a shell on Windows. The arguments used by the
    // supported language servers are fixed, so a single quoted command line
    // is sufficient and avoids passing an arbitrary user string to cmd.exe.
    let mut command_line = format!("\"{}\"", resolved.display());
    if !args.is_empty() {
        command_line.push(' ');
        command_line.push_str(&args.join(" "));
    }
    let shell_args = ["/d", "/s", "/c", command_line.as_str()];
    LanguageServerSession::spawn(
        Path::new("cmd.exe"),
        &shell_args,
        root_dir,
        language,
        out_tx,
    )
}

async fn ensure_language_server_session(
    out_tx: mpsc::UnboundedSender<ServerMessage>,
    root_dir: PathBuf,
    language: &str,
) -> anyhow::Result<LanguageServerSession> {
    if language == "rust" {
        let exe_path = if let Some(cached) = fetch::find_cached_exe() {
            cached
        } else {
            let progress_tx = out_tx.clone();
            fetch::ensure_rust_analyzer(move |downloaded, total| {
                let _ = progress_tx.send(ServerMessage::FetchProgress { downloaded, total });
            })
            .await?
        };
        return LanguageServerSession::spawn(&exe_path, &[], &root_dir, language, out_tx);
    }

    let candidates = external_server_candidates(language);
    if candidates.is_empty() {
        anyhow::bail!("unsupported language: {language}");
    }
    let mut errors = Vec::new();
    for (program, args) in candidates {
        match spawn_external_server(program, &args, &root_dir, language, out_tx.clone()) {
            Ok(server) => return Ok(server),
            Err(err) => errors.push(format!("{program}: {err}")),
        }
    }
    anyhow::bail!(
        "No language server found for {language}. Install one of the supported servers and ensure it is on PATH. {}",
        errors.join("; ")
    )
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();

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

    // One WebSocket now multiplexes one language server per language. This
    // lets a project keep Rust, Python, C++ and web files open at once while
    // preserving the opaque LSP JSON-RPC payload design.
    let sessions: Arc<Mutex<HashMap<String, ActiveSession>>> = Arc::new(Mutex::new(HashMap::new()));

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
                if language != "rust" && external_server_candidates(&language).is_empty() {
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
                    let mut guard = sessions.lock().await;
                    if let Some(active) = guard.get(&language)
                        && active.root_dir == requested_root
                    {
                        let _ = out_tx.send(ServerMessage::Ready {
                            language,
                            root_uri: root_uri(&active.root_dir),
                        });
                        continue;
                    }

                    // All language sessions share one workspace root. If the
                    // root changes, restart every server so their indexes and
                    // file URIs stay consistent.
                    if guard.values().any(|active| active.root_dir != requested_root) {
                        for (_, mut active) in guard.drain() {
                            let _ = active.server.kill();
                        }
                    }
                }

                let session_slot = sessions.clone();
                let out_tx2 = out_tx.clone();
                let language_for_task = language.clone();
                tokio::spawn(async move {
                    match ensure_language_server_session(
                        out_tx2.clone(),
                        requested_root.clone(),
                        &language_for_task,
                    )
                    .await
                    {
                        Ok(server) => {
                            let root_uri_str = root_uri(&requested_root);
                            session_slot.lock().await.insert(
                                language_for_task.clone(),
                                ActiveSession {
                                    server,
                                    root_dir: requested_root,
                                },
                            );
                            let _ = out_tx2.send(ServerMessage::Ready {
                                language: language_for_task,
                                root_uri: root_uri_str,
                            });
                        }
                        Err(err) => {
                            let _ = out_tx2.send(ServerMessage::FetchError {
                                message: err.to_string(),
                            });
                        }
                    }
                });
            }
            ClientMessage::Lsp { language, payload } => {
                let guard = sessions.lock().await;
                if let Some(active) = guard.get(&language) {
                    if let Err(err) = active.server.send(&payload) {
                        let _ = out_tx.send(ServerMessage::Error {
                            message: err.to_string(),
                        });
                    }
                } else {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("LSP session is not ready for language: {language}"),
                    });
                }
            }
            ClientMessage::CloseSession => {
                for (_, mut active) in sessions.lock().await.drain() {
                    let _ = active.server.kill();
                }
            }
        }
    }

    for (_, mut active) in sessions.lock().await.drain() {
        let _ = active.server.kill();
    }
    writer_task.abort();
}
