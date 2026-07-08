import { create } from 'zustand';
import type { FileTreeNode } from '../../shared/types';
import {
  createFileEntry,
  createFolderEntry,
  pickWorkspaceFolder,
  queryReadWritePermission,
  removeEntry as removeFsEntry,
  renameDirectoryEntry,
  renameFileEntry,
  requestReadWritePermission,
} from '../fs/fsaWorkspace';
import { loadChildren } from '../fs/fileTreeLoader';
import {
  clearSavedWorkspaceHandle,
  loadSavedWorkspaceHandle,
  saveWorkspaceHandle,
} from '../fs/handlePersistence';
import { useEditorTabsStore } from './editorTabsStore';

type ConnectionStatus = 'empty' | 'needs-reconnect' | 'connected' | 'error';

/** null means the workspace root. A file node's own directory (not the
 * file itself) is a valid target too, so this isn't just "a directory
 * FileTreeNode" — see directoryTargetFor(). */
export interface DirectoryTarget {
  handle: FileSystemDirectoryHandle;
  pathSegments: string[];
}

export function directoryTargetFor(node: FileTreeNode | null): DirectoryTarget | null {
  if (!node) return null;
  if (node.kind === 'directory') {
    return { handle: node.handle as FileSystemDirectoryHandle, pathSegments: node.pathSegments };
  }
  return { handle: node.parentHandle, pathSegments: node.pathSegments.slice(0, -1) };
}

interface WorkspaceState {
  rootHandle: FileSystemDirectoryHandle | null;
  status: ConnectionStatus;
  errorMessage: string | null;
  tree: FileTreeNode[];
  openFolder: () => Promise<void>;
  restoreFromLastSession: () => Promise<void>;
  reconnect: () => Promise<void>;
  toggleExpand: (node: FileTreeNode) => Promise<void>;
  createFile: (target: DirectoryTarget | null, name: string) => Promise<void>;
  createFolder: (target: DirectoryTarget | null, name: string) => Promise<void>;
  renameEntry: (node: FileTreeNode, newName: string) => Promise<void>;
  deleteEntry: (node: FileTreeNode) => Promise<void>;
}

async function buildRootTree(handle: FileSystemDirectoryHandle): Promise<FileTreeNode[]> {
  return loadChildren(handle, []);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootHandle: null,
  status: 'empty',
  errorMessage: null,
  tree: [],

  openFolder: async () => {
    try {
      const handle = await pickWorkspaceFolder();
      await saveWorkspaceHandle(handle);
      const tree = await buildRootTree(handle);
      set({ rootHandle: handle, status: 'connected', tree, errorMessage: null });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      set({ status: 'error', errorMessage: (err as Error).message });
    }
  },

  restoreFromLastSession: async () => {
    const handle = await loadSavedWorkspaceHandle();
    if (!handle) {
      set({ status: 'empty' });
      return;
    }
    const permission = await queryReadWritePermission(handle);
    if (permission === 'granted') {
      const tree = await buildRootTree(handle);
      set({ rootHandle: handle, status: 'connected', tree, errorMessage: null });
    } else {
      set({ rootHandle: handle, status: 'needs-reconnect' });
    }
  },

  reconnect: async () => {
    const { rootHandle } = get();
    if (!rootHandle) return;
    try {
      const permission = await requestReadWritePermission(rootHandle);
      if (permission !== 'granted') {
        set({ status: 'needs-reconnect', errorMessage: '許可が付与されませんでした' });
        return;
      }
      const tree = await buildRootTree(rootHandle);
      set({ status: 'connected', tree, errorMessage: null });
    } catch (err) {
      set({ status: 'error', errorMessage: (err as Error).message });
      await clearSavedWorkspaceHandle();
    }
  },

  toggleExpand: async (node: FileTreeNode) => {
    if (node.kind !== 'directory') return;
    if (node.childrenLoaded) {
      updateNode(set, node.id, (n) => ({ ...n, children: n.children }));
      return;
    }
    const children = await loadChildren(
      node.handle as FileSystemDirectoryHandle,
      node.pathSegments,
    );
    updateNode(set, node.id, (n) => ({ ...n, children, childrenLoaded: true }));
  },

  createFile: async (target, name) => {
    const { rootHandle } = get();
    if (!rootHandle) return;
    try {
      const dirHandle = target ? target.handle : rootHandle;
      await createFileEntry(dirHandle, name);
      await refreshDirectory(set, dirHandle, target ? target.pathSegments : []);
    } catch (err) {
      set({ errorMessage: (err as Error).message });
      throw err;
    }
  },

  createFolder: async (target, name) => {
    const { rootHandle } = get();
    if (!rootHandle) return;
    try {
      const dirHandle = target ? target.handle : rootHandle;
      await createFolderEntry(dirHandle, name);
      await refreshDirectory(set, dirHandle, target ? target.pathSegments : []);
    } catch (err) {
      set({ errorMessage: (err as Error).message });
      throw err;
    }
  },

  renameEntry: async (node, newName) => {
    try {
      const oldPathSegments = node.pathSegments;
      if (node.kind === 'file') {
        await renameFileEntry(node.handle as FileSystemFileHandle, newName);
      } else {
        await renameDirectoryEntry(
          node.handle as FileSystemDirectoryHandle,
          node.parentHandle,
          node.name,
          newName,
        );
      }
      useEditorTabsStore.getState().renameOpenFile(oldPathSegments, newName);
      await refreshDirectory(set, node.parentHandle, oldPathSegments.slice(0, -1));
    } catch (err) {
      set({ errorMessage: (err as Error).message });
      throw err;
    }
  },

  deleteEntry: async (node) => {
    try {
      await removeFsEntry(node.parentHandle, node.name, node.kind === 'directory');
      useEditorTabsStore.getState().closeFilesByPathPrefix(node.pathSegments);
      await refreshDirectory(set, node.parentHandle, node.pathSegments.slice(0, -1));
    } catch (err) {
      set({ errorMessage: (err as Error).message });
      throw err;
    }
  },
}));

async function refreshDirectory(
  set: (fn: (state: WorkspaceState) => Partial<WorkspaceState>) => void,
  dirHandle: FileSystemDirectoryHandle,
  dirPathSegments: string[],
): Promise<void> {
  const children = await loadChildren(dirHandle, dirPathSegments);
  if (dirPathSegments.length === 0) {
    set(() => ({ tree: children }));
  } else {
    updateNode(set, dirPathSegments.join('/'), (n) => ({ ...n, children, childrenLoaded: true }));
  }
}

function updateNode(
  set: (fn: (state: WorkspaceState) => Partial<WorkspaceState>) => void,
  targetId: string,
  update: (node: FileTreeNode) => FileTreeNode,
) {
  set((state) => ({ tree: mapTree(state.tree, targetId, update) }));
}

/**
 * Rebuilds only the ancestor chain leading to `targetId`, leaving sibling
 * subtrees referentially unchanged — node ids are '/'-joined path
 * segments, so the chain is derivable directly instead of searching the
 * whole tree. Every mutation (expand, create, rename, delete) touches at
 * most depth-of-target nodes rather than every expanded directory,  and
 * untouched siblings keep their object identity so memoized tree rows can
 * bail out of re-rendering.
 */
function mapTree(
  nodes: FileTreeNode[],
  targetId: string,
  update: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  const segments = targetId.split('/');
  return mapTreeAlongPath(nodes, segments, 0, targetId, update);
}

function mapTreeAlongPath(
  nodes: FileTreeNode[],
  segments: string[],
  depth: number,
  targetId: string,
  update: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  const ancestorId = segments.slice(0, depth + 1).join('/');
  return nodes.map((node) => {
    if (node.id !== ancestorId) return node;
    if (node.id === targetId) return update(node);
    if (!node.children) return node;
    return {
      ...node,
      children: mapTreeAlongPath(node.children, segments, depth + 1, targetId, update),
    };
  });
}
