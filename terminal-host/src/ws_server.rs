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
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::auth::is_authorized;
use crate::config::HostConfig;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::pty_session::PtySession;

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
    // Echo the token back as the selected Sec-WebSocket-Protocol. RFC 6455
    // allows a server to omit this when it offers no subprotocol, but some
    // clients (and possibly some browsers/proxies) treat a client-offered,
    // server-unacknowledged subprotocol as a handshake failure — so select
    // it explicitly rather than relying on the lenient reading of the spec.
    let token = state.config.token.clone();
    ws.protocols([token]).on_upgrade(move |socket| handle_socket(socket))
}

async fn handle_socket(socket: WebSocket) {
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
                } => match PtySession::spawn(session_id.clone(), cwd, cols, rows, shell, out_tx.clone()) {
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
                },
                ClientMessage::Stdin { session_id, data } => {
                    let Ok(bytes) = STANDARD.decode(&data) else {
                        continue;
                    };
                    if let Some(session) = sessions.get_mut(&session_id) {
                        if let Err(err) = session.write_stdin(&bytes) {
                            let _ = out_tx.send(ServerMessage::Error {
                                session_id: Some(session_id),
                                message: err.to_string(),
                            });
                        }
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
            }
    }

    // Connection closed: PTY sessions are connection-scoped, so tear them
    // all down rather than leaving orphaned shells running.
    for (_, mut session) in sessions.drain() {
        let _ = session.kill();
    }
    writer_task.abort();
}
