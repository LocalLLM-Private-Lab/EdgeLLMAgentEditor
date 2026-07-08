import { create } from 'zustand';
import {
  WsTerminalClient,
  type TerminalConnectionState,
} from '../terminal/wsTerminalClient';
import type { ClientMessage, ServerMessage } from '../terminal/terminalProtocol';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

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
