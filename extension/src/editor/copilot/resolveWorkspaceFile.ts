import type { FileTreeNode } from '../../shared/types';
import { listWorkspaceFiles } from './workspaceFileList';

/** FileTreeNode.id never includes the workspace root's own folder name
 * (root-level files are just e.g. ".gitignore", not "myproject/.gitignore")
 * — but repoMap.ts's rendering shows that root name on its own first line
 * ("myproject/"), which Copilot sometimes misreads as needing to be
 * prepended to every path it returns. Rather than rely on prompt wording
 * alone to prevent that (unreliable — same lesson as the fence-parsing
 * bug), strip it defensively wherever we resolve a Copilot-provided path. */
function stripRootPrefix(path: string, rootName: string): string {
  const prefix = `${rootName}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Resolves a set of '/'-joined relative paths (as given by Copilot's plan
 * JSON, or a suggestedPath guess) against the real workspace tree. Paths
 * that don't match any real file are simply absent from the result map —
 * callers fall back to manual selection rather than treating that as fatal,
 * since Copilot's path guesses are best-effort. */
export async function resolveWorkspaceFiles(
  rootHandle: FileSystemDirectoryHandle,
  paths: string[],
): Promise<Map<string, FileTreeNode>> {
  const all = await listWorkspaceFiles(rootHandle);
  const byPath = new Map(all.map((f) => [f.id, f]));
  const result = new Map<string, FileTreeNode>();
  for (const p of paths) {
    const node = byPath.get(p) ?? byPath.get(stripRootPrefix(p, rootHandle.name));
    if (node) result.set(p, node);
  }
  return result;
}

/** Creates a file (and any missing intermediate directories) at a
 * '/'-joined relative path and returns it as a FileTreeNode — used when
 * Copilot's response targets a file that doesn't exist yet (a new file the
 * plan/step is meant to create), since resolveWorkspaceFiles only matches
 * existing files by design. Idempotent: getFileHandle/getDirectoryHandle
 * with create:true just return the existing handle if already present. */
export async function ensureFileAtPath(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileTreeNode> {
  const segments = stripRootPrefix(relativePath, rootHandle.name)
    .split('/')
    .filter(Boolean);
  let dir = rootHandle;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  const name = segments[segments.length - 1];
  const handle = await dir.getFileHandle(name, { create: true });
  return { id: segments.join('/'), name, kind: 'file', pathSegments: segments, handle, parentHandle: dir };
}
