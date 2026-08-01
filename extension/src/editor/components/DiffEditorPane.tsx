import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { ensureLanguageTokenization, isCustomThemeReady, TEXTMATE_THEME_ID } from '../monaco/textmateTokenization';
import type { EditorDiffView } from '../state/diffViewStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useKeybindingStore } from '../state/keybindingStore';
import { installDiffEditorKeybindings } from '../monaco/diffEditorKeybindings';
import './DiffEditorPane.css';

interface DiffEditorPaneProps {
  view: EditorDiffView;
}

export function DiffEditorPane({ view }: DiffEditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorsRef = useRef<monaco.editor.IStandaloneCodeEditor[]>([]);
  const keybindingDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const keybindingMode = useKeybindingStore((state) => state.mode);

  function disposeDiffKeybindings() {
    keybindingDisposablesRef.current.forEach((binding) => binding.dispose());
    keybindingDisposablesRef.current = [];
  }

  function installDiffKeybindings() {
    disposeDiffKeybindings();
    keybindingDisposablesRef.current = diffEditorsRef.current.map((editor) =>
      installDiffEditorKeybindings(editor, useKeybindingStore.getState().mode, () => {
        const model = editor.getModel();
        const tab = useEditorTabsStore.getState().openFiles.find((file) => file.model === model);
        if (tab) void useEditorTabsStore.getState().saveFile(tab.id);
      }),
    );
  }

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let editor: monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: monaco.editor.ITextModel | undefined;
    let modifiedModel: monaco.editor.ITextModel | undefined;
    let ownsOriginalModel = false;
    let ownsModifiedModel = false;
    void ensureLanguageTokenization(view.language).then(() => {
      if (disposed || !containerRef.current) return;
      editor = monaco.editor.createDiffEditor(containerRef.current, {
        automaticLayout: true,
        originalEditable: view.bothEditable === true,
        readOnly: false,
        renderSideBySide: true,
        minimap: { enabled: false },
        theme: isCustomThemeReady() ? TEXTMATE_THEME_ID : 'vs-dark',
        scrollBeyondLastLine: false,
      });
      originalModel = view.originalFileId
        ? useEditorTabsStore.getState().openFiles.find((file) => file.id === view.originalFileId)?.model
        : undefined;
      if (!originalModel) {
        originalModel = monaco.editor.createModel(view.original, view.language);
        ownsOriginalModel = true;
      }
      modifiedModel = view.modifiedFileId
        ? useEditorTabsStore.getState().openFiles.find((file) => file.id === view.modifiedFileId)?.model
        : undefined;
      if (!modifiedModel) {
        modifiedModel = monaco.editor.createModel(view.modified, view.language);
        ownsModifiedModel = true;
      }
      editor.setModel({ original: originalModel, modified: modifiedModel });
      diffEditorsRef.current = [editor.getOriginalEditor(), editor.getModifiedEditor()];
      for (const child of diffEditorsRef.current) {
        child.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          const model = child.getModel();
          const tab = useEditorTabsStore.getState().openFiles.find((file) => file.model === model);
          if (tab) void useEditorTabsStore.getState().saveFile(tab.id);
        });
        child.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => {
          const current = child.getRawOptions().wordWrap;
          child.updateOptions({ wordWrap: current === 'on' ? 'off' : 'on' });
        });
      }
      installDiffKeybindings();
    });

    return () => {
      if (disposed) return;
      disposed = true;
      editor?.dispose();
      disposeDiffKeybindings();
      diffEditorsRef.current = [];
      if (ownsOriginalModel) originalModel?.dispose();
      if (ownsModifiedModel) modifiedModel?.dispose();
    };
  }, [view]);

  useEffect(() => {
    if (diffEditorsRef.current.length > 0) installDiffKeybindings();
    return disposeDiffKeybindings;
  }, [keybindingMode]);

  return (
    <div className="editor-diff-view">
      <div className="editor-diff-view-header">
        <span>{view.originalName}</span>
        <span className="editor-diff-view-separator">↔</span>
        <span>{view.modifiedName}</span>
      </div>
      <div ref={containerRef} className="editor-diff-view-body" />
    </div>
  );
}
