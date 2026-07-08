import type { FileTreeNode } from '../../shared/types';

const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'target', '.dev-keys']);

function nodeId(pathSegments: string[]): string {
  return pathSegments.join('/');
}

export async function loadChildren(
  directoryHandle: FileSystemDirectoryHandle,
  parentPathSegments: string[],
  ignoredNames: Set<string> = DEFAULT_IGNORED_NAMES,
): Promise<FileTreeNode[]> {
  const nodes: FileTreeNode[] = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (ignoredNames.has(name)) continue;
    const pathSegments = [...parentPathSegments, name];
    if (handle.kind === 'directory') {
      nodes.push({
        id: nodeId(pathSegments),
        name,
        kind: 'directory',
        pathSegments,
        handle,
        parentHandle: directoryHandle,
        children: [],
        childrenLoaded: false,
      });
    } else {
      nodes.push({
        id: nodeId(pathSegments),
        name,
        kind: 'file',
        pathSegments,
        handle,
        parentHandle: directoryHandle,
      });
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}
