import { useEditorTabsStore } from '../state/editorTabsStore';
import type { FileTreeNode } from '../../shared/types';
import type { ExtractedCodeBlock } from './codeBlockParser';

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
