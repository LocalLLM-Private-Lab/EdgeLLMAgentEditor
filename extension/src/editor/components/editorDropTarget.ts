import { regionFromPointer, halfRect, insetRect, toDropRect, type DropRect, type Edge } from './dropGeometry';

export type EditorDropAction =
  // Dropped on the center of an existing group's body — join as a tab there.
  | { kind: 'join'; groupId: string }
  // Dropped on an edge of an existing group's body — splits that group.
  | { kind: 'split'; groupId: string; edge: Edge }
  // Dropped directly on another tab — reorder into that group's tab strip
  // at that position (same group == pure reorder; different group == move
  // there at a specific spot instead of always appending at the end).
  | { kind: 'reorder'; groupId: string; beforeFileId: string | null };

export interface EditorDropTarget {
  rect: DropRect;
  action: EditorDropAction;
}

/**
 * The editor area's own drop-target geometry — a sibling of dockDropTarget's
 * computeDropTarget, not built on top of it. Only queries `.editor-group-body`
 * elements inside the editor area, and never falls back to "empty space near
 * an outer edge" the way the dock system does (the editor area is always
 * fully covered by at least one group). Kept as a wholly separate function
 * so a source-file drag can never resolve to a dock zone or vice versa —
 * source code and the terminal/Copilot dock are two independent drag
 * systems by construction, not just by convention.
 */
export function computeEditorDropTarget(
  clientX: number,
  clientY: number,
  draggingFileId?: string | null,
): EditorDropTarget | null {
  // 0. Directly over another tab (in any group's strip)? Left half = insert
  // before it, right half = insert after (i.e. before whatever tab follows
  // it, or at the end if it's the last one). Checked before the group-body
  // pass below since it's the more specific target — tab strips and group
  // bodies never overlap on screen, so order between the two doesn't
  // actually matter for correctness, only for readability.
  for (const tabEl of document.querySelectorAll<HTMLElement>('.editor-tab[data-file-id]')) {
    const tabId = tabEl.dataset.fileId;
    if (!tabId || tabId === draggingFileId) continue;
    const rect = tabEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const groupEl = tabEl.closest<HTMLElement>('.editor-group');
    const groupId = groupEl?.dataset.groupId;
    if (!groupId) continue;
    const before = clientX - rect.left < rect.width / 2;
    const beforeFileId = before ? tabId : ((tabEl.nextElementSibling as HTMLElement | null)?.dataset.fileId ?? null);
    const barX = before ? rect.left : rect.right;
    return {
      rect: { left: barX - 1.5, top: rect.top, width: 3, height: rect.height },
      action: { kind: 'reorder', groupId, beforeFileId },
    };
  }

  // 0.5. Empty space in a tab strip (past the last tab, or in the gap
  // before the first one) — not caught by the per-tab check above since
  // it isn't over any specific tab. VS Code treats this as "insert at the
  // end of this tab strip", same as dropping directly on the last tab's
  // right half — never a split (splitting only makes sense from an edge
  // of the actual editor content, not empty tab-bar padding).
  for (const tabsEl of document.querySelectorAll<HTMLElement>('.editor-group-tabs')) {
    const rect = tabsEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const groupEl = tabsEl.closest<HTMLElement>('.editor-group');
    const groupId = groupEl?.dataset.groupId;
    if (!groupId || !groupEl) continue;
    const otherTabs = [...tabsEl.querySelectorAll<HTMLElement>('.editor-tab[data-file-id]')].filter(
      (el) => el.dataset.fileId !== draggingFileId,
    );
    // Nothing else in this strip to reorder against — same rule as the
    // split branches below (dragging a group's only tab onto its own
    // empty space is a no-op, not a self-split).
    if (otherTabs.length === 0) return null;
    const lastRect = otherTabs[otherTabs.length - 1].getBoundingClientRect();
    return {
      rect: { left: lastRect.right - 1.5, top: lastRect.top, width: 3, height: lastRect.height },
      action: { kind: 'reorder', groupId, beforeFileId: null },
    };
  }

  for (const bodyEl of document.querySelectorAll<HTMLElement>('.editor-group-body')) {
    const rect = bodyEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const groupEl = bodyEl.closest<HTMLElement>('.editor-group');
    const groupId = groupEl?.dataset.groupId;
    if (!groupId) continue;
    const dropRect = toDropRect(rect);
    const region = regionFromPointer(clientX, clientY, dropRect);
    if (region === 'center') {
      return { rect: insetRect(dropRect, 6), action: { kind: 'join', groupId } };
    }
    // An edge only means something if some *other* tab is actually in this
    // same group right now — otherwise there's nothing to split against
    // (dragging a group's only tab onto its own edge must be a no-op, not
    // spawn an empty second pane). editorTabsStore.splitGroupWithTab
    // enforces the same rule; this just keeps the indicator from lying
    // about what would happen.
    const tabsEl = groupEl?.querySelector(':scope > .editor-group-tabs');
    const hasOtherOccupant = tabsEl
      ? [...tabsEl.querySelectorAll<HTMLElement>('[data-file-id]')].some(
          (el) => el.dataset.fileId !== draggingFileId,
        )
      : false;
    if (!hasOtherOccupant) return null;
    return { rect: halfRect(dropRect, region), action: { kind: 'split', groupId, edge: region } };
  }
  return null;
}
