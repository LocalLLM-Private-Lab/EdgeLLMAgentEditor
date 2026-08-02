import * as monaco from 'monaco-editor';
import { initVimMode, StatusBar as VimStatusBar, VimMode } from 'monaco-vim';
import { EmacsExtension, registerGlobalCommand } from 'monaco-emacs';
import { useKeybindingStore, type KeybindingMode } from '../state/keybindingStore';
import { getKeybindingStatusNode } from './keybindingStatusRegistry';

type Disposable = { dispose: () => void };

class DiffVimStatusBar extends VimStatusBar {
  setMode(event: { mode: string; subMode?: string }) {
    if (event.mode === 'visual') {
      this.setText(event.subMode === 'linewise' ? 'VISUAL LINE' : event.subMode === 'blockwise' ? 'VISUAL BLOCK' : 'VISUAL');
      return;
    }
    this.setText(event.mode.toUpperCase());
  }
}

const VimApi = VimMode as unknown as {
  Vim: { defineEx: (name: string, shorthand: string, callback: () => void) => void };
};

/** Applies the same Vim/Emacs mode selected for the normal editor to one
 * side of a diff editor. The caller owns disposal when the diff is closed or
 * the selected keybinding mode changes. */
export function installDiffEditorKeybindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  mode: KeybindingMode,
  onSave: () => void,
): Disposable {
  const statusNode = getKeybindingStatusNode();
  if (statusNode) {
    statusNode.textContent = '';
    statusNode.style.display = '';
  }

  if (mode === 'vim') {
    const vimAdapter = initVimMode(editor, statusNode, DiffVimStatusBar);
    VimApi.Vim.defineEx('write', 'w', onSave);
    VimApi.Vim.defineEx('wq', 'wq', onSave);
    useKeybindingStore.getState().setVimSubMode('normal');
    (vimAdapter as unknown as { on: (event: string, callback: (event: { mode: string }) => void) => void }).on(
      'vim-mode-change',
      (event) => useKeybindingStore.getState().setVimSubMode(event.mode as 'normal' | 'insert' | 'visual' | 'replace'),
    );
    return {
      dispose: () => {
        vimAdapter.dispose();
        useKeybindingStore.getState().setVimSubMode(null);
      },
    };
  }

  if (mode === 'emacs') {
    const emacsMode = new EmacsExtension(editor);
    const disposables: Disposable[] = [];
    if (statusNode) {
      statusNode.textContent = '';
      disposables.push(emacsMode.onDidChangeKey((value) => (statusNode.textContent = value)));
      disposables.push(emacsMode.onDidMarkChange((markSet) => (statusNode.textContent = markSet ? 'Mark Set!' : '')));
    }
    registerGlobalCommand('C-x C-s', { description: 'Save file', run: onSave });
    emacsMode.start();
    return {
      dispose: () => {
        disposables.forEach((disposable) => disposable.dispose());
        emacsMode.dispose();
      },
    };
  }

  return { dispose: () => undefined };
}
