import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { FileTreeNode, OpenFile } from '../../shared/types';
import { getFileLastModified, readFileText, writeFileText } from '../fs/fsaWorkspace';
import { languageFromFilename } from '../monaco/languageRegistrations';

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
    const [content, lastModified] = await Promise.all([
      readFileText(fileHandle),
      getFileLastModified(fileHandle),
    ]);
    const language = languageFromFilename(node.name);
    const id = uuid();
    const modelUri = monaco.Uri.parse(`inmemory://workspace/${id}`);
    const model = monaco.editor.createModel(content, language, modelUri);

    const tab: EditorTab = {
      id,
      name: node.name,
      pathSegments: node.pathSegments,
      fileHandle,
      modelUri: modelUri.toString(),
      isDirty: false,
      language,
      lastKnownDiskModified: lastModified,
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
    });

    set((state) => ({
      openFiles: [...state.openFiles, tab],
      activeFileId: id,
      ...pushHistory(state, id),
    }));
  },

  closeFile: (id: string) => {
    const tab = get().openFiles.find((f) => f.id === id);
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

    await writeFileText(tab.fileHandle, tab.model.getValue());
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
    for (const tab of toClose) tab.model.dispose();
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
        const newPathSegments = [...f.pathSegments.slice(0, -1), newName];
        const language = languageFromFilename(newName);
        monaco.editor.setModelLanguage(f.model, language);
        return { ...f, name: newName, pathSegments: newPathSegments, language };
      }),
    }));
  },
}));
