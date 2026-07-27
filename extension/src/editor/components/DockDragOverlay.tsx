import { useDockStore } from '../state/dockStore';
import { computeDropTarget } from './dockDropTarget';
import { PANEL_LABELS } from './DockPanel';
import './DockDragOverlay.css';

// Pure renderer — all the actual drag tracking (pointerdown/move/up) and
// the drop itself happen in DockPanel's DraggableTab, which owns pointer
// capture on the tab being dragged. This just reflects that live state
// (dockStore.pointerPosition, updated on every pointermove) as a single
// "here's what would happen if you let go now" indicator, recomputed
// fresh on each render rather than tracked separately, so there's only
// ever one source of truth for where a drop would land.
//
// Also renders a small ghost label that follows the cursor — native HTML5
// Drag and Drop drew one of these for free (the browser's own drag image);
// switching to plain Pointer Events for reliability (see dockStore's
// pointerPosition doc comment) meant losing that for free too, so it's
// drawn here instead. Shown whenever a drag is in progress, independent of
// whether the cursor is currently over a valid drop target — dropping
// nowhere valid just cancels the move, but the ghost still tracks the
// cursor the whole time, same as VS Code's own tab/panel drag.
export function DockDragOverlay() {
  const draggingPanel = useDockStore((s) => s.draggingPanel);
  const pointerPosition = useDockStore((s) => s.pointerPosition);
  if (!draggingPanel || !pointerPosition) return null;

  const target = computeDropTarget(pointerPosition.x, pointerPosition.y, draggingPanel);

  return (
    <>
      {target && (
        <div
          className="dock-drag-indicator"
          style={{
            left: target.rect.left,
            top: target.rect.top,
            width: target.rect.width,
            height: target.rect.height,
          }}
        />
      )}
      <div className="dock-drag-ghost" style={{ left: pointerPosition.x, top: pointerPosition.y }}>
        {PANEL_LABELS[draggingPanel]}
      </div>
    </>
  );
}
