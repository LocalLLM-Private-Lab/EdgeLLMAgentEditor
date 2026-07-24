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
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  settings: null,
  connectionState: 'disconnected',
  client: null,
  listeners: new Set(),
  pendingRunRequest: null,

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
}));
