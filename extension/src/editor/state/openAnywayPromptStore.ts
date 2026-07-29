import { create } from 'zustand';

interface PendingPrompt {
  fileName: string;
  resolve: (openAnyway: boolean) => void;
}

interface OpenAnywayPromptState {
  pending: PendingPrompt | null;
  /** Shows OpenAnywayModal.tsx (mounted once in App.tsx) and resolves once
   * the user picks キャンセル (false) or Open Anyway (true) — editorTabsStore's
   * openFile() awaits this before deciding whether to actually decode the
   * file as text. Only one prompt at a time by construction (a second
   * openFile() can't even reach this call until the first one's whole
   * loadPromise, prompt included, has settled — see openFile's
   * pendingFileOpens de-dupe). */
  request: (fileName: string) => Promise<boolean>;
  respond: (openAnyway: boolean) => void;
}

export const useOpenAnywayPromptStore = create<OpenAnywayPromptState>((set, get) => ({
  pending: null,
  request: (fileName) => new Promise<boolean>((resolve) => set({ pending: { fileName, resolve } })),
  respond: (openAnyway) => {
    get().pending?.resolve(openAnyway);
    set({ pending: null });
  },
}));
