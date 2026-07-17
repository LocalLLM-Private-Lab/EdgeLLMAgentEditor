import type { ClientMessage, ServerMessage } from './lspProtocol';

export type LspConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

const RECONNECT_DELAY_MS = 2000;

interface LspWsClientOptions {
  url: string;
  token: string;
  onMessage: (msg: ServerMessage) => void;
  onStateChange: (state: LspConnectionState) => void;
}

// Mirrors extension/src/editor/terminal/wsTerminalClient.ts's WsTerminalClient
// exactly (same auth handshake, same reconnect-on-drop behavior) — kept as a
// separate class rather than a shared generic since the two features are
// otherwise unrelated and this keeps each one's protocol import self-contained.
export class LspWsClient {
  private socket: WebSocket | null = null;
  private readonly options: LspWsClientOptions;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LspWsClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.intentionalDisconnect = false;
    this.options.onStateChange('connecting');
    // Browser WebSocket cannot set custom headers, so the shared-secret
    // token travels as a subprotocol instead (see lsp-host/src/auth.rs).
    const socket = new WebSocket(this.options.url, [this.options.token]);
    this.socket = socket;

    socket.addEventListener('open', () => this.options.onStateChange('connected'));
    socket.addEventListener('close', () => {
      this.options.onStateChange('disconnected');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => this.options.onStateChange('error'));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        this.options.onMessage(msg);
      } catch {
        // ignore malformed frames
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }
}
