import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

export type KeybindingMode = 'default' | 'vim' | 'emacs';
export type VimSubMode = 'normal' | 'insert' | 'visual' | 'replace';

const STORAGE_KEY = 'editorKeybindingMode';

interface KeybindingState {
  mode: KeybindingMode;
  /** Current vim editing mode (normal/insert/visual/replace), mirrored here
   * from monaco-vim's 'vim-mode-change' event (MonacoEditorPane.tsx) so
   * other components — e.g. the status bar's encoding/EOL badges — can
   * color themselves to match, not just monaco-vim's own status text. Null
   * outside vim mode. */
  vimSubMode: VimSubMode | null;
  loadMode: () => Promise<void>;
  setMode: (mode: KeybindingMode) => Promise<void>;
  setVimSubMode: (subMode: VimSubMode | null) => void;
}

export const useKeybindingStore = create<KeybindingState>((set) => ({
  mode: 'default',
  vimSubMode: null,

  loadMode: async () => {
    const mode = await getStoredValue<KeybindingMode>(STORAGE_KEY);
    if (mode) set({ mode });
  },

  setMode: async (mode: KeybindingMode) => {
    await setStoredValue(STORAGE_KEY, mode);
    set({ mode });
  },

  setVimSubMode: (subMode: VimSubMode | null) => set({ vimSubMode: subMode }),
}));
