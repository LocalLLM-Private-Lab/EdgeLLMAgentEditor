// Hand-mirrored from lsp-host/src/protocol.rs — keep both in sync when
// changing this file (see docs/lsp_protocol.md).
//
// `payload` is an opaque LSP JSON-RPC object (request/response/notification)
// — lsp-host never parses it, it's relayed straight through to/from the
// language server's stdio. All LSP semantics live in lspStore.ts.

export type ClientMessage =
  | { type: 'open_session'; language: string; workspace_root?: string }
  | { type: 'lsp'; payload: unknown }
  | { type: 'close_session' };

export type ServerMessage =
  | { type: 'ready'; root_uri: string }
  | { type: 'fetch_progress'; downloaded: number; total: number | null }
  | { type: 'fetch_error'; message: string }
  | { type: 'lsp'; payload: unknown }
  | { type: 'process_exited'; code: number | null }
  | { type: 'error'; message: string };
