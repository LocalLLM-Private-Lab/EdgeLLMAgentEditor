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
  | { type: 'close'; session_id: string }
  | {
      type: 'debug_start';
      session_id: string;
      adapter_command: string;
      adapter_args: string[];
      adapter_transport: 'stdio' | 'tcp';
      adapter_port?: number;
      cwd?: string;
    }
  | { type: 'debug_request'; session_id: string; message: Record<string, unknown> }
  | { type: 'debug_stop'; session_id: string }
  | { type: 'debug_ensure_adapter'; request_id: string; language: string }
  | { type: 'ext_host_install'; extension_id: string; archive_base64: string }
  | { type: 'ext_host_activate'; extension_id: string; config: Record<string, unknown>; workspace_root: string | null }
  | { type: 'ext_host_deactivate'; extension_id: string }
  | { type: 'ext_host_config_update'; extension_id: string; key: string; value: unknown }
  | { type: 'ext_host_execute_command'; extension_id: string; command: string; args: unknown }
  | { type: 'ext_host_webview_message'; extension_id: string; view_id: string; message: unknown }
  | { type: 'ext_host_quick_pick_result'; extension_id: string; request_id: string; selected_index: unknown }
  | { type: 'ext_host_webview_visibility_changed'; extension_id: string; view_id: string; visible: boolean };

export type ServerMessage =
  | { type: 'session_opened'; session_id: string; pid: number }
  | { type: 'stdout'; session_id: string; data: string }
  | { type: 'exited'; session_id: string; exit_code: number | null }
  | { type: 'error'; session_id: string | null; message: string }
  | { type: 'debug_started'; session_id: string; pid: number }
  | { type: 'debug_message'; session_id: string; message: Record<string, unknown> }
  | { type: 'debug_output'; session_id: string; data: string }
  | { type: 'debug_exited'; session_id: string; exit_code: number | null }
  | { type: 'debug_error'; session_id: string; message: string }
  | { type: 'debug_adapter_installing'; request_id: string; language: string; message: string }
  | {
      type: 'debug_adapter_ready';
      request_id: string;
      language: string;
      adapter_command: string;
      adapter_args: string[];
      adapter_transport: 'stdio' | 'tcp';
      adapter_port: number | null;
      message: string;
    }
  | { type: 'debug_adapter_error'; request_id: string; language: string; message: string }
  | { type: 'ext_host_installed'; extension_id: string }
  | { type: 'ext_host_activated'; extension_id: string; commands: string[] }
  | { type: 'ext_host_log'; extension_id: string; level: string; message: string }
  | { type: 'ext_host_notification'; extension_id: string; level: string; message: string }
  | { type: 'ext_host_error'; extension_id: string; message: string }
  | { type: 'ext_host_config_changed'; extension_id: string; key: string; value: unknown }
  | { type: 'ext_host_open_settings'; extension_id: string; filter: string | null }
  | { type: 'ext_host_webview_html'; extension_id: string; view_id: string; html: string }
  | { type: 'ext_host_webview_message'; extension_id: string; view_id: string; message: unknown }
  | {
      type: 'ext_host_show_quick_pick';
      extension_id: string;
      request_id: string;
      items: unknown[];
      place_holder: string | null;
      can_pick_many: boolean;
    }
  | { type: 'ext_host_show_webview'; extension_id: string; view_id: string };
