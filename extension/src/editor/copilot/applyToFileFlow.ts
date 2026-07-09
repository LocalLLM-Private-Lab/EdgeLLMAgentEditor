import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import type { FileTreeNode } from '../../shared/types';
import type { ExtractedCodeBlock } from './codeBlockParser';
import { ensureFileAtPath } from './resolveWorkspaceFile';

/** Matches the target file's existing CRLF/LF convention — Copilot output
 * is typically LF-only, and Windows-authored files are often CRLF. */
function normalizeLineEndings(content: string, referenceContent: string): string {
  const referenceUsesCrlf = referenceContent.includes('\r\n');
  const unified = content.replace(/\r\n/g, '\n');
  return referenceUsesCrlf ? unified.replace(/\n/g, '\r\n') : unified;
}

export interface ApplyPreview {
  fileName: string;
  original: string;
  modified: string;
  language: string;
  apply: () => Promise<void>;
}

/** Prepares a diff preview for an already-open tab. */
export function prepareApplyToOpenTab(tabId: string, block: ExtractedCodeBlock): ApplyPreview | null {
  const tab = useEditorTabsStore.getState().openFiles.find((f) => f.id === tabId);
  if (!tab) return null;

  const original = tab.model.getValue();
  const modified = normalizeLineEndings(block.code, original);

  return {
    fileName: tab.name,
    original,
    modified,
    language: tab.language,
    apply: async () => {
      tab.model.setValue(modified);
      await useEditorTabsStore.getState().saveFile(tabId);
    },
  };
}

/** Prepares a diff preview for a tree node that isn't open yet — opens it
 * as a tab first so the same model/save path can be reused on accept. */
export async function prepareApplyToTreeNode(
  node: FileTreeNode,
  block: ExtractedCodeBlock,
): Promise<ApplyPreview | null> {
  if (node.kind !== 'file') return null;
  await useEditorTabsStore.getState().openFile(node);
  const tab = useEditorTabsStore
    .getState()
    .openFiles.find((f) => f.pathSegments.join('/') === node.id);
  if (!tab) return null;
  return prepareApplyToOpenTab(tab.id, block);
}

/** Prepares a diff preview for a file that doesn't exist yet (Copilot's
 * response targets a path that isn't in the workspace) — the file, and any
 * missing intermediate directories, are only actually created when the
 * user accepts the preview, not at preview time, so cancelling never
 * leaves a stray empty file behind. */
export function prepareApplyForNewFile(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
  block: ExtractedCodeBlock,
): ApplyPreview {
  return {
    fileName: relativePath,
    original: '',
    modified: block.code,
    language: block.language ?? 'plaintext',
    apply: async () => {
      const node = await ensureFileAtPath(rootHandle, relativePath);
      // Refreshing just the immediate parent only works if that directory
      // already existed in the tree — for a brand new nested path (e.g.
      // "src/viewer/Viewer.js" where "src" itself didn't exist yet), there
      // was no existing "src" node to attach the refreshed children to, so
      // the update silently no-opped and the new folder never appeared in
      // the sidebar. Refreshing from the root instead guarantees any new
      // top-level ancestor shows up, at the cost of collapsing other
      // expanded folders — an acceptable tradeoff for an occasional action.
      await useWorkspaceStore.getState().refreshDirectoryAt(rootHandle, []);
      await useEditorTabsStore.getState().openFile(node);
      const tab = useEditorTabsStore
        .getState()
        .openFiles.find((f) => f.pathSegments.join('/') === node.id);
      if (!tab) return;
      tab.model.setValue(block.code);
      await useEditorTabsStore.getState().saveFile(tab.id);
    },
  };
}
