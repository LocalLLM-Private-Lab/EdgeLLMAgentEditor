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
}
