import type * as monaco from 'monaco-editor';

// The menu bar (Edit > Undo/Redo) needs to reach the live editor instance,
// which otherwise lives only inside MonacoEditorPane's local ref — a tiny
// module-level registry is simpler here than threading a React context for
// a single read/write pair.
let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}

export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return activeEditor;
}
