import { useEditorTabsStore } from '../state/editorTabsStore';
import { computeEditorDropTarget } from './editorDropTarget';
import './EditorDragOverlay.css';

// Pure renderer, same shape as the dock system's DockDragOverlay: the
// actual drag tracking (pointerdown/move/up) and the drop itself happen in
// EditorGroupPane's draggable tab, which owns pointer capture. This just
// reflects that live state (editorTabsStore.pointerPosition) as a single
// "here's what would happen if you let go now" indicator, plus a small
// ghost label that follows the cursor the whole time a drag is in progress
// (independent of whether it's currently over a valid target) — the same
// thing native HTML5 Drag and Drop drew for free via the browser's own
// drag image, before that API was dropped in favor of plain Pointer Events
// for reliability (see editorTabsStore's pointerPosition doc comment).
export function EditorDragOverlay() {
  const draggingTab = useEditorTabsStore((s) => s.draggingTab);
  const pointerPosition = useEditorTabsStore((s) => s.pointerPosition);
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  if (!draggingTab || !pointerPosition) return null;

  const target = computeEditorDropTarget(pointerPosition.x, pointerPosition.y, draggingTab);
  const draggedName = openFiles.find((f) => f.id === draggingTab)?.name ?? '';

  return (
    <>
      {target && (
        <div
          className="editor-drag-indicator"
          style={{
            left: target.rect.left,
            top: target.rect.top,
            width: target.rect.width,
            height: target.rect.height,
          }}
        />
      )}
      <div className="editor-drag-ghost" style={{ left: pointerPosition.x, top: pointerPosition.y }}>
        {draggedName}
      </div>
    </>
  );
}
