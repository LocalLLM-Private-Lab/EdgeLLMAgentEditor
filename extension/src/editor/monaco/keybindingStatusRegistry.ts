// monaco-vim/monaco-emacs both want a live status-bar DOM node to render
// into (vim's mode indicator, emacs' minibuffer/echo area). StatusBar owns
// that node; MonacoEditorPane needs it when applying a keybinding mode.
// Same module-level-registry shape as editorInstanceRegistry.ts, for the
// same reason (a tiny read/write pair isn't worth a React context).
let statusNode: HTMLDivElement | null = null;

export function setKeybindingStatusNode(node: HTMLDivElement | null): void {
  statusNode = node;
}

export function getKeybindingStatusNode(): HTMLDivElement | null {
  return statusNode;
}
