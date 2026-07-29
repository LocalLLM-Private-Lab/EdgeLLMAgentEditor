import * as monaco from 'monaco-editor';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { FileTreeNode, OpenFile } from '../../shared/types';
import { getFileLastModified, readFileBytes, writeFileBytes } from '../fs/fsaWorkspace';
import { languageFromFilename } from '../monaco/languageRegistrations';
import { ensureLanguageTokenization } from '../monaco/textmateTokenization';
import { decodeBytes, detectEncodingFromBytes, encodeString, type TextEncodingId } from '../fs/textEncodings';
import { imageMimeType, looksBinary } from '../fs/fileKind';
import { bytesToBase64 } from '../terminal/wsTerminalClient';
import { useOpenAnywayPromptStore } from './openAnywayPromptStore';
import { useLspStore } from '../lsp/lspStore';
import { isLspLanguage } from '../lsp/lspLanguages';
import { pathSegmentsToUri } from '../lsp/uriTranslation';

function detectEol(content: string): 'LF' | 'CRLF' {
  return content.includes('\r\n') ? 'CRLF' : 'LF';
}

function eolSequence(eol: 'LF' | 'CRLF'): monaco.editor.EndOfLineSequence {
  return eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
}

/** Keyed by node.id (path) — de-dupes concurrent openFile() calls for the
 * same file (see openFile's comment for why a real double-click needs
 * this) so only one actual file-read/model-create ever runs per path at a
 * time. */
const pendingFileOpens = new Map<string, Promise<void>>();

export interface EditorTab extends OpenFile {
  /** Absent for `kind: 'image'` tabs — see OpenFile's `kind` doc comment. */
  model?: monaco.editor.ITextModel;
  /** Which editor group's tab strip this file currently belongs to — see
   * `groups`/`layout` below. A file lives in exactly one group at a time
   * (no "same file open twice" support, matching how `openFile` already
   * reveals an already-open file in place rather than duplicating it). */
  groupId: string;
}

export interface EditorGroup {
  id: string;
  activeFileId: string | null;
}

export type EditorSplitDirection = 'row' | 'column';

/** A split tree over editor groups — each split level holds an N-ary list
 * of same-direction siblings with independent sizes (not a nested pair of
 * two children), so a 3-way row split is genuinely [1, 2, 3] rather than
 * [1, [2, 3]]. That distinction matters for resizing: dragging the divider
 * between panes i and i+1 only trades size between those two — with a
 * nested-pair model, resizing the 1|2 divider would really be resizing the
 * outer split's ratio, which also (incorrectly) shifts the 2|3 boundary
 * since 2 and 3 both live inside that outer ratio's "second half". Genuine
 * 2D grids still nest (a row split can hold a column split as one of its
 * children) — only *same-direction* adjacency gets flattened. Independent
 * of the terminal/Copilot dock system's own (fixed 4-zone, 2-panel)
 * layout — deliberately so, since source files and dock panels are never
 * meant to land in the same drop target. */
export type EditorLayoutNode =
  | { type: 'leaf'; groupId: string }
  | { type: 'split'; id: string; direction: EditorSplitDirection; children: EditorLayoutNode[]; sizes: number[] };

const MAIN_GROUP_ID = 'main';

interface EditorTabsState {
  openFiles: EditorTab[];
  activeFileId: string | null;
  /** Simple file-level "which tab was active" history (not per-cursor —
   * standalone Monaco has no cross-file navigation stack built in). Global
   * across all groups, same as VS Code's single window-wide history. */
  navHistory: string[];
  navIndex: number;

  groups: Record<string, EditorGroup>;
  layout: EditorLayoutNode;
  /** Whichever group last had focus — `activeFileId` above always mirrors
   * `groups[focusedGroupId].activeFileId`, kept in sync on every action
   * that touches focus, so every pre-existing caller that reads the plain
   * `activeFileId` field (save button, status bar, Copilot's "insert into
   * active file", quick-open, LSP go-to-definition, ...) keeps working
   * unchanged — none of them need to know groups exist at all. */
  focusedGroupId: string;
  /** File currently mid-drag from a group's tab strip, so EditorDragOverlay
   * knows to compute and show a drop target. Not persisted. */
  draggingTab: string | null;
  /** Live pointer position while dragging, driven by pointermove on the
   * tab being dragged — same plain-Pointer-Events approach as the dock
   * system's DraggableTab (native HTML5 DnD proved unreliable there; no
   * reason to repeat that mistake here). Not persisted. */
  pointerPosition: { x: number; y: number } | null;

  /** `preview: true` (Explorer single-click) opens in VS Code's preview
   * slot — reuses/replaces whatever preview tab already exists in the
   * target group instead of adding a new one, and gets pinned into a
   * normal tab automatically on first edit or on a subsequent non-preview
   * open of the same file. Every other caller (Quick Open, "apply to
   * file", go-to-definition, ...) omits this and opens permanently, same
   * as before this existed. */
  openFile: (node: FileTreeNode, options?: { preview?: boolean }) => Promise<void>;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  /** Pins an already-open preview tab (double-clicking it in the tab strip
   * itself, mirroring the Explorer's double-click-to-pin) — a no-op for a
   * tab that's already permanent. */
  pinTab: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  closeFilesByPathPrefix: (pathPrefix: string[]) => void;
  /** Tab-context-menu operations, all scoped to one group's own tab strip
   * (matching VS Code — "Close Others"/"Close to the Right" never reach
   * across into a different split group). */
  closeOtherTabsInGroup: (groupId: string, keepId: string) => void;
  closeTabsToRightInGroup: (groupId: string, id: string) => void;
  closeAllTabsInGroup: (groupId: string) => void;
  renameOpenFile: (oldPathSegments: string[], newName: string) => void;
  /** 'reopen' re-decodes the on-disk bytes with the given encoding, discarding
   * any unsaved changes (confirms first if dirty). 'resave' only changes what
   * encoding the *next* save will use, without touching the current content. */
  setFileEncoding: (id: string, encoding: TextEncodingId, mode: 'reopen' | 'resave') => Promise<void>;
  setFileEol: (id: string, eol: 'LF' | 'CRLF') => void;

  setFocusedGroup: (groupId: string) => void;
  setDraggingTab: (fileId: string | null) => void;
  setPointerPosition: (x: number, y: number) => void;
  /** Joins `fileId` into `toGroupId`'s tab strip (an existing *other*
   * group) — used for "drop on the center of an existing group". */
  /** Joins `fileId` into `toGroupId`'s tab strip — appended at the end by
   * default, or inserted immediately before `beforeFileId` when given (also
   * how same-group tab reordering works: toGroupId is just the tab's own
   * current group, and beforeFileId is whichever tab it was dropped on). */
  moveTabToGroup: (fileId: string, toGroupId: string, beforeFileId?: string | null) => void;
  /** Splits `targetGroupId` into two groups so a brand-new group holding
   * just `fileId` sits alongside it. `edge` is which side of the existing
   * group's body the drag landed on (top/bottom -> column, left/right ->
   * row; dropped on top/left -> the new group goes first). Dragging a
   * group's only tab onto that same group's own edge is a no-op — see the
   * guard inline, the same class of bug the dock system's splitPanel had
   * to be fixed for (dropping a lone tab on itself must never conjure up
   * a phantom second pane). */
  splitGroupWithTab: (fileId: string, targetGroupId: string, edge: 'top' | 'bottom' | 'left' | 'right') => void;
  /** Resizes the divider between panes `index` and `index+1` in the split
   * `splitId` — only those two neighbors trade size; every other sibling
   * (e.g. a 3rd pane elsewhere in the same row) is untouched. */
  resizeLayoutPane: (splitId: string, index: number, newSizeAtIndex: number) => void;
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

/** Focuses whichever group `id` lives in and makes it that group's active
 * tab — the one place that keeps `focusedGroupId`/`groups[*].activeFileId`
 * /the top-level `activeFileId` mirror all in agreement. Returns null if
 * `id` isn't an open tab (e.g. a stale nav-history entry for a since-closed
 * file). */
function focusFileState(
  state: Pick<EditorTabsState, 'openFiles' | 'groups'>,
  id: string,
): Pick<EditorTabsState, 'groups' | 'focusedGroupId' | 'activeFileId'> | null {
  const tab = state.openFiles.find((f) => f.id === id);
  if (!tab) return null;
  return {
    groups: { ...state.groups, [tab.groupId]: { ...state.groups[tab.groupId], activeFileId: id } },
    focusedGroupId: tab.groupId,
    activeFileId: id,
  };
}

/** If `groupId`'s current active tab is about to depart (per `isDeparting`),
 * falls back to whichever other tab still in that group (per
 * `remainingOpenFiles`, already filtered to exclude departing tabs) was
 * opened most recently — mirrors dockStore's reassignActiveInZone for the
 * same reason: the active-tab pointer must never be left referencing
 * something no longer in the group. */
function reassignGroupActiveFile(
  remainingOpenFiles: EditorTab[],
  groups: Record<string, EditorGroup>,
  groupId: string,
  isDeparting: (fileId: string) => boolean,
): Record<string, EditorGroup> {
  const group = groups[groupId];
  if (!group || !group.activeFileId || !isDeparting(group.activeFileId)) return groups;
  const remaining = remainingOpenFiles.filter((f) => f.groupId === groupId);
  const nextActive = remaining[remaining.length - 1]?.id ?? null;
  return { ...groups, [groupId]: { ...group, activeFileId: nextActive } };
}

function containsGroupId(node: EditorLayoutNode, groupId: string): boolean {
  if (node.type === 'leaf') return node.groupId === groupId;
  return node.children.some((c) => containsGroupId(c, groupId));
}

/** Inserts `newLeaf` next to `targetGroupId` (before or after it) in
 * `direction`. If `targetGroupId` is already a direct sibling in a split
 * running the *same* direction, the new leaf is added as another sibling
 * there (flat [1, 2, 3, ...]) instead of nesting a new split inside — see
 * the EditorLayoutNode doc comment for why that distinction matters. A
 * perpendicular split (different direction) still nests, same as before,
 * since that's a genuine 2D grid case, not just "one more column". */
function insertNextToLeaf(
  node: EditorLayoutNode,
  targetGroupId: string,
  direction: EditorSplitDirection,
  newLeaf: EditorLayoutNode,
  after: boolean,
): EditorLayoutNode {
  if (node.type === 'leaf') {
    if (node.groupId !== targetGroupId) return node;
    return {
      type: 'split',
      id: uuid(),
      direction,
      children: after ? [node, newLeaf] : [newLeaf, node],
      sizes: [0.5, 0.5],
    };
  }

  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.groupId === targetGroupId);
  if (idx !== -1) {
    if (node.direction === direction) {
      const targetSize = node.sizes[idx];
      const half = targetSize / 2;
      const sizes = [...node.sizes];
      sizes[idx] = half;
      const insertAt = after ? idx + 1 : idx;
      sizes.splice(insertAt, 0, half);
      const children = [...node.children];
      children.splice(insertAt, 0, newLeaf);
      return { ...node, children, sizes };
    }
    // Perpendicular split — nest just that one child.
    const children = [...node.children];
    children[idx] = insertNextToLeaf(node.children[idx], targetGroupId, direction, newLeaf, after);
    return { ...node, children };
  }

  return {
    ...node,
    children: node.children.map((c) =>
      containsGroupId(c, targetGroupId) ? insertNextToLeaf(c, targetGroupId, direction, newLeaf, after) : c,
    ),
  };
}

/** Removes `groupId`'s leaf from the tree. With exactly one sibling left
 * afterward, that sibling is promoted into the parent split's own place
 * (collapsing the now-pointless split); with more than one, the removed
 * pane's size is redistributed proportionally among the rest so they keep
 * their relative proportions rather than leaving a gap. Assumes `groupId`
 * is present and is not the tree's only leaf (callers only call this
 * after confirming more than one group remains). */
function removeLeaf(node: EditorLayoutNode, groupId: string): EditorLayoutNode {
  if (node.type === 'leaf') return node;
  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.groupId === groupId);
  if (idx !== -1) {
    if (node.children.length === 2) return node.children[1 - idx];
    const removedSize = node.sizes[idx];
    const children = node.children.filter((_, i) => i !== idx);
    const remainingSizes = node.sizes.filter((_, i) => i !== idx);
    const totalRemaining = remainingSizes.reduce((a, b) => a + b, 0);
    const sizes = remainingSizes.map((s) => s + (removedSize * s) / totalRemaining);
    return { ...node, children, sizes };
  }
  return {
    ...node,
    children: node.children.map((c) => (containsGroupId(c, groupId) ? removeLeaf(c, groupId) : c)),
  };
}

function firstGroupId(node: EditorLayoutNode): string {
  return node.type === 'leaf' ? node.groupId : firstGroupId(node.children[0]);
}

/** Resizes the divider between panes `index` and `index+1` of the split
 * `splitId` — trades size only between those two immediate neighbors
 * (their combined size stays constant), leaving every other sibling's
 * size untouched. `newSizeAtIndex` is clamped so neither of the pair
 * shrinks below a usable minimum. */
function resizeAdjacentPanes(node: EditorLayoutNode, splitId: string, index: number, newSizeAtIndex: number): EditorLayoutNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) {
    const pairSum = node.sizes[index] + node.sizes[index + 1];
    const MIN_PANE_SIZE = 0.08;
    const clamped = Math.min(Math.max(newSizeAtIndex, MIN_PANE_SIZE), pairSum - MIN_PANE_SIZE);
    const sizes = [...node.sizes];
    sizes[index] = clamped;
    sizes[index + 1] = pairSum - clamped;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => resizeAdjacentPanes(c, splitId, index, newSizeAtIndex)) };
}

/** Disposes each tab's Monaco model and unregisters it from the LSP session
 * (if any) — the non-React-state half of closing a tab, shared by every
 * close* action below since none of them can skip it. */
function disposeAndUnregisterTabs(tabs: EditorTab[]): void {
  const rootUri = useLspStore.getState().rootUri;
  for (const tab of tabs) {
    if (tab.kind !== 'text') continue; // image tabs have no model, were never LSP-registered
    if (isLspLanguage(tab.language) && rootUri) {
      useLspStore.getState().unregisterDocument(pathSegmentsToUri(rootUri, tab.pathSegments));
    }
    tab.model?.dispose();
  }
}

/** Shared by closeFile/closeFilesByPathPrefix: removes the given tabs,
 * reassigns each affected group's active tab, and collapses any group
 * left with zero tabs out of the layout tree (unless it's the only group
 * left, in which case it just sits empty — same as the pre-groups
 * behavior of `openFiles` going empty). */
function closeTabsAndCleanupGroups(
  state: EditorTabsState,
  idsToClose: Set<string>,
): Pick<EditorTabsState, 'openFiles' | 'groups' | 'layout' | 'focusedGroupId' | 'activeFileId'> {
  const closedTabs = state.openFiles.filter((f) => idsToClose.has(f.id));
  const openFiles = state.openFiles.filter((f) => !idsToClose.has(f.id));
  let groups = state.groups;
  let layout = state.layout;
  const affectedGroupIds = new Set(closedTabs.map((t) => t.groupId));

  for (const groupId of affectedGroupIds) {
    groups = reassignGroupActiveFile(openFiles, groups, groupId, (fid) => idsToClose.has(fid));
    const remaining = openFiles.filter((f) => f.groupId === groupId);
    if (remaining.length === 0 && Object.keys(groups).length > 1) {
      layout = removeLeaf(layout, groupId);
      const { [groupId]: _removed, ...rest } = groups;
      groups = rest;
    }
  }

  let focusedGroupId = state.focusedGroupId;
  let activeFileId = state.activeFileId;
  if (!groups[focusedGroupId]) {
    focusedGroupId = firstGroupId(layout);
    activeFileId = groups[focusedGroupId]?.activeFileId ?? null;
  } else if (affectedGroupIds.has(focusedGroupId)) {
    activeFileId = groups[focusedGroupId].activeFileId;
  }

  return { openFiles, groups, layout, focusedGroupId, activeFileId };
}

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  openFiles: [],
  activeFileId: null,
  navHistory: [],
  navIndex: -1,

  groups: { [MAIN_GROUP_ID]: { id: MAIN_GROUP_ID, activeFileId: null } },
  layout: { type: 'leaf', groupId: MAIN_GROUP_ID },
  focusedGroupId: MAIN_GROUP_ID,
  draggingTab: null,
  pointerPosition: null,

  openFile: async (node: FileTreeNode, options?: { preview?: boolean }) => {
    if (node.kind !== 'file') return;
    const preview = options?.preview ?? false;

    function focusExisting(existingId: string) {
      set((state) => {
        const focus = focusFileState(state, existingId);
        const existingTab = state.openFiles.find((f) => f.id === existingId);
        // A non-preview (e.g. double-click) open of an already-open
        // preview tab pins it, same as VS Code — opening it again "for
        // real" is exactly the signal that it shouldn't be replaceable
        // anymore.
        const openFiles =
          !preview && existingTab?.isPreview
            ? state.openFiles.map((f) => (f.id === existingId ? { ...f, isPreview: false } : f))
            : state.openFiles;
        // pushHistory returns the *whole* state unchanged (not just
        // {navHistory, navIndex}) when the history already points at this
        // id — spreading it after `openFiles` here would silently clobber
        // the just-computed pin/no-pin update with that stale copy, so
        // `openFiles` has to come last.
        return { ...(focus ?? {}), ...pushHistory(state, existingId), openFiles };
      });
    }

    const existing = get().openFiles.find((f) => f.pathSegments.join('/') === node.id);
    if (existing) {
      focusExisting(existing.id);
      return;
    }

    // A real double-click fires click, click, then dblclick in a burst —
    // each of FileTree's handlers calls openFile for the very same file,
    // and without de-duping they'd race: a later call's "already open?"
    // check above can run before an earlier call's file read even
    // resolves, so each would independently read the file and create its
    // own model/tab. Collapsing concurrent opens of the same path into one
    // actual load — with later callers just waiting for it, then applying
    // their own preview/permanent intent on top — makes that race
    // structurally impossible instead of papering over its symptoms.
    const pending = pendingFileOpens.get(node.id);
    if (pending) {
      await pending;
      const nowOpen = get().openFiles.find((f) => f.pathSegments.join('/') === node.id);
      if (nowOpen) focusExisting(nowOpen.id);
      return;
    }

    const loadPromise = (async () => {
      // Captured up front (rather than re-read at the end) so the new tab
      // lands in whichever group was focused when the user asked to open
      // it, even though the group could theoretically change focus during
      // the await below.
      const groupId = get().focusedGroupId;

      const fileHandle = node.handle as FileSystemFileHandle;
      const [bytes, lastModified] = await Promise.all([
        readFileBytes(fileHandle),
        getFileLastModified(fileHandle),
      ]);

      // Inserts a finished tab (image or text) into the tab strip — shared
      // by both branches below since the "reuse the group's preview slot"
      // logic doesn't care which kind of tab it's inserting.
      function insertTab(tab: EditorTab) {
        const existingPreviewTab = preview
          ? get().openFiles.find((f) => f.groupId === groupId && f.isPreview)
          : undefined;
        if (existingPreviewTab) disposeAndUnregisterTabs([existingPreviewTab]);

        set((state) => ({
          openFiles: existingPreviewTab
            ? state.openFiles.map((f) => (f.id === existingPreviewTab.id ? tab : f))
            : [...state.openFiles, tab],
          groups: { ...state.groups, [groupId]: { ...state.groups[groupId], activeFileId: tab.id } },
          focusedGroupId: groupId,
          activeFileId: tab.id,
          ...pushHistory(state, tab.id),
        }));
      }

      const mimeType = imageMimeType(node.name);
      if (mimeType) {
        const id = uuid();
        insertTab({
          id,
          name: node.name,
          pathSegments: node.pathSegments,
          fileHandle,
          modelUri: `image://${id}`,
          isDirty: false,
          language: 'plaintext',
          lastKnownDiskModified: lastModified,
          encoding: 'utf-8',
          eol: 'LF',
          groupId,
          isPreview: preview,
          kind: 'image',
          imageDataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
        });
        return;
      }

      // A NUL byte in the leading bytes means this almost certainly isn't
      // meant to be read as text (see fs/fileKind.ts's looksBinary) — ask
      // before decoding it as UTF-8-with-replacement-characters garbage
      // that would silently corrupt the file if ever saved. Declining
      // aborts entirely: no tab, nothing to clean up (pendingFileOpens'
      // finally block still runs via the outer try/finally).
      if (looksBinary(bytes)) {
        const openAnyway = await useOpenAnywayPromptStore.getState().request(node.name);
        if (!openAnyway) return;
      }

      const encoding = detectEncodingFromBytes(bytes);
      const content = decodeBytes(bytes, encoding);
      const eol = detectEol(content);
      const language = languageFromFilename(node.name);
      await ensureLanguageTokenization(language);
      const id = uuid();
      const modelUri = monaco.Uri.parse(`inmemory://workspace/${id}`);
      const model = monaco.editor.createModel(content, language, modelUri);
      // Monaco settles on whichever EOL is more frequent in the buffer by
      // default — pin it to the detected one explicitly so a file that's
      // (say) all-CRLF-but-one-stray-LF-line still round-trips consistently,
      // and so getValue() on save reliably emits the original style.
      model.setEOL(eolSequence(eol));

      const tab: EditorTab = {
        id,
        name: node.name,
        pathSegments: node.pathSegments,
        fileHandle,
        modelUri: modelUri.toString(),
        isDirty: false,
        language,
        lastKnownDiskModified: lastModified,
        encoding,
        eol,
        model,
        groupId,
        isPreview: preview,
        kind: 'text',
      };

      model.onDidChangeContent(() => {
        const state = get();
        const tabNow = state.openFiles.find((f) => f.id === id);
        // Editing a preview tab pins it too — same first-edit guard as
        // isDirty (a preview tab always starts clean, so this only ever
        // fires once), otherwise a preview tab you're actively typing into
        // could still get silently replaced/disposed by browsing to
        // another file in the Explorer.
        if (tabNow && !tabNow.isDirty) {
          set({
            openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, isDirty: true, isPreview: false } : f)),
          });
        }
        if (isLspLanguage(language)) {
          const rootUri = useLspStore.getState().rootUri;
          if (rootUri) {
            useLspStore.getState().notifyDidChange(pathSegmentsToUri(rootUri, node.pathSegments), language);
          }
        }
      });

      // Lazily starts (or reuses) the language-server session for
      // supported languages, then sends textDocument/didOpen.
      // Fire-and-forget keeps a missing external server from blocking
      // file opening; the status bar surfaces the launch error.
      if (isLspLanguage(language)) {
        void (async () => {
          try {
            await useLspStore.getState().ensureSession(language);
          } catch {
            return;
          }
          const rootUri = useLspStore.getState().rootUri;
          if (!rootUri) return;
          useLspStore.getState().registerDocument(pathSegmentsToUri(rootUri, node.pathSegments), model, language);
        })();
      }

      insertTab(tab);
    })();

    pendingFileOpens.set(node.id, loadPromise);
    try {
      await loadPromise;
    } finally {
      pendingFileOpens.delete(node.id);
    }
  },

  closeFile: (id: string) => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (tab) disposeAndUnregisterTabs([tab]);
    set((state) => closeTabsAndCleanupGroups(state, new Set([id])));
  },

  setActiveFile: (id: string) =>
    set((state) => {
      const focus = focusFileState(state, id);
      return focus ? { ...focus, ...pushHistory(state, id) } : state;
    }),

  pinTab: (id: string) =>
    set((state) => ({
      openFiles: state.openFiles.map((f) => (f.id === id && f.isPreview ? { ...f, isPreview: false } : f)),
    })),

  goBack: () => {
    const { navHistory, navIndex } = get();
    if (navIndex <= 0) return;
    const newIndex = navIndex - 1;
    const id = navHistory[newIndex];
    set((state) => ({ navIndex: newIndex, ...(focusFileState(state, id) ?? {}) }));
  },

  goForward: () => {
    const { navHistory, navIndex } = get();
    if (navIndex >= navHistory.length - 1) return;
    const newIndex = navIndex + 1;
    const id = navHistory[newIndex];
    set((state) => ({ navIndex: newIndex, ...(focusFileState(state, id) ?? {}) }));
  },

  saveFile: async (id: string) => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab || tab.kind !== 'text' || !tab.model) return; // image tabs are never edited/dirty — nothing to save

    const diskModified = await getFileLastModified(tab.fileHandle);
    if (diskModified !== tab.lastKnownDiskModified) {
      const overwrite = window.confirm(
        `${tab.name} はディスク上で変更されています。上書き保存しますか？`,
      );
      if (!overwrite) return;
    }

    await writeFileBytes(tab.fileHandle, encodeString(tab.model.getValue(), tab.encoding));
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
    disposeAndUnregisterTabs(toClose);
    set((state) => closeTabsAndCleanupGroups(state, new Set(toClose.map((t) => t.id))));
  },

  closeOtherTabsInGroup: (groupId: string, keepId: string) => {
    const toClose = tabsInGroup(get().openFiles, groupId).filter((f) => f.id !== keepId);
    disposeAndUnregisterTabs(toClose);
    set((state) => closeTabsAndCleanupGroups(state, new Set(toClose.map((t) => t.id))));
  },

  closeTabsToRightInGroup: (groupId: string, id: string) => {
    const tabs = tabsInGroup(get().openFiles, groupId);
    const idx = tabs.findIndex((t) => t.id === id);
    const toClose = idx === -1 ? [] : tabs.slice(idx + 1);
    disposeAndUnregisterTabs(toClose);
    set((state) => closeTabsAndCleanupGroups(state, new Set(toClose.map((t) => t.id))));
  },

  closeAllTabsInGroup: (groupId: string) => {
    const toClose = tabsInGroup(get().openFiles, groupId);
    disposeAndUnregisterTabs(toClose);
    set((state) => closeTabsAndCleanupGroups(state, new Set(toClose.map((t) => t.id))));
  },

  // Only updates an exact match (the renamed file itself, not files nested
  // under a renamed folder — their pathSegments go stale cosmetically, but
  // the underlying handles keep working since FSA moves are handle-based).
  renameOpenFile: (oldPathSegments: string[], newName: string) => {
    set((state) => ({
      openFiles: state.openFiles.map((f) => {
        if (f.pathSegments.join('/') !== oldPathSegments.join('/')) return f;
        const newPathSegments = [...f.pathSegments.slice(0, -1), newName];
        // Image tabs have no model/language to update — just relocate.
        if (f.kind !== 'text') return { ...f, name: newName, pathSegments: newPathSegments };
        const oldLanguage = f.language;
        const language = languageFromFilename(newName);
        const rootUri = useLspStore.getState().rootUri;
        if (isLspLanguage(oldLanguage) && rootUri) {
          useLspStore.getState().unregisterDocument(pathSegmentsToUri(rootUri, f.pathSegments));
        }
        void ensureLanguageTokenization(language);
        const model = f.model;
        if (model) monaco.editor.setModelLanguage(model, language);
        if (isLspLanguage(language) && model) {
          void (async () => {
            try {
              await useLspStore.getState().ensureSession(language);
            } catch {
              return;
            }
            const nextRootUri = useLspStore.getState().rootUri;
            if (nextRootUri) {
              useLspStore
                .getState()
                .registerDocument(pathSegmentsToUri(nextRootUri, newPathSegments), model, language);
            }
          })();
        }
        return { ...f, name: newName, pathSegments: newPathSegments, language };
      }),
    }));
  },

  setFileEncoding: async (id: string, encoding: TextEncodingId, mode: 'reopen' | 'resave') => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab || tab.kind !== 'text') return;

    if (mode === 'resave') {
      set((state) => ({
        openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, encoding, isDirty: true } : f)),
      }));
      return;
    }

    if (tab.isDirty) {
      const discard = window.confirm(
        `${tab.name} には未保存の変更があります。別のエンコーディングで開き直すと、その変更は破棄されます。続行しますか？`,
      );
      if (!discard) return;
    }

    if (!tab.model) return;
    const bytes = await readFileBytes(tab.fileHandle);
    const content = decodeBytes(bytes, encoding);
    const eol = detectEol(content);
    tab.model.setValue(content);
    tab.model.setEOL(eolSequence(eol));
    const lastModified = await getFileLastModified(tab.fileHandle);
    set((state) => ({
      openFiles: state.openFiles.map((f) =>
        f.id === id
          ? { ...f, encoding, eol, isDirty: false, lastKnownDiskModified: lastModified }
          : f,
      ),
    }));
  },

  setFileEol: (id: string, eol: 'LF' | 'CRLF') => {
    const tab = get().openFiles.find((f) => f.id === id);
    if (!tab || tab.eol === eol || !tab.model) return;
    tab.model.setEOL(eolSequence(eol));
    set((state) => ({
      openFiles: state.openFiles.map((f) => (f.id === id ? { ...f, eol, isDirty: true } : f)),
    }));
  },

  setFocusedGroup: (groupId: string) =>
    set((state) => {
      if (!state.groups[groupId]) return state;
      return { focusedGroupId: groupId, activeFileId: state.groups[groupId].activeFileId };
    }),

  setDraggingTab: (fileId: string | null) =>
    set((state) => ({ draggingTab: fileId, pointerPosition: fileId ? state.pointerPosition : null })),

  setPointerPosition: (x: number, y: number) => set({ pointerPosition: { x, y } }),

  moveTabToGroup: (fileId: string, toGroupId: string, beforeFileId?: string | null) => {
    set((state) => {
      const tab = state.openFiles.find((f) => f.id === fileId);
      if (!tab || !state.groups[toGroupId]) return state;
      // Dropped directly on itself is always a no-op. A same-group call
      // with beforeFileId *omitted* (undefined, from the "join" drop
      // action — no position was ever requested) is also a no-op when
      // already there. beforeFileId === null is different: it's the
      // "reorder" drop action's explicit "move to the very end" request,
      // and must go through even though it looks the same as "no target"
      // at a glance — skipping it here previously made dragging a tab
      // onto the last slot of its own strip silently do nothing.
      if (beforeFileId === fileId) return state;
      if (beforeFileId === undefined && tab.groupId === toGroupId) return state;

      const fromGroupId = tab.groupId;
      const withoutTab = state.openFiles.filter((f) => f.id !== fileId);
      const movedTab: EditorTab = { ...tab, groupId: toGroupId };
      const insertAt = beforeFileId ? withoutTab.findIndex((f) => f.id === beforeFileId) : -1;
      const openFiles =
        insertAt === -1
          ? [...withoutTab, movedTab]
          : [...withoutTab.slice(0, insertAt), movedTab, ...withoutTab.slice(insertAt)];

      let groups: Record<string, EditorGroup> = {
        ...state.groups,
        [toGroupId]: { ...state.groups[toGroupId], activeFileId: fileId },
      };
      let layout = state.layout;
      if (fromGroupId !== toGroupId) {
        groups = reassignGroupActiveFile(openFiles, groups, fromGroupId, (fid) => fid === fileId);
        const remainingInFrom = openFiles.filter((f) => f.groupId === fromGroupId);
        if (remainingInFrom.length === 0) {
          layout = removeLeaf(layout, fromGroupId);
          const { [fromGroupId]: _removed, ...rest } = groups;
          groups = rest;
        }
      }
      return { openFiles, groups, layout, focusedGroupId: toGroupId, activeFileId: fileId };
    });
  },

  splitGroupWithTab: (fileId: string, targetGroupId: string, edge: 'top' | 'bottom' | 'left' | 'right') => {
    const state = get();
    const tab = state.openFiles.find((f) => f.id === fileId);
    if (!tab) return;
    const sourceGroupId = tab.groupId;
    // A group's own lone tab has nothing to split against — same guard as
    // the dock system's splitPanel, for the same reason (dropping a tab on
    // its own single-occupant edge must be a no-op, not conjure a second
    // pane out of thin air).
    if (sourceGroupId === targetGroupId) {
      const countInGroup = state.openFiles.filter((f) => f.groupId === targetGroupId).length;
      if (countInGroup < 2) return;
    }

    const newGroupId = uuid();
    const direction: EditorSplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column';
    const draggedFirst = edge === 'top' || edge === 'left';
    const newLeaf: EditorLayoutNode = { type: 'leaf', groupId: newGroupId };

    set((s) => {
      const openFiles = s.openFiles.map((f) => (f.id === fileId ? { ...f, groupId: newGroupId } : f));
      let groups: Record<string, EditorGroup> = {
        ...s.groups,
        [newGroupId]: { id: newGroupId, activeFileId: fileId },
      };
      groups = reassignGroupActiveFile(openFiles, groups, sourceGroupId, (fid) => fid === fileId);
      let layout = insertNextToLeaf(s.layout, targetGroupId, direction, newLeaf, !draggedFirst);
      if (sourceGroupId !== targetGroupId) {
        const remainingInSource = openFiles.filter((f) => f.groupId === sourceGroupId);
        if (remainingInSource.length === 0) {
          layout = removeLeaf(layout, sourceGroupId);
          const { [sourceGroupId]: _removed, ...rest } = groups;
          groups = rest;
        }
      }
      return { openFiles, groups, layout, focusedGroupId: newGroupId, activeFileId: fileId };
    });
  },

  resizeLayoutPane: (splitId: string, index: number, newSizeAtIndex: number) =>
    set((state) => ({ layout: resizeAdjacentPanes(state.layout, splitId, index, newSizeAtIndex) })),
}));

/** Files currently open in `groupId`, in a stable order. */
export function tabsInGroup(openFiles: EditorTab[], groupId: string): EditorTab[] {
  return openFiles.filter((f) => f.groupId === groupId);
}

// Re-registers currently open documents after a language-server session is
// restarted against a different root. Each language reports its own ready
// event on the multiplexed connection, so only that language's documents are
// sent after its initialize handshake completes.
let syncedLspRootUri: string | null = null;
const syncedLspLanguages = new Set<string>();
useLspStore.subscribe((state) => {
  if (state.status !== 'ready' || !state.rootUri || !state.readyLanguage || !isLspLanguage(state.readyLanguage)) return;
  const rootChanged = state.rootUri !== syncedLspRootUri;
  const hadPreviousRoot = syncedLspRootUri !== null;
  if (rootChanged) syncedLspLanguages.clear();
  syncedLspRootUri = state.rootUri;
  if (syncedLspLanguages.has(state.readyLanguage)) return;
  syncedLspLanguages.add(state.readyLanguage);
  // The first session for a language is registered by openFile() after its
  // ensureSession() promise resolves. Re-registering here on that initial
  // handshake would send duplicate didOpen notifications. A root change is
  // different: tracked documents were intentionally cleared, so they must
  // be restored here after the new server initializes.
  if (!hadPreviousRoot || !rootChanged) return;

  const rootUri = state.rootUri;
  for (const tab of useEditorTabsStore.getState().openFiles) {
    if (tab.language !== state.readyLanguage || !tab.model) continue;
    useLspStore.getState().registerDocument(pathSegmentsToUri(rootUri, tab.pathSegments), tab.model, tab.language);
  }
});
