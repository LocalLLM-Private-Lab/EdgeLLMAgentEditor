// Hand-mirrored from terminal-host/src/protocol.rs — keep both in sync
// when changing this file (see docs/protocol.md).

export type ClientMessage =
  | {
      type: 'open_session';
      session_id: string;
      cwd?: string;
      cols: number;
      rows: number;
      shell?: string;
    }
  | { type: 'stdin'; session_id: string; data: string }
  | { type: 'resize'; session_id: string; cols: number; rows: number }
  | { type: 'close'; session_id: string };

export type ServerMessage =
  | { type: 'session_opened'; session_id: string; pid: number }
  | { type: 'stdout'; session_id: string; data: string }
  | { type: 'exited'; session_id: string; exit_code: number | null }
  | { type: 'error'; session_id: string | null; message: string };
