use serde::{Deserialize, Serialize};

/// Messages sent from the extension to this host over the WebSocket.
/// Mirrored by hand in `extension/src/editor/lsp/lspProtocol.ts` — keep
/// both in sync when changing this file (see docs/lsp_protocol.md).
///
/// Unlike terminal-host's protocol, `Lsp` carries an opaque LSP JSON-RPC
/// payload straight through — this host never parses `method`/`id`/params,
/// it just relays bytes between the WebSocket and the language server's
/// stdio. All LSP semantics (the `initialize` handshake, request/response
/// matching, position conversion) live in the browser.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    OpenSession {
        language: String,
        /// Absolute filesystem path to the project root, if the browser has
        /// one to offer. The File System Access API never exposes a real OS
        /// path for an FSA-opened folder, so this is normally absent and
        /// this host falls back to its own launch directory — but that
        /// fallback is frequently wrong when auto-launched via Native
        /// Messaging (its cwd is then this host's own exe directory, not
        /// the user's project), so the browser lets the user override it
        /// explicitly (see docs/lsp_protocol.md).
        workspace_root: Option<String>,
    },
    Lsp {
        language: String,
        payload: serde_json::Value,
    },
    CloseSession,
}

/// Messages sent from this host back to the extension.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent once per session, right after the language server process is
    /// up (spawned fresh, or an already-running one reused). `root_uri` is
    /// the requested workspace root as a `file://` URI, or this host's launch
    /// directory when no override was supplied.
    Ready { language: String, root_uri: String },
    FetchProgress { downloaded: u64, total: Option<u64> },
    FetchError { message: String },
    Lsp { language: String, payload: serde_json::Value },
    ProcessExited { language: String, code: Option<i32> },
    Error { message: String },
}
