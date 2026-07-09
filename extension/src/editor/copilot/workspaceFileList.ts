import { loadChildren } from '../fs/fileTreeLoader';
import type { FileTreeNode } from '../../shared/types';

/**
 * Flat listing of every file in the workspace, for the Copilot context-file
 * picker and plan-step file resolution. Walks the real directory tree (not
 * just currently-expanded FileTree UI state, which is lazy-loaded) — same
 * approach as repoMap.ts's `buildRepoMap` — capped so a huge repo can't
 * hang the picker. Returns real FileTreeNode objects (not a stripped-down
 * copy) so callers can feed them straight into applyToFileFlow.ts's
 * tree-node apply path without a second lookup.
 */
export async function listWorkspaceFiles(
  rootHandle: FileSystemDirectoryHandle,
  maxEntries = 2000,
): Promise<FileTreeNode[]> {
  const budget = { remaining: maxEntries };
  return walk(rootHandle, [], budget);
}

async function walk(
  dirHandle: FileSystemDirectoryHandle,
  pathSegments: string[],
  budget: { remaining: number },
): Promise<FileTreeNode[]> {
  if (budget.remaining <= 0) return [];
  const children = await loadChildren(dirHandle, pathSegments);

  const results = await Promise.all(
    children.map(async (child): Promise<FileTreeNode[]> => {
      if (budget.remaining <= 0) return [];
      if (child.kind === 'file') {
        budget.remaining--;
        return [child];
      }
      return walk(child.handle as FileSystemDirectoryHandle, child.pathSegments, budget);
    }),
  );
  return results.flat();
}
