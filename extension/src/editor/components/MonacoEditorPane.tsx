import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { setupMonacoEnvironment } from '../monaco/setupMonacoEnvironment';
import { setActiveEditor } from '../monaco/editorInstanceRegistry';

setupMonacoEnvironment();

export function MonacoEditorPane() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const saveFile = useEditorTabsStore((s) => s.saveFile);

  useEffect(() => {
    if (!containerRef.current) return;
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

  return <div ref={containerRef} className="monaco-editor-pane" />;
}
