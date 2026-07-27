export interface DropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Edge = 'top' | 'bottom' | 'left' | 'right';

// 0.25 (a 50%-wide center square) made the edge regions too thin to hit
// reliably — you basically had to be within the outer quarter of the pane
// to trigger a split. VS Code's own regions are much more generous (the
// center "join as a tab" target is a fairly small square in the middle;
// almost everything else counts as an edge). 0.4 makes the center a 20%
// square, so "generally over the right side" reads as "right edge" the
// way it does in VS Code.
const CENTER_MARGIN = 0.4;

/** VS Code's drop indicator shape: a center square (join as a tab)
 * surrounded by four edge regions (split in that direction) — normalized
 * to the given rect regardless of its actual on-screen size/position.
 * Shared by the dock system (dockDropTarget.ts) and the editor-group
 * system (editorDropTarget.ts), which are otherwise fully independent —
 * only this pure geometry is common between them. */
export function regionFromPointer(clientX: number, clientY: number, rect: DropRect): Edge | 'center' {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x > CENTER_MARGIN && x < 1 - CENTER_MARGIN && y > CENTER_MARGIN && y < 1 - CENTER_MARGIN) {
    return 'center';
  }
  const distanceToEdge: Record<Edge, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return (Object.keys(distanceToEdge) as Edge[]).reduce((closest, edge) =>
    distanceToEdge[edge] < distanceToEdge[closest] ? edge : closest,
  );
}

export function halfRect(rect: DropRect, edge: Edge): DropRect {
  switch (edge) {
    case 'top':
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 };
    case 'bottom':
      return { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 };
    case 'left':
      return { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height };
    case 'right':
      return { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height };
  }
}

export function insetRect(rect: DropRect, inset: number): DropRect {
  return { left: rect.left + inset, top: rect.top + inset, width: rect.width - inset * 2, height: rect.height - inset * 2 };
}

export function toDropRect(rect: DOMRect): DropRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
