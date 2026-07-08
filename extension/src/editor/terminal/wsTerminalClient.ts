import type { ClientMessage, ServerMessage } from './terminalProtocol';

export type TerminalConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

const RECONNECT_DELAY_MS = 2000;

interface WsTerminalClientOptions {
  url: string;
  token: string;
  onMessage: (msg: ServerMessage) => void;
  onStateChange: (state: TerminalConnectionState) => void;
}

export class WsTerminalClient {
  private socket: WebSocket | null = null;
  private readonly options: WsTerminalClientOptions;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsTerminalClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.intentionalDisconnect = false;
    this.options.onStateChange('connecting');
    // Browser WebSocket cannot set custom headers, so the shared-secret
    // token travels as a subprotocol instead (see terminal-host/src/auth.rs).
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

  // A dropped connection (terminal-host restarted, transient network
  // hiccup, host wasn't up yet on the first attempt) previously left the
  // client stuck in 'disconnected' forever with no way to recover short of
  // reloading the whole editor tab. Retry on a fixed interval instead,
  // unless the caller asked to disconnect deliberately.
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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
