import type * as monaco from 'monaco-editor';

/** Builds the `file://` URI language servers expect for a workspace
 * file, from the same `'/'`-joined path-segment convention `workspaceStore.ts`
 * and `EditorTab.pathSegments` already use. `rootUri` comes from the LSP
 * `Ready` message (lsp-host's own launch directory — see
 * docs/lsp_protocol.md). Always forward slashes: this is a distinct
 * convention from resolveRelativeFilePath.ts's backslash-joined path, which
 * is for terminal run-commands, not LSP. */
export function pathSegmentsToUri(rootUri: string, pathSegments: string[]): string {
  const relative = pathSegments.map(encodeURIComponent).join('/');
  return `${rootUri.replace(/\/+$/, '')}/${relative}`;
}

/** Inverse of pathSegmentsToUri — used to resolve a language-server location
 * location (a `file://` URI) back to the workspace-relative path needed to
 * find/open the matching FSA file (see lspProviders.ts). Returns null for a
 * URI outside `rootUri` (e.g. a location in the Rust standard library's
 * source, which isn't part of this FSA workspace and can't be opened).
 *
 * The prefix check is case-insensitive: rust-analyzer may echo back a
 * different Windows drive-letter case than the `rootUri` lsp-host reported
 * (e.g. `file:///c:/...` vs `file:///C:/...` — both point at the same file
 * on a case-insensitive NTFS volume, but aren't byte-identical strings).
 * The actual path segments returned are sliced from the original, correctly
 * cased `uri` — not lowercased — since FSA's getFileHandle/getDirectoryHandle
 * do exact case-sensitive string matching against real on-disk names. */
export function uriToPathSegments(rootUri: string, uri: string): string[] | null {
  // Some language servers (notably Pyright on Windows) percent-encode the
  // drive-letter colon (`file:///e%3A/...`), while lsp-host's root URI is
  // commonly returned as `file:///E:/...`. Compare decoded file URIs so both
  // forms resolve to the same workspace-relative path.
  const decodeUri = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const decodedRootUri = decodeUri(rootUri).replace(/\\/g, '/');
  const decodedUri = decodeUri(uri).replace(/\\/g, '/');
  const prefix = `${decodedRootUri.replace(/\/+$/, '')}/`;
  if (
    decodedUri.length < prefix.length ||
    decodedUri.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()
  ) {
    return null;
  }
  return decodedUri
    .slice(prefix.length)
    .split('/');
}

/** Lowercased form of a `file://` URI, used only as an internal Map key for
 * matching a server-provided URI (diagnostics, definition results) against
 * one this client constructed itself — never for building a URI to send
 * back to the server or for deriving real file/directory names (see
 * uriToPathSegments's doc comment for why exact case matters there). */
export function normalizeUriKey(uri: string): string {
  return uri.toLowerCase();
}

// LSP positions/ranges are 0-based; Monaco's are 1-based.
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export function monacoPositionToLsp(position: monaco.IPosition): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function lspPositionToMonaco(position: LspPosition): monaco.IPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function lspRangeToMonaco(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
