import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import { initVimMode, VimMode, StatusBar as VimStatusBar } from 'monaco-vim';
import { EmacsExtension, registerGlobalCommand } from 'monaco-emacs';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useKeybindingStore, type VimSubMode } from '../state/keybindingStore';
import { setupMonacoEnvironment } from '../monaco/setupMonacoEnvironment';
import { setActiveEditor } from '../monaco/editorInstanceRegistry';
import { getKeybindingStatusNode } from '../monaco/keybindingStatusRegistry';
import { ensureLspProvidersRegistered } from '../lsp/lspProviders';

setupMonacoEnvironment();
ensureLspProvidersRegistered();

type KeybindingBinding = { dispose: () => void };

// `VimMode.Vim` (CodeMirror's Vim singleton, used for `defineEx`) is
// attached at runtime (`CMAdapter.Vim = Vim()`) but not present in
// monaco-vim's published .d.ts.
const VimApi = VimMode as unknown as { Vim: { defineEx: (name: string, shorthand: string, fn: () => void) => void } };

// monaco-vim's default status text is the classic vi "--INSERT--" form,
// meant for a plain-text command line — doesn't suit a colored badge.
// setText/setMode are the only public members, so override setMode to
// reuse the label without vi's dashes.
class BadgeVimStatusBar extends VimStatusBar {
  setMode(ev: { mode: string; subMode?: string }) {
    if (ev.mode === 'visual') {
      const label =
        ev.subMode === 'linewise' ? 'VISUAL LINE' : ev.subMode === 'blockwise' ? 'VISUAL BLOCK' : 'VISUAL';
      this.setText(label);
      return;
    }
    this.setText(ev.mode.toUpperCase());
  }
}

export function MonacoEditorPane() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeBindingRef = useRef<KeybindingBinding | null>(null);

  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const saveFile = useEditorTabsStore((s) => s.saveFile);
  const keybindingMode = useKeybindingStore((s) => s.mode);

  useEffect(() => {
    if (!containerRef.current) return;
    // 'dark-plus' isn't registered until the first ensureLanguageTokenization
    // (fired from openFile) runs shikiToMonaco — before that, an unknown
    // theme name would silently fall back to Monaco's *light* default. Start
    // dark and let shikiToMonaco upgrade to 'dark-plus' once it's ready.
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      theme: 'vs-dark',
      fontSize: 13,
      minimap: { enabled: true },
    });
    editorRef.current = editor;
    setActiveEditor(editor);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const id = useEditorTabsStore.getState().activeFileId;
      if (id) void saveFile(id);
    });

    // editor.action.toggleWordWrap isn't registered in this Monaco build,
    // and Alt+Z isn't one of the standalone editor's default keybindings
    // (unlike full VS Code) — bind it directly, same as the View menu item.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
      const current = editor.getRawOptions().wordWrap;
      editor.updateOptions({ wordWrap: current === 'on' ? 'off' : 'on' });
    });

    return () => {
      setActiveEditor(null);
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const activeTab = openFiles.find((f) => f.id === activeFileId);
    editor.setModel(activeTab ? activeTab.model : null);
  }, [activeFileId, openFiles]);

  // Applies the selected vim/emacs input-intercept layer on top of the
  // editor instance. This is separate from (and doesn't touch) the Ctrl+S /
  // Alt+Z monaco commands registered above — in 'default' mode this effect
  // is a no-op, so default-mode behavior is unchanged by construction.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    activeBindingRef.current?.dispose();
    activeBindingRef.current = null;

    const doSave = () => {
      const id = useEditorTabsStore.getState().activeFileId;
      if (id) void saveFile(id);
    };

    if (keybindingMode === 'vim') {
      const statusNode = getKeybindingStatusNode();
      const vimAdapter = initVimMode(editor, statusNode, BadgeVimStatusBar);
      // Route vim's native save commands through the app's real save path
      // (FSA write + dirty-flag clear) instead of a no-op/localStorage stub.
      VimApi.Vim.defineEx('write', 'w', doSave);
      VimApi.Vim.defineEx('wq', 'wq', doSave);
      // monaco-vim's own status bar only renders the "--MODE--" text; mirror
      // the same event into keybindingStore so any status-bar element (not
      // just the badge monaco-vim owns) can theme itself off the live mode.
      const setVimSubMode = useKeybindingStore.getState().setVimSubMode;
      setVimSubMode('normal');
      (vimAdapter as unknown as { on: (event: string, cb: (ev: { mode: string }) => void) => void }).on(
        'vim-mode-change',
        (ev) => setVimSubMode(ev.mode as VimSubMode),
      );
      activeBindingRef.current = {
        dispose: () => {
          vimAdapter.dispose();
          setVimSubMode(null);
        },
      };
    } else if (keybindingMode === 'emacs') {
      const emacsMode = new EmacsExtension(editor);
      const statusNode = getKeybindingStatusNode();
      const disposables: monaco.IDisposable[] = [];
      if (statusNode) {
        statusNode.textContent = '';
        disposables.push(emacsMode.onDidChangeKey((str) => (statusNode.textContent = str)));
        disposables.push(
          emacsMode.onDidMarkChange((markSet) => {
            statusNode.textContent = markSet ? 'Mark Set!' : '';
          }),
        );
      }
      // monaco-emacs has no notion of this app's file-handle-based save —
      // rebind C-x C-s to the real save path (its default C-x mappings
      // don't include a save command, so this doesn't clobber anything).
      registerGlobalCommand('C-x C-s', { description: 'Save file', run: doSave });
      emacsMode.start();
      activeBindingRef.current = {
        dispose: () => {
          disposables.forEach((d) => d.dispose());
          emacsMode.dispose();
        },
      };
    }

    return () => {
      activeBindingRef.current?.dispose();
      activeBindingRef.current = null;
    };
  }, [keybindingMode, saveFile]);

  return <div ref={containerRef} className="monaco-editor-pane" />;
}
