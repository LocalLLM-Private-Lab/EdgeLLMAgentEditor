import { create } from 'zustand';
import {
  WsTerminalClient,
  type TerminalConnectionState,
} from '../terminal/wsTerminalClient';
import type { ClientMessage, ServerMessage } from '../terminal/terminalProtocol';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';
import { launchTerminalHostViaNativeMessaging } from '../terminal/nativeLaunch';

export interface TerminalHostSettings {
  port: number;
  token: string;
}

const SETTINGS_STORAGE_KEY = 'terminalHostSettings';

/** A command to run in a brand-new, labeled terminal session — unlike
 * `pendingRunRequest` (which types into whatever session is currently
 * active), this always opens a fresh one so the caller can correlate its
 * own output/exit code via the returned session id without any risk of
 * picking up unrelated output the user happens to be typing elsewhere. */
export interface PendingCaptureRun {
  command: string;
  label: string;
  background?: boolean;
  onSessionOpened: (sessionId: string) => void;
}

interface TerminalState {
  settings: TerminalHostSettings | null;
  connectionState: TerminalConnectionState;
  client: WsTerminalClient | null;
  listeners: Set<(msg: ServerMessage) => void>;
  /** A command waiting to run in the active terminal session — set by the
   * header's Run button (App.tsx), consumed by TerminalPanel once it's
   * mounted and connected. Lives here (not runCommandStore, which is just
   * the extension->command-template config) because it's fundamentally
   * "something to do with a terminal session", not a command-template
   * concern. */
  pendingRunRequest: string | null;
  /** One-shot request for a fresh, labeled, capture-friendly session — see
   * `PendingCaptureRun`. Consumed by TerminalPanel exactly like
   * `pendingRunRequest`, just always opening a new session instead of
   * reusing the active one. */
  pendingCaptureRun: PendingCaptureRun | null;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: TerminalHostSettings) => Promise<void>;
  /** Tries to auto-launch (or find the already-running) terminal-host via
   * Native Messaging and connect with the port/token it hands back — no
   * manual "start it yourself and paste the port/token" step, matching
   * lsp-host's flow. Falls back to whatever settings were last saved
   * manually if native messaging isn't available (host not registered
   * yet, or a platform without one) — the manual form stays as a backstop,
   * it just isn't the primary path anymore. */
  ensureConnected: () => Promise<void>;
  connect: () => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  subscribe: (listener: (msg: ServerMessage) => void) => () => void;
  queueRunRequest: (command: string) => void;
  consumePendingRunRequest: () => string | null;
  queueCaptureRun: (
    command: string,
    label: string,
    onSessionOpened: (sessionId: string) => void,
    background?: boolean,
  ) => void;
  consumePendingCaptureRun: () => PendingCaptureRun | null;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  settings: null,
  connectionState: 'disconnected',
  client: null,
  listeners: new Set(),
  pendingRunRequest: null,
  pendingCaptureRun: null,

  loadSettings: async () => {
    const settings = await getStoredValue<TerminalHostSettings>(SETTINGS_STORAGE_KEY);
    if (settings) set({ settings });
  },

  saveSettings: async (settings: TerminalHostSettings) => {
    await setStoredValue(SETTINGS_STORAGE_KEY, settings);
    set({ settings });
  },

  ensureConnected: async () => {
    const result = await launchTerminalHostViaNativeMessaging();
    if (result.status === 'started' || result.status === 'already_running') {
      await get().saveSettings({ port: result.port, token: result.token });
      get().connect();
      return;
    }
    await get().loadSettings();
    if (get().settings) get().connect();
  },

  connect: () => {
    const { settings, client: existing } = get();
    if (!settings) return;
    existing?.disconnect();

    const client = new WsTerminalClient({
      url: `ws://127.0.0.1:${settings.port}/ws`,
      token: settings.token,
      onStateChange: (connectionState) => set({ connectionState }),
      onMessage: (msg) => {
        for (const listener of get().listeners) listener(msg);
      },
    });
    client.connect();
    set({ client });
  },

  disconnect: () => {
    get().client?.disconnect();
    set({ client: null, connectionState: 'disconnected' });
  },

  send: (msg: ClientMessage) => {
    get().client?.send(msg);
  },

  subscribe: (listener: (msg: ServerMessage) => void) => {
    get().listeners.add(listener);
    return () => get().listeners.delete(listener);
  },

  queueRunRequest: (command: string) => set({ pendingRunRequest: command }),

  consumePendingRunRequest: () => {
    const cmd = get().pendingRunRequest;
    set({ pendingRunRequest: null });
    return cmd;
  },

  queueCaptureRun: (command, label, onSessionOpened, background = false) => {
    if (get().pendingCaptureRun) {
      // Two capture-runs queued before the first one's been picked up by
      // TerminalPanel (should only happen within the same render tick,
      // e.g. two triggers firing back-to-back) — last one wins, but warn
      // since the dropped request's caller will otherwise hang forever
      // waiting for a session id that never arrives.
      // eslint-disable-next-line no-console
      console.warn('terminalStore: pendingCaptureRun overwritten before it was consumed');
    }
    set({ pendingCaptureRun: { command, label, onSessionOpened, background } });
  },

  consumePendingCaptureRun: () => {
    const req = get().pendingCaptureRun;
    set({ pendingCaptureRun: null });
    return req;
  },
}));
