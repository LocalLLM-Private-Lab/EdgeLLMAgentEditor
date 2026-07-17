import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { FileTreeNode, OpenFile } from '../../shared/types';
import { getFileLastModified, readFileBytes, writeFileBytes } from '../fs/fsaWorkspace';
import { languageFromFilename } from '../monaco/languageRegistrations';
import { ensureLanguageTokenization } from '../monaco/textmateTokenization';
import { decodeBytes, detectEncodingFromBytes, encodeString, type TextEncodingId } from '../fs/textEncodings';
import { useLspStore } from '../lsp/lspStore';
import { isLspLanguage } from '../lsp/lspLanguages';
import { pathSegmentsToUri } from '../lsp/uriTranslation';

function detectEol(content: string): 'LF' | 'CRLF' {
  return content.includes('\r\n') ? 'CRLF' : 'LF';
}

function eolSequence(eol: 'LF' | 'CRLF'): monaco.editor.EndOfLineSequence {
  return eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
}

interface EditorTab extends OpenFile {
  model: monaco.editor.ITextModel;
}

interface EditorTabsState {
  openFiles: EditorTab[];
  activeFileId: string | null;
  /** Simple file-level "which tab was active" history (not per-cursor —
   * standalone Monaco has no cross-file navigation stack built in). */
  navHistory: string[];
  navIndex: number;
  openFile: (node: FileTreeNode) => Promise<void>;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  closeFilesByPathPrefix: (pathPrefix: string[]) => void;
  renameOpenFile: (oldPathSegments: string[], newName: string) => void;
  /** 'reopen' re-decodes the on-disk bytes with the given encoding, discarding
   * any unsaved changes (confirms first if dirty). 'resave' only changes what
   * encoding the *next* save will use, without touching the current content. */
  setFileEncoding: (id: string, encoding: TextEncodingId, mode: 'reopen' | 'resave') => Promise<void>;
  setFileEol: (id: string, eol: 'LF' | 'CRLF') => void;
}

/** Appends `id` to the nav history, discarding any forward history — the
 * same truncate-on-navigate behavior as a browser's back/forward stack. */
function pushHistory(
  state: Pick<EditorTabsState, 'navHistory' | 'navIndex'>,
  id: string,
): Pick<EditorTabsState, 'navHistory' | 'navIndex'> {
  if (state.navHistory[state.navIndex] === id) return state;
  const truncated = state.navHistory.slice(0, state.navIndex + 1);
  const navHistory = [...truncated, id];
  return { navHistory, navIndex: navHistory.length - 1 };
}

function isPathPrefixMatch(prefix: string[], full: string[]): boolean {
  return prefix.length <= full.length && prefix.every((segment, i) => full[i] === segment);
}

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  openFiles: [],
  activeFileId: null,
  navHistory: [],
  navIndex: -1,

  openFile: async (node: FileTreeNode) => {
    if (node.kind !== 'file') return;
    const existing = get().openFiles.find((f) => f.pathSegments.join('/') === node.id);
    if (existing) {
      set((state) => ({ activeFileId: existing.id, ...pushHistory(state, existing.id) }));
      return;
    }

    const fileHandle = node.handle as FileSystemFileHandle;
    const [bytes, lastModified] = await Promise.all([
      readFileBytes(fileHandle),
      getFileLastModified(fileHandle),
    ]);
    const encoding = detectEncodingFromBytes(bytes);
    const content = decodeBytes(bytes, encoding);
    const eol = detectEol(content);
    const language = languageFromFilename(node.name);
    await ensureLanguageTokenization(language);
    const id = uuid();
    const modelUri = monaco.Uri.parse(`inmemory://workspace/${id}`);
    const model = monaco.editor.createModel(content, language, modelUri);
    // Monaco settles on whichever EOL is more frequent in the buffer by
    // default — pin it to the detected one explicitly so a file that's
    // (say) all-CRLF-but-one-stray-LF-line still round-trips consistently,
    // and so getValue() on save reliably emits the original style.
    model.setEOL(eolSequence(eol));

    const tab: EditorTab = {
      id,
      name: node.name,
      pathSegments: node.pathSegments,
      fileHandle,
      modelUri: modelUri.toString(),
      isDirty: false,
      language,
      lastKnownDiskModified: lastModified,
      encoding,
      eol,
      model,
    };

    model.onDidChangeContent(() => {
      const state = get();
      const tabNow = state.openFiles.find((f) => f.id === id);
      if (tabNow && !tabNow.isDirty) {
        set({
          openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, isDirty: true } : f)),
        });
      }
      if (isLspLanguage(language)) {
        const rootUri = useLspStore.getState().rootUri;
        if (rootUri) {
          useLspStore.getState().notifyDidChange(pathSegmentsToUri(rootUri, node.pathSegments), language);
        }
      }
    });

    // Lazily starts (or reuses) the language-server session for supported
    // languages, then sends textDocument/didOpen. Fire-and-forget keeps a
    // missing external server from blocking file opening; the status bar
    // surfaces the launch error.
    if (isLspLanguage(language)) {
      void (async () => {
        try {
          await useLspStore.getState().ensureSession(language);
        } catch {
          return;
        }
        const rootUri = useLspStore.getState().rootUri;
        if (!rootUri) return;
        useLspStore.getState().registerDocument(pathSegmentsToUri(rootUri, node.pathSegments), model, language);
      })();
    }

    set((state) => ({
      openFiles: [...state.openFiles, tab],
      activeFileId: id,
      ...pushHistory(state, id),
    }));
  },

  closeFile: (id: string) => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (tab && isLspLanguage(tab.language)) {
      const rootUri = useLspStore.getState().rootUri;
      if (rootUri) useLspStore.getState().unregisterDocument(pathSegmentsToUri(rootUri, tab.pathSegments));
    }
    tab?.model.dispose();
    set((state) => {
      const openFiles = state.openFiles.filter((f) => f.id !== id);
      const activeFileId =
        state.activeFileId === id
          ? (openFiles[openFiles.length - 1]?.id ?? null)
          : state.activeFileId;
      return { openFiles, activeFileId };
    });
  },

  setActiveFile: (id: string) => set((state) => ({ activeFileId: id, ...pushHistory(state, id) })),

  goBack: () => {
    const { navHistory, navIndex } = get();
    if (navIndex <= 0) return;
    const newIndex = navIndex - 1;
    set({ navIndex: newIndex, activeFileId: navHistory[newIndex] });
  },

  goForward: () => {
    const { navHistory, navIndex } = get();
    if (navIndex >= navHistory.length - 1) return;
    const newIndex = navIndex + 1;
    set({ navIndex: newIndex, activeFileId: navHistory[newIndex] });
  },

  saveFile: async (id: string) => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab) return;

    const diskModified = await getFileLastModified(tab.fileHandle);
    if (diskModified !== tab.lastKnownDiskModified) {
      const overwrite = window.confirm(
        `${tab.name} はディスク上で変更されています。上書き保存しますか？`,
      );
      if (!overwrite) return;
    }

    await writeFileBytes(tab.fileHandle, encodeString(tab.model.getValue(), tab.encoding));
    const newModified = await getFileLastModified(tab.fileHandle);
    set((state) => ({
      openFiles: state.openFiles.map((f) =>
        f.id === id ? { ...f, isDirty: false, lastKnownDiskModified: newModified } : f,
      ),
    }));
  },

  saveAllFiles: async () => {
    const dirtyIds = get().openFiles.filter((f) => f.isDirty).map((f) => f.id);
    for (const id of dirtyIds) {
      await get().saveFile(id);
    }
  },

  // Deleting a file (or a folder containing open files) shouldn't leave
  // tabs pointing at handles for entries that no longer exist.
  closeFilesByPathPrefix: (pathPrefix: string[]) => {
    const toClose = get().openFiles.filter((f) => isPathPrefixMatch(pathPrefix, f.pathSegments));
    const rootUri = useLspStore.getState().rootUri;
    for (const tab of toClose) {
      if (isLspLanguage(tab.language) && rootUri) {
        useLspStore.getState().unregisterDocument(pathSegmentsToUri(rootUri, tab.pathSegments));
      }
      tab.model.dispose();
    }
    set((state) => {
      const openFiles = state.openFiles.filter(
        (f) => !isPathPrefixMatch(pathPrefix, f.pathSegments),
      );
      const activeFileId = toClose.some((t) => t.id === state.activeFileId)
        ? (openFiles[openFiles.length - 1]?.id ?? null)
        : state.activeFileId;
      return { openFiles, activeFileId };
    });
  },

  // Only updates an exact match (the renamed file itself, not files nested
  // under a renamed folder — their pathSegments go stale cosmetically, but
  // the underlying handles keep working since FSA moves are handle-based).
  renameOpenFile: (oldPathSegments: string[], newName: string) => {
    set((state) => ({
      openFiles: state.openFiles.map((f) => {
        if (f.pathSegments.join('/') !== oldPathSegments.join('/')) return f;
        const oldLanguage = f.language;
        const newPathSegments = [...f.pathSegments.slice(0, -1), newName];
        const language = languageFromFilename(newName);
        const rootUri = useLspStore.getState().rootUri;
        if (isLspLanguage(oldLanguage) && rootUri) {
          useLspStore.getState().unregisterDocument(pathSegmentsToUri(rootUri, f.pathSegments));
        }
        void ensureLanguageTokenization(language);
        monaco.editor.setModelLanguage(f.model, language);
        if (isLspLanguage(language)) {
          void (async () => {
            try {
              await useLspStore.getState().ensureSession(language);
            } catch {
              return;
            }
            const nextRootUri = useLspStore.getState().rootUri;
            if (nextRootUri) {
              useLspStore
                .getState()
                .registerDocument(pathSegmentsToUri(nextRootUri, newPathSegments), f.model, language);
            }
          })();
        }
        return { ...f, name: newName, pathSegments: newPathSegments, language };
      }),
    }));
  },

  setFileEncoding: async (id: string, encoding: TextEncodingId, mode: 'reopen' | 'resave') => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab) return;

    if (mode === 'resave') {
      set((state) => ({
        openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, encoding, isDirty: true } : f)),
      }));
      return;
    }

    if (tab.isDirty) {
      const discard = window.confirm(
        `${tab.name} には未保存の変更があります。別のエンコーディングで開き直すと、その変更は破棄されます。続行しますか？`,
      );
      if (!discard) return;
    }

    const bytes = await readFileBytes(tab.fileHandle);
    const content = decodeBytes(bytes, encoding);
    const eol = detectEol(content);
    tab.model.setValue(content);
    tab.model.setEOL(eolSequence(eol));
    const lastModified = await getFileLastModified(tab.fileHandle);
    set((state) => ({
      openFiles: state.openFiles.map((f) =>
        f.id === id
          ? { ...f, encoding, eol, isDirty: false, lastKnownDiskModified: lastModified }
          : f,
      ),
    }));
  },

  setFileEol: (id: string, eol: 'LF' | 'CRLF') => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab || tab.eol === eol) return;
    tab.model.setEOL(eolSequence(eol));
    set((state) => ({
      openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, eol, isDirty: true } : f)),
    }));
  },
}));

// Re-registers currently open documents after a language-server session is
// restarted against a different root. Each language reports its own ready
// event on the multiplexed connection, so only that language's documents are
// sent after its initialize handshake completes.
let syncedLspRootUri: string | null = null;
const syncedLspLanguages = new Set<string>();
useLspStore.subscribe((state) => {
  if (state.status !== 'ready' || !state.rootUri || !state.readyLanguage || !isLspLanguage(state.readyLanguage)) return;
  const rootChanged = state.rootUri !== syncedLspRootUri;
  const hadPreviousRoot = syncedLspRootUri !== null;
  if (rootChanged) syncedLspLanguages.clear();
  syncedLspRootUri = state.rootUri;
  if (syncedLspLanguages.has(state.readyLanguage)) return;
  syncedLspLanguages.add(state.readyLanguage);
  // The first session for a language is registered by openFile() after its
  // ensureSession() promise resolves. Re-registering here on that initial
  // handshake would send duplicate didOpen notifications. A root change is
  // different: tracked documents were intentionally cleared, so they must
  // be restored here after the new server initializes.
  if (!hadPreviousRoot || !rootChanged) return;

  const rootUri = state.rootUri;
  for (const tab of useEditorTabsStore.getState().openFiles) {
    if (tab.language !== state.readyLanguage) continue;
    useLspStore.getState().registerDocument(pathSegmentsToUri(rootUri, tab.pathSegments), tab.model, tab.language);
  }
});
