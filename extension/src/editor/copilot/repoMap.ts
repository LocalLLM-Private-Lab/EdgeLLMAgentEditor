import { loadChildren } from '../fs/fileTreeLoader';
import type { FileTreeNode } from '../../shared/types';

interface EntryBudget {
  remaining: number;
}

/**
 * Renders an indented text tree of the workspace, for optionally injecting
 * into a Copilot prompt so it has some sense of the project's shape beyond
 * the single active file. Walks the real directory tree (not just
 * currently-expanded UI state) up to maxDepth/maxEntries so large repos
 * don't blow up the prompt.
 *
 * The root line intentionally does NOT show the workspace's actual folder
 * name (e.g. a local, often-meaningless name like "新しいフォルダー") —
 * Copilot has repeatedly misread that as a path segment to prepend to
 * every file path it returns, which silently broke path resolution
 * downstream. A neutral placeholder carries the same "this is the root"
 * signal without anything that looks like it belongs in a path.
 */
export async function buildRepoMap(
  rootHandle: FileSystemDirectoryHandle,
  maxDepth = 3,
  maxEntries = 200,
): Promise<string> {
  const lines = await walk(rootHandle, 1, '  ', maxDepth, { remaining: maxEntries });
  return ['(ワークスペースルート)', ...lines].join('\n');
}

/** Sibling directories are independent I/O and walked concurrently, but
 * results are assembled back in original listing order (by array
 * position, not completion order) so the rendered tree stays deterministic
 * — only the underlying `loadChildren` calls run in parallel. */
async function walk(
  dirHandle: FileSystemDirectoryHandle,
  depth: number,
  indent: string,
  maxDepth: number,
  budget: EntryBudget,
): Promise<string[]> {
  if (depth > maxDepth || budget.remaining <= 0) return [];
  const children = await loadChildren(dirHandle, []);

  const included: FileTreeNode[] = [];
  for (const child of children) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    included.push(child);
  }
  const truncated = included.length < children.length;

  const subtrees = await Promise.all(
    included.map(async (child) => {
      if (child.kind !== 'directory') return [`${indent}${child.name}`];
      const nested = await walk(
        child.handle as FileSystemDirectoryHandle,
        depth + 1,
        indent + '  ',
        maxDepth,
        budget,
      );
      return [`${indent}${child.name}/`, ...nested];
    }),
  );

  const lines = subtrees.flat();
  if (truncated) lines.push(`${indent}...`);
  return lines;
}
