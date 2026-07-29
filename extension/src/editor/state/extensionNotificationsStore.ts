import { create } from 'zustand';

export type NotificationLevel = 'info' | 'warn' | 'error';

export interface ExtensionNotification {
  id: string;
  extensionId: string;
  level: NotificationLevel;
  message: string;
}

const AUTO_DISMISS_MS = 6000;

interface ExtensionNotificationsState {
  notifications: ExtensionNotification[];
  /** `vscode.window.show{Information,Warning,Error}Message` lands here
   * (see extensionHostClient.ts's initExtensionHostBridge) — a real
   * user-facing toast, auto-dismissed after a few seconds like VS Code's
   * own notification corner. */
  push: (extensionId: string, level: string, message: string) => void;
  dismiss: (id: string) => void;
}

let counter = 0;

export const useExtensionNotificationsStore = create<ExtensionNotificationsState>((set, get) => ({
  notifications: [],

  push: (extensionId, level, message) => {
    const id = `ext-notif-${Date.now()}-${counter++}`;
    const normalizedLevel: NotificationLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    set((state) => ({
      notifications: [...state.notifications, { id, extensionId, level: normalizedLevel, message }],
    }));
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  },

  dismiss: (id) => {
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
  },
}));
