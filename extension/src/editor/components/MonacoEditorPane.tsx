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

type VimPosition = { line: number; ch: number };
type VimMotionContext = {
  editor: monaco.editor.IStandaloneCodeEditor;
};

const MATCHING_BRACKETS: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '「': '」',
  '」': '「',
  '『': '』',
  '』': '『',
  '（': '）',
  '）': '（',
  '【': '】',
  '】': '【',
  '〈': '〉',
  '〉': '〈',
  '《': '》',
  '》': '《',
};
const OPENING_BRACKETS = new Set(['(', '[', '{', '「', '『', '（', '【', '〈', '《']);
const QUOTE_SYMBOLS = new Set(["'", '"', '`']);

const SHELL_KEYWORD_PAIRS: Record<string, string> = {
  if: 'fi',
  for: 'done',
  while: 'done',
  until: 'done',
  select: 'done',
  case: 'esac',
};
const VERILOG_KEYWORD_PAIRS: Record<string, string> = {
  begin: 'end',
  module: 'endmodule',
  interface: 'endinterface',
  package: 'endpackage',
  program: 'endprogram',
  primitive: 'endprimitive',
  checker: 'endchecker',
  generate: 'endgenerate',
  function: 'endfunction',
  task: 'endtask',
  case: 'endcase',
  fork: 'join',
  property: 'endproperty',
  sequence: 'endsequence',
  clocking: 'endclocking',
  config: 'endconfig',
  covergroup: 'endgroup',
};
const RUBY_KEYWORD_PAIRS: Record<string, string> = {
  def: 'end',
  class: 'end',
  module: 'end',
  if: 'end',
  unless: 'end',
  case: 'end',
  begin: 'end',
  do: 'end',
  while: 'end',
  until: 'end',
  for: 'end',
};
const LUA_KEYWORD_PAIRS: Record<string, string> = {
  function: 'end',
  if: 'end',
  for: 'end',
  while: 'end',
  do: 'end',
  repeat: 'until',
};
const VHDL_KEYWORD_PAIRS: Record<string, string> = {
  architecture: 'end',
  entity: 'end',
  package: 'end',
  process: 'end',
  procedure: 'end',
  function: 'end',
  component: 'end',
  record: 'end',
  loop: 'end',
  if: 'end',
  case: 'end',
};
const KEYWORD_PAIRS_BY_LANGUAGE: Record<string, Record<string, string>> = {
  bash: SHELL_KEYWORD_PAIRS,
  shell: SHELL_KEYWORD_PAIRS,
  shellscript: SHELL_KEYWORD_PAIRS,
  verilog: VERILOG_KEYWORD_PAIRS,
  systemverilog: VERILOG_KEYWORD_PAIRS,
  ruby: RUBY_KEYWORD_PAIRS,
  lua: LUA_KEYWORD_PAIRS,
  luau: LUA_KEYWORD_PAIRS,
  vhdl: VHDL_KEYWORD_PAIRS,
};
const TAG_LANGUAGES = new Set(['html', 'xml', 'jsx', 'tsx', 'javascriptreact', 'typescriptreact']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);
const PREPROCESSOR_LANGUAGES = new Set(['c', 'cpp', 'cuda', 'objective-c', 'objective-cpp']);

/**
 * monaco-vim already defines `%` as `moveToMatchedSymbol`, but its adapter's
 * bracket API is not reliable with newer Monaco models. Keep the native API
 * as the first choice and fall back to a small nesting-aware scanner.
 */
function moveToMatchedSymbol(cm: VimMotionContext, head: VimPosition): VimPosition {
  const model = cm.editor.getModel();
  if (!model) return head;

  const position = new monaco.Position(head.line + 1, head.ch + 1);
  const offset = model.getOffsetAt(position);
  const bracketModel = model as typeof model & {
    bracketPairs?: { matchBracket: (position: monaco.Position) => monaco.Range[] | null };
  };
  const nativeMatch = bracketModel.bracketPairs?.matchBracket(position);
  if (nativeMatch?.length === 2) {
    const opening = nativeMatch[0];
    const closing = nativeMatch[1];
    const target = opening.containsPosition(position)
      ? closing
      : closing.containsPosition(position)
        ? opening
        : null;

    if (target) {
      const targetPosition = target.getStartPosition();
      const targetOffset = model.getOffsetAt(targetPosition);
      if (targetOffset !== offset) {
        return { line: targetPosition.lineNumber - 1, ch: targetPosition.column - 1 };
      }
    }
  }

  const text = model.getValue();
  const targetAt = (index: number): VimPosition => {
    const targetPosition = model.getPositionAt(index);
    return { line: targetPosition.lineNumber - 1, ch: targetPosition.column - 1 };
  };
  const tagTarget = isTagLanguage(model) ? findTagMatch(text, offset) : null;
  if (tagTarget !== null) return targetAt(tagTarget);
  const preprocessorTarget = PREPROCESSOR_LANGUAGES.has(model.getLanguageId())
    ? findPreprocessorMatch(text, offset)
    : null;
  if (preprocessorTarget !== null) return targetAt(preprocessorTarget);
  const symbolOffset = MATCHING_BRACKETS[text[offset]] || QUOTE_SYMBOLS.has(text[offset])
    ? offset
    : offset > 0 && (MATCHING_BRACKETS[text[offset - 1]] || QUOTE_SYMBOLS.has(text[offset - 1]))
      ? offset - 1
      : null;
  const keywordPairs = KEYWORD_PAIRS_BY_LANGUAGE[model.getLanguageId()];
  const keyword = keywordAt(text, offset);
  if (symbolOffset === null) {
    if (keywordPairs && keyword) {
      const targetOffset = findKeywordMatch(text, keyword, keywordPairs);
      if (targetOffset !== null) return targetAt(targetOffset);
    }
    return head;
  }

  const bracketOffset = symbolOffset;
  const current = text[bracketOffset];
  if (QUOTE_SYMBOLS.has(current)) {
    const lineStart = current === '`' ? 0 : text.lastIndexOf('\n', bracketOffset) + 1;
    const lineEnd = current === '`' ? text.length : text.indexOf('\n', bracketOffset + 1);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const quoteOffsets: number[] = [];
    for (let index = lineStart; index < end; index += 1) {
      if (text[index] === current && !isEscaped(text, index)) quoteOffsets.push(index);
    }
    const quoteIndex = quoteOffsets.indexOf(bracketOffset);
    if (quoteIndex !== -1) {
      const targetOffset = quoteIndex % 2 === 0 ? quoteOffsets[quoteIndex + 1] : quoteOffsets[quoteIndex - 1];
      if (targetOffset !== undefined) return targetAt(targetOffset);
    }
    return head;
  }

  const matching = MATCHING_BRACKETS[current];
  if (!matching) return head;

  if (OPENING_BRACKETS.has(current)) {
    const stack = [current];
    for (let index = bracketOffset + 1; index < text.length; index += 1) {
      const character = text[index];
      if (OPENING_BRACKETS.has(character)) {
        stack.push(character);
      } else if (!OPENING_BRACKETS.has(character) && MATCHING_BRACKETS[character]) {
        if (MATCHING_BRACKETS[stack[stack.length - 1]] === character) {
          stack.pop();
          if (stack.length === 0) return targetAt(index);
        }
      }
    }
  } else {
    const stack = [current];
    for (let index = bracketOffset - 1; index >= 0; index -= 1) {
      const character = text[index];
      if (!OPENING_BRACKETS.has(character) && MATCHING_BRACKETS[character]) {
        stack.push(character);
      } else if (OPENING_BRACKETS.has(character)) {
        if (MATCHING_BRACKETS[character] === stack[stack.length - 1]) {
          stack.pop();
          if (stack.length === 0) return targetAt(index);
        }
      }
    }
  }
  return head;
}

function isEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

type KeywordToken = { word: string; start: number; end: number };

function keywordAt(text: string, offset: number): KeywordToken | null {
  const isWord = (character: string | undefined) => Boolean(character && /[A-Za-z0-9_$]/.test(character));
  let start = offset;
  if (!isWord(text[start])) start -= 1;
  if (start < 0 || !isWord(text[start])) return null;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  let end = offset + 1;
  while (end < text.length && isWord(text[end])) end += 1;
  return { word: text.slice(start, end), start, end };
}

function keywordTokens(text: string): KeywordToken[] {
  const tokens: KeywordToken[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_$]*/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function findKeywordMatch(text: string, current: KeywordToken, pairs: Record<string, string>): number | null {
  const tokens = keywordTokens(text);
  const currentIndex = tokens.findIndex((token) => token.start === current.start && token.end === current.end);
  if (currentIndex === -1) return null;

  const closingToOpening = new Map(Object.entries(pairs).map(([opening, closing]) => [closing, opening]));
  if (pairs[current.word]) {
    const stack = [pairs[current.word]];
    for (const token of tokens.slice(currentIndex + 1)) {
      if (pairs[token.word]) {
        stack.push(pairs[token.word]);
      } else if (closingToOpening.has(token.word) && token.word === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return token.start;
      }
    }
  } else if (closingToOpening.has(current.word)) {
    const stack = [current.word];
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      if (closingToOpening.has(token.word)) {
        stack.push(token.word);
      } else if (pairs[token.word] === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return token.start;
      }
    }
  }
  return null;
}

function isTagLanguage(model: monaco.editor.ITextModel): boolean {
  if (TAG_LANGUAGES.has(model.getLanguageId())) return true;
  const path = model.uri.path.toLowerCase();
  return (model.getLanguageId() === 'javascript' || model.getLanguageId() === 'typescript')
    && [...JSX_EXTENSIONS].some((extension) => path.endsWith(extension));
}

type TagToken = {
  name: string;
  start: number;
  end: number;
  opening: boolean;
  selfClosing: boolean;
};

function findTagMatch(text: string, offset: number): number | null {
  const tags = scanTags(text);
  const currentIndex = tags.findIndex(
    (tag) => (tag.start <= offset && offset < tag.end) || (tag.start <= offset - 1 && offset - 1 < tag.end),
  );
  if (currentIndex === -1 || tags[currentIndex].selfClosing) return null;

  const current = tags[currentIndex];
  if (current.opening) {
    const stack = [current.name];
    for (const tag of tags.slice(currentIndex + 1)) {
      if (tag.selfClosing || tag.name !== current.name) continue;
      if (tag.opening) {
        stack.push(tag.name);
      } else {
        stack.pop();
        if (stack.length === 0) return tag.start;
      }
    }
  } else {
    const stack = [current.name];
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const tag = tags[index];
      if (tag.selfClosing || tag.name !== current.name) continue;
      if (!tag.opening) {
        stack.push(tag.name);
      } else {
        stack.pop();
        if (stack.length === 0) return tag.start;
      }
    }
  }
  return null;
}

function scanTags(text: string): TagToken[] {
  const tags: TagToken[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '<') continue;
    if (text.startsWith('<!--', index)) {
      const commentEnd = text.indexOf('-->', index + 4);
      index = commentEnd === -1 ? text.length : commentEnd + 2;
      continue;
    }

    let cursor = index + 1;
    const closing = text[cursor] === '/';
    if (closing) cursor += 1;
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    if (text[cursor] === '!' || text[cursor] === '?') continue;

    const nameStart = cursor;
    while (/[A-Za-z0-9_.:-]/.test(text[cursor] ?? '')) cursor += 1;
    const name = text.slice(nameStart, cursor).toLowerCase();
    if (!name && text[cursor] !== '>') continue;

    let quote: string | null = null;
    let end = cursor;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (quote) {
        if (character === quote && !isEscaped(text, end)) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= text.length) break;

    let marker = end - 1;
    while (/\s/.test(text[marker] ?? '')) marker -= 1;
    const selfClosing = !closing && text[marker] === '/';
    tags.push({ name, start: index, end: end + 1, opening: !closing, selfClosing });
    index = end;
  }
  return tags;
}

function findPreprocessorMatch(text: string, offset: number): number | null {
  const directives: Array<{ kind: string; start: number }> = [];
  const linePattern = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b/gm;
  for (let match = linePattern.exec(text); match; match = linePattern.exec(text)) {
    directives.push({ kind: match[1], start: text.indexOf('#', match.index) });
  }
  const currentIndex = directives.findIndex((directive) => {
    const lineEnd = text.indexOf('\n', directive.start);
    const end = lineEnd === -1 ? text.length : lineEnd;
    return directive.start <= offset && offset < end || directive.start <= offset - 1 && offset - 1 < end;
  });
  if (currentIndex === -1) return null;

  const current = directives[currentIndex];
  const openings = new Set(['if', 'ifdef', 'ifndef']);
  if (openings.has(current.kind)) {
    let depth = 1;
    for (const directive of directives.slice(currentIndex + 1)) {
      if (openings.has(directive.kind)) depth += 1;
      else if (directive.kind === 'endif') {
        depth -= 1;
        if (depth === 0) return directive.start;
      }
    }
  } else if (current.kind === 'endif') {
    let depth = 1;
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const directive = directives[index];
      if (directive.kind === 'endif') depth += 1;
      else if (openings.has(directive.kind)) {
        depth -= 1;
        if (depth === 0) return directive.start;
      }
    }
  }
  return null;
}

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
      (VimApi as unknown as {
        Vim: {
          defineMotion: (name: string, fn: (cm: VimMotionContext, head: VimPosition) => VimPosition) => void;
        };
      }).Vim.defineMotion('moveToMatchedSymbol', moveToMatchedSymbol);
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
