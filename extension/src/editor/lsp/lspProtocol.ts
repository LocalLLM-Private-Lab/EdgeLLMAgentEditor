// Hand-mirrored from lsp-host/src/protocol.rs — keep both in sync when
// changing this file (see docs/lsp_protocol.md).
//
// `payload` is an opaque LSP JSON-RPC object (request/response/notification)
// — lsp-host never parses it, it's relayed straight through to/from the
// language server's stdio. All LSP semantics live in lspStore.ts.

export type ClientMessage =
  | { type: 'open_session'; language: string; workspace_root?: string }
  | { type: 'lsp'; language: string; payload: unknown }
  | { type: 'restart_session'; language: string }
  | { type: 'close_session' }
  | { type: 'read_file'; id: number; uri: string };

export type ServerMessage =
  | { type: 'ready'; language: string; root_uri: string; python_venv?: string }
  | { type: 'fetch_progress'; downloaded: number; total: number | null }
  | { type: 'install_progress'; language: string; message: string }
  | { type: 'fetch_error'; message: string }
  | { type: 'lsp'; language: string; payload: unknown }
  | { type: 'process_exited'; language: string; code: number | null }
  | { type: 'rust_analyzer_build_scripts_crashed'; language: string }
  | { type: 'error'; message: string }
  | { type: 'file_content'; id: number; content: string | null; error: string | null };
