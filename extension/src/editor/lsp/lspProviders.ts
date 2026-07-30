import * as monaco from 'monaco-editor';
import { useLspStore, getUriForModel } from './lspStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { ensureFileAtPath } from '../copilot/resolveWorkspaceFile';
import { isLspLanguage, LSP_LANGUAGE_IDS } from './lspLanguages';
import {
  monacoPositionToLsp,
  lspRangeToMonaco,
  uriToPathSegments,
  normalizeUriKey,
  type LspRange,
} from './uriTranslation';

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspHover {
  contents: string | LspHoverContent | Array<string | LspHoverContent>;
  range?: LspRange;
}

type LspHoverContent =
  | { value: string; kind?: 'plaintext' | 'markdown' }
  | { language: string; value: string };

interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | LspMarkupContent;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?:
    | { range: LspRange; newText: string }
    | { insert: LspRange; replace: LspRange; newText: string };
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
  commitCharacters?: string[];
}

interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLspRange(value: unknown): value is LspRange {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return false;
  return (
    typeof value.start.line === 'number' &&
    typeof value.start.character === 'number' &&
    typeof value.end.line === 'number' &&
    typeof value.end.character === 'number'
  );
}

/** Normalizes Location and LocationLink responses into one shape. */
function toLspLocations(result: unknown): LspLocation[] {
  const candidates = Array.isArray(result) ? result : result ? [result] : [];
  const locations: LspLocation[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.uri === 'string' && isLspRange(candidate.range)) {
      locations.push({ uri: candidate.uri, range: candidate.range });
      continue;
    }
    if (typeof candidate.targetUri === 'string' && isLspRange(candidate.targetRange)) {
      locations.push({
        uri: candidate.targetUri,
        range: isLspRange(candidate.targetSelectionRange) ? candidate.targetSelectionRange : candidate.targetRange,
      });
    }
  }
  return locations;
}

function hoverContentsToString(contents: LspHover['contents']): string {
  const contentToString = (content: string | LspHoverContent): string => {
    if (typeof content === 'string') return content;
    if ('language' in content) {
      return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
    }
    return content.value;
  };

  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map(contentToString).join('\n\n');
  }
  return contentToString(contents);
}

function markupToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.value === 'string') return value.value;
  return undefined;
}

/** rust-analyzer returns file:// URIs while Monaco models use the app's
 * inmemory://workspace/<tabId> scheme. Open the target file when a navigation
 * request is executed so definition, declaration, implementation and type
 * definition all work across files. */
async function resolveLocationToMonaco(loc: LspLocation): Promise<{ uri: monaco.Uri; range: monaco.IRange } | null> {
  const rootUri = useLspStore.getState().rootUri;
  if (!rootUri) return null;

  let segments: string[] | null;
  try {
    segments = uriToPathSegments(rootUri, loc.uri);
  } catch {
    return null;
  }
  if (!segments) {
    // Outside the FSA workspace (e.g. Rust/Python stdlib source, or a
    // TypeScript lib.d.ts not under node_modules) — fetch it via lsp-host's
    // own filesystem access into a read-only tab instead of dropping the
    // location.
    const tab = await useEditorTabsStore.getState().openExternalFile(loc.uri);
    return tab?.model ? { uri: tab.model.uri, range: lspRangeToMonaco(loc.range) } : null;
  }

  const tabsState = useEditorTabsStore.getState();
  const existing = tabsState.openFiles.find((f) => f.pathSegments.join('/') === segments.join('/'));
  if (existing?.model) {
    return { uri: existing.model.uri, range: lspRangeToMonaco(loc.range) };
  }

  const rootHandle = useWorkspaceStore.getState().rootHandle;
  if (!rootHandle) return null;
  try {
    const node = await ensureFileAtPath(rootHandle, segments.join('/'));
    await tabsState.openFile(node);
  } catch {
    // The language server can return locations in generated or deleted files.
    // Such a location should not make the whole navigation request fail.
    return null;
  }
  const opened = useEditorTabsStore
    .getState()
    .openFiles.find((f) => f.pathSegments.join('/') === segments.join('/'));
  // An image tab has no Monaco model to navigate within — still worth
  // resolving to *a* URI (e.g. an `import logo from './logo.png'` target)
  // rather than failing the whole request, just via the plain file:// form.
  return opened
    ? { uri: opened.model?.uri ?? monaco.Uri.parse(loc.uri), range: lspRangeToMonaco(loc.range) }
    : null;
}

/** For the references peek view, do not eagerly open every result as a tab.
 * Existing tabs use their in-memory URI; closed workspace files retain their
 * file:// URI and are opened lazily by the editor opener registered below. */
function toReferenceLocation(loc: LspLocation): monaco.languages.Location | null {
  const rootUri = useLspStore.getState().rootUri;
  if (!rootUri) return null;
  let segments: string[] | null;
  try {
    segments = uriToPathSegments(rootUri, loc.uri);
  } catch {
    return null;
  }
  if (!segments) return null;

  const existing = useEditorTabsStore
    .getState()
    .openFiles.find((f) => f.pathSegments.join('/') === segments.join('/'));
  return {
    uri: existing?.model?.uri ?? monaco.Uri.parse(loc.uri),
    range: lspRangeToMonaco(loc.range),
  };
}

function lspCompletionKindToMonaco(kind: number | undefined): monaco.languages.CompletionItemKind {
  const kinds: Partial<Record<number, monaco.languages.CompletionItemKind>> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  };
  return kinds[kind ?? 1] ?? monaco.languages.CompletionItemKind.Text;
}

function completionItemToMonaco(item: LspCompletionItem, model: monaco.editor.ITextModel, position: monaco.IPosition) {
  const label = item.label;
  const labelText = typeof label === 'string' ? label : label.label;
  const monacoLabel =
    typeof label === 'string'
      ? label
      : { label: label.label, detail: label.detail, description: label.description };
  const word = model.getWordUntilPosition(position);
  const defaultRange: monaco.IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };

  const textEdit = item.textEdit;
  const range: monaco.IRange | monaco.languages.CompletionItemRanges =
    textEdit && 'range' in textEdit
      ? lspRangeToMonaco(textEdit.range)
      : textEdit && 'insert' in textEdit
        ? { insert: lspRangeToMonaco(textEdit.insert), replace: lspRangeToMonaco(textEdit.replace) }
        : defaultRange;
  const insertText = textEdit?.newText ?? item.insertText ?? labelText;
  const completion: monaco.languages.CompletionItem = {
    label: monacoLabel,
    kind: lspCompletionKindToMonaco(item.kind),
    insertText,
    range,
  };

  if (item.tags?.includes(1)) completion.tags = [monaco.languages.CompletionItemTag.Deprecated];
  if (item.detail) completion.detail = item.detail;
  if (item.documentation) completion.documentation = markupToString(item.documentation);
  if (item.sortText) completion.sortText = item.sortText;
  if (item.filterText) completion.filterText = item.filterText;
  if (item.preselect !== undefined) completion.preselect = item.preselect;
  if (item.insertTextFormat === 2) {
    completion.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  if (item.commitCharacters) completion.commitCharacters = item.commitCharacters;
  if (item.additionalTextEdits) {
    completion.additionalTextEdits = item.additionalTextEdits.map((edit) => ({
      range: lspRangeToMonaco(edit.range),
      text: edit.newText,
    }));
  }
  return completion;
}

function lspSymbolKindToMonaco(kind: number): monaco.languages.SymbolKind {
  const kinds: Partial<Record<number, monaco.languages.SymbolKind>> = {
    1: monaco.languages.SymbolKind.File,
    2: monaco.languages.SymbolKind.Module,
    3: monaco.languages.SymbolKind.Namespace,
    4: monaco.languages.SymbolKind.Package,
    5: monaco.languages.SymbolKind.Class,
    6: monaco.languages.SymbolKind.Method,
    7: monaco.languages.SymbolKind.Property,
    8: monaco.languages.SymbolKind.Field,
    9: monaco.languages.SymbolKind.Constructor,
    10: monaco.languages.SymbolKind.Enum,
    11: monaco.languages.SymbolKind.Interface,
    12: monaco.languages.SymbolKind.Function,
    13: monaco.languages.SymbolKind.Variable,
    14: monaco.languages.SymbolKind.Constant,
    15: monaco.languages.SymbolKind.String,
    16: monaco.languages.SymbolKind.Number,
    17: monaco.languages.SymbolKind.Boolean,
    18: monaco.languages.SymbolKind.Array,
    19: monaco.languages.SymbolKind.Object,
    20: monaco.languages.SymbolKind.Key,
    21: monaco.languages.SymbolKind.Null,
    22: monaco.languages.SymbolKind.EnumMember,
    23: monaco.languages.SymbolKind.Struct,
    24: monaco.languages.SymbolKind.Event,
    25: monaco.languages.SymbolKind.Operator,
    26: monaco.languages.SymbolKind.TypeParameter,
  };
  return kinds[kind] ?? monaco.languages.SymbolKind.File;
}

function toDocumentSymbol(value: unknown): monaco.languages.DocumentSymbol | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.kind !== 'number') return null;
  if (!isLspRange(value.range)) return null;
  const selectionRange = isLspRange(value.selectionRange) ? value.selectionRange : value.range;
  const children = Array.isArray(value.children)
    ? value.children.map(toDocumentSymbol).filter((symbol): symbol is monaco.languages.DocumentSymbol => symbol !== null)
    : [];
  const symbol: monaco.languages.DocumentSymbol = {
    name: value.name,
    detail: typeof value.detail === 'string' ? value.detail : '',
    kind: lspSymbolKindToMonaco(value.kind),
    tags: Array.isArray(value.tags) && value.tags.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
    range: lspRangeToMonaco(value.range),
    selectionRange: lspRangeToMonaco(selectionRange),
  };
  if (typeof value.containerName === 'string') symbol.containerName = value.containerName;
  if (children.length > 0) symbol.children = children;
  return symbol;
}

function toSignatureHelp(result: unknown): monaco.languages.SignatureHelpResult | null {
  if (!isRecord(result) || !Array.isArray(result.signatures) || result.signatures.length === 0) return null;
  const signatures = result.signatures
    .filter((signature): signature is Record<string, unknown> => isRecord(signature) && typeof signature.label === 'string')
    .map((signature) => ({
      label: signature.label as string,
      documentation: markupToString(signature.documentation),
      parameters: Array.isArray(signature.parameters)
        ? signature.parameters
            .filter((parameter): parameter is Record<string, unknown> => isRecord(parameter))
            .map((parameter) => {
              const label = parameter.label;
              const parameterLabel: string | [number, number] =
                typeof label === 'string'
                  ? label
                  : Array.isArray(label) && label.length >= 2 && typeof label[0] === 'number' && typeof label[1] === 'number'
                    ? [label[0], label[1]]
                    : '';
              return { label: parameterLabel, documentation: markupToString(parameter.documentation) };
            })
        : [],
    }));
  if (signatures.length === 0) return null;
  return {
    dispose: () => undefined,
    value: {
      signatures,
      activeSignature: typeof result.activeSignature === 'number' ? result.activeSignature : 0,
      activeParameter: typeof result.activeParameter === 'number' ? result.activeParameter : 0,
    },
  };
}

let registered = false;

/** Registers Monaco providers for language servers once per extension-page
 * lifetime. In addition to definition/hover, this includes declaration,
 * completion, references, outline, implementation, type definition and
 * signature help — all are plain LSP requests relayed by lsp-host. */
export function ensureLspProvidersRegistered(): void {
  if (registered) return;
  registered = true;

  function revealInOpener(
    source: monaco.editor.ICodeEditor,
    selectionOrPosition: monaco.IRange | monaco.IPosition | undefined,
  ): void {
    if (!selectionOrPosition) return;
    if ('startLineNumber' in selectionOrPosition) {
      source.setSelection(selectionOrPosition);
      source.revealRangeInCenter(selectionOrPosition);
    } else {
      source.setPosition(selectionOrPosition);
      source.revealPositionInCenter(selectionOrPosition);
    }
  }

  monaco.editor.registerEditorOpener({
    openCodeEditor: async (source, resource, selectionOrPosition) => {
      const rootUri = useLspStore.getState().rootUri;
      if (!rootUri) return false;
      let segments: string[] | null;
      try {
        segments = uriToPathSegments(rootUri, resource.toString());
      } catch {
        return false;
      }
      if (!segments) {
        // Outside the FSA workspace — the references peek view in
        // particular routes exclusively through this opener (see
        // toReferenceLocation's comment below), so this is the only place
        // clicking such a result can actually open it.
        const tab = await useEditorTabsStore.getState().openExternalFile(resource.toString());
        if (!tab?.model) return false;
        source.setModel(tab.model);
        revealInOpener(source, selectionOrPosition);
        return true;
      }
      const rootHandle = useWorkspaceStore.getState().rootHandle;
      if (!rootHandle) return false;

      try {
        const node = await ensureFileAtPath(rootHandle, segments.join('/'));
        await useEditorTabsStore.getState().openFile(node);
      } catch {
        return false;
      }
      const opened = useEditorTabsStore
        .getState()
        .openFiles.find((file) => file.pathSegments.join('/') === segments.join('/'));
      if (!opened?.model) return false; // an image tab has no model to navigate into

      source.setModel(opened.model);
      revealInOpener(source, selectionOrPosition);
      return true;
    },
  });

  const registerLocationProvider = (
    request: (language: string, uri: string, position: { line: number; character: number }) => Promise<unknown>,
    label: string,
  ) => ({
    provideDefinition: async (model: monaco.editor.ITextModel, position: monaco.IPosition) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return null;
      let result: unknown;
      try {
        result = await request(language, uri, monacoPositionToLsp(position));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[lsp] textDocument/${label} request failed:`, err);
        return null;
      }
      const resolved = await Promise.all(toLspLocations(result).map(resolveLocationToMonaco));
      return resolved.filter((location): location is { uri: monaco.Uri; range: monaco.IRange } => location !== null);
    },
  });

  monaco.languages.registerDefinitionProvider(LSP_LANGUAGE_IDS, {
    provideDefinition: registerLocationProvider(
      (language, uri, position) => useLspStore.getState().requestDefinition(language, uri, position),
      'definition',
    ).provideDefinition,
  });

  monaco.languages.registerDeclarationProvider(LSP_LANGUAGE_IDS, {
    provideDeclaration: registerLocationProvider(
      (language, uri, position) => useLspStore.getState().requestDeclaration(language, uri, position),
      'declaration',
    ).provideDefinition,
  });

  monaco.languages.registerImplementationProvider(LSP_LANGUAGE_IDS, {
    provideImplementation: registerLocationProvider(
      (language, uri, position) => useLspStore.getState().requestImplementation(language, uri, position),
      'implementation',
    ).provideDefinition,
  });

  monaco.languages.registerTypeDefinitionProvider(LSP_LANGUAGE_IDS, {
    provideTypeDefinition: registerLocationProvider(
      (language, uri, position) => useLspStore.getState().requestTypeDefinition(language, uri, position),
      'typeDefinition',
    ).provideDefinition,
  });

  monaco.languages.registerReferenceProvider(LSP_LANGUAGE_IDS, {
    provideReferences: async (model, position) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return null;
      let result: unknown;
      try {
        result = await useLspStore
          .getState()
          .requestReferences(language, uri, monacoPositionToLsp(position), true);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/references request failed:', err);
        return null;
      }
      return toLspLocations(result)
        .map(toReferenceLocation)
        .filter((location): location is monaco.languages.Location => location !== null);
    },
  });

  monaco.languages.registerCompletionItemProvider(LSP_LANGUAGE_IDS, {
    triggerCharacters: ['.', ':', '<', '(', ','],
    provideCompletionItems: async (model, position, context) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return null;
      let result: unknown;
      try {
        result = await useLspStore.getState().requestCompletion(language, uri, monacoPositionToLsp(position), {
          // Monaco's trigger kinds are 0/1/2; LSP uses 1/2/3.
          triggerKind: context.triggerKind + 1,
          ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/completion request failed:', err);
        return null;
      }
      const completionList =
        isRecord(result) && Array.isArray(result.items) ? (result as unknown as LspCompletionList) : null;
      const items: LspCompletionItem[] = Array.isArray(result)
        ? result.filter((item): item is LspCompletionItem => isRecord(item) && typeof item.label !== 'undefined')
        : completionList?.items ?? [];
      return {
        incomplete: Boolean(completionList?.isIncomplete),
        suggestions: items.map((item) => completionItemToMonaco(item, model, position)),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LSP_LANGUAGE_IDS, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    provideSignatureHelp: async (model, position) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return null;
      try {
        const result = await useLspStore
          .getState()
          .requestSignatureHelp(language, uri, monacoPositionToLsp(position));
        return toSignatureHelp(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/signatureHelp request failed:', err);
        return null;
      }
    },
  });

  monaco.languages.registerDocumentSymbolProvider(LSP_LANGUAGE_IDS, {
    displayName: 'language server',
    provideDocumentSymbols: async (model) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return [];
      let result: unknown;
      try {
        result = await useLspStore.getState().requestDocumentSymbols(language, uri);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/documentSymbol request failed:', err);
        return [];
      }
      if (!Array.isArray(result)) return [];

      // Most language servers return hierarchical DocumentSymbol objects.
      // The fallback also accepts the flat SymbolInformation form for older
      // server versions, while keeping symbols from other files out of this
      // document's outline.
      return result.flatMap((item) => {
        if (!isRecord(item)) return [];
        if (isRecord(item.location)) {
          if (
            typeof item.location.uri !== 'string' ||
            normalizeUriKey(item.location.uri) !== normalizeUriKey(uri) ||
            !isLspRange(item.location.range)
          ) {
            return [];
          }
          return [
            toDocumentSymbol({
              ...item,
              range: item.location.range,
              selectionRange: item.location.range,
            }),
          ].filter((symbol): symbol is monaco.languages.DocumentSymbol => symbol !== null);
        }
        const symbol = toDocumentSymbol(item);
        return symbol ? [symbol] : [];
      });
    },
  });

  monaco.languages.registerHoverProvider(LSP_LANGUAGE_IDS, {
    provideHover: async (model, position) => {
      const uri = getUriForModel(model);
      const language = model.getLanguageId();
      if (!uri || !isLspLanguage(language)) return null;
      let result: LspHover | null;
      try {
        result = (await useLspStore.getState().requestHover(language, uri, monacoPositionToLsp(position))) as LspHover | null;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[lsp] textDocument/hover request failed:', err);
        return null;
      }
      if (!result) return null;
      return {
        contents: [{ value: hoverContentsToString(result.contents) }],
        range: result.range ? lspRangeToMonaco(result.range) : undefined,
      };
    },
  });
}
