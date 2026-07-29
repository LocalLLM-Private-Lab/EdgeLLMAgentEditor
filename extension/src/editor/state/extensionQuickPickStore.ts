import { create } from 'zustand';

export interface QuickPickItemData {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickRequest {
  extensionId: string;
  requestId: string;
  items: QuickPickItemData[];
  placeHolder: string | null;
  canPickMany: boolean;
}

interface ExtensionQuickPickState {
  /** At most one open at a time — matches VS Code's own quick pick, a
   * singleton overlay slot. A second request arriving while one is
   * pending simply replaces it (the earlier extension's `showQuickPick()`
   * promise is then left unresolved, an accepted edge case for this
   * best-effort shim rather than something worth queuing for). */
  request: QuickPickRequest | null;
  open: (request: QuickPickRequest) => void;
  clear: () => void;
}

export const useExtensionQuickPickStore = create<ExtensionQuickPickState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
