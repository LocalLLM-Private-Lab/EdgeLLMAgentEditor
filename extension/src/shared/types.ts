import type { TextEncodingId } from '../editor/fs/textEncodings';

export interface FileTreeNode {
  id: string;
  name: string;
  kind: 'file' | 'directory';
  pathSegments: string[];
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  /** The directory handle this node was loaded from — lets create/rename/delete
   * operate on the right folder without re-walking the tree by path. */
  parentHandle: FileSystemDirectoryHandle;
  children?: FileTreeNode[];
  childrenLoaded?: boolean;
}

export interface OpenFile {
  id: string;
  name: string;
  pathSegments: string[];
  fileHandle: FileSystemFileHandle;
  modelUri: string;
  isDirty: boolean;
  language: string;
  lastKnownDiskModified: number;
  encoding: TextEncodingId;
  eol: 'LF' | 'CRLF';
  /** VS Code's "preview tab" — a single-click open from the Explorer reuses
   * this tab's slot instead of always adding a new one, so browsing files
   * doesn't pile up permanent tabs. Editing the file, or opening it again
   * "for real" (double-click), pins it (false) like any other tab. */
  isPreview: boolean;
  /** 'image' tabs (png/jpg/gif/webp/bmp/ico/svg/avif — see
   * fs/fileKind.ts's imageMimeType) have no Monaco model at all and render
   * via ImageViewerPane.tsx instead of MonacoEditorPane.tsx; every other
   * field above still applies to them (pathSegments/fileHandle for
   * identity and close/rename, isDirty always false since they're never
   * edited) so tab-strip/close/rename code doesn't need its own branch —
   * only the handful of places that touch `model` or content need to
   * check `kind`. */
  kind: 'text' | 'image';
  /** Only set when `kind === 'image'` — the file's bytes as a data: URL,
   * handed straight to an `<img>` (see ImageViewerPane.tsx). */
  imageDataUrl?: string;
}
