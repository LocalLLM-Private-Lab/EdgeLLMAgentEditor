import type { DockZone, PanelId } from '../state/dockStore';
import { regionFromPointer, halfRect, insetRect, toDropRect, type DropRect } from './dropGeometry';

export type { DropRect };

export type DropAction =
  // Outer-edge empty-space move, or "drop on the center of an existing
  // panel" — both end up as movePanel(id, zone), joined as tabs.
  | { kind: 'place'; zone: DockZone }
  // Dropped on an edge of an existing single-panel zone — splits that
  // zone's own footprint instead of jumping to the same-named global edge.
  | { kind: 'split'; zone: DockZone; edge: DockZone };

export interface DropTarget {
  rect: DropRect;
  action: DropAction;
}

// Terminal/Copilot-type panels are conventionally top/bottom strips, so
// top/bottom needs to *win* over most of the content area, not just tie-
// break against left/right at the same margin — giving top/bottom a much
// wider capture zone than left/right means a drag only has to be roughly
// "not near the very left/right edge" to land on top/bottom, rather than
// needing to be precisely near the top/bottom edge itself.
const OUTER_MARGIN_RATIO_VERTICAL = 0.4;
const OUTER_MARGIN_RATIO_HORIZONTAL = 0.15;
const OUTER_BAND_RATIO = 0.2;
const OUTER_BAND_MIN = 100;

function parseZone(el: Element): DockZone | null {
  const match = el.className.match(/\bdock-panel-(top|bottom|left|right)\b/);
  return (match?.[1] as DockZone | undefined) ?? null;
}

/**
 * Single source of truth for "what would dropping here do" — one target
 * at a time, computed fresh from the current pointer position and actual
 * on-screen layout (queried directly from the DOM rather than threaded
 * through props, since the set of rendered panels/zones changes shape
 * during a drag). Returns null when the pointer isn't over anything
 * meaningful (e.g. hovering the sidebar itself, or empty space too far
 * from any edge to reasonably mean "dock here").
 */
export function computeDropTarget(
  clientX: number,
  clientY: number,
  draggingPanelId?: PanelId | null,
): DropTarget | null {
  // 1. Over an existing panel? Center = join as tabs; an edge = split
  // that panel's own footprint (never the same-named global zone).
  //
  // Queries .dock-panel-body specifically, not the outer .dock-panel —
  // in split mode there are two bodies (one per pane) inside a single
  // .dock-panel container, and region-detection needs to be relative to
  // whichever individual pane the pointer is actually over. Using the
  // combined outer container's rect instead would compute regions across
  // both panes at once, e.g. making "drop on the center of the pane
  // you're looking at" register as an edge of the *other* pane, so a
  // drag meant to collapse a split back to tabs would instead just
  // re-split it.
  for (const bodyEl of document.querySelectorAll<HTMLElement>('.dock-panel-body')) {
    const rect = bodyEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const panelEl = bodyEl.closest('.dock-panel');
    const zone = panelEl ? parseZone(panelEl) : null;
    if (!zone) continue;
    const dropRect = toDropRect(rect);
    const region = regionFromPointer(clientX, clientY, dropRect);
    if (region === 'center') {
      return { rect: insetRect(dropRect, 6), action: { kind: 'place', zone } };
    }
    // An edge only means something if some *other* panel is actually
    // sharing this pane right now (dockStore.splitPanel requires the
    // same thing) — otherwise there's nothing to split against, and
    // showing an indicator here would promise a split that silently
    // does nothing (or, before this check existed, reached across and
    // force-opened a hidden panel elsewhere just to have a partner).
    const tabsEl = bodyEl.parentElement?.querySelector(':scope > .dock-panel-tabs');
    const hasOtherOccupant = tabsEl
      ? [...tabsEl.querySelectorAll<HTMLElement>('button[data-panel-id]')].some(
          (btn) => btn.dataset.panelId !== draggingPanelId,
        )
      : false;
    if (!hasOtherOccupant) return null;
    return { rect: halfRect(dropRect, region), action: { kind: 'split', zone, edge: region } };
  }

  // 2. Not over any panel — near an outer edge of the available content
  // area (the sidebar is carved out; dropping "on" it never docks a panel
  // over it, so it shouldn't be a valid target either).
  const appBody = document.querySelector('.app-body');
  if (!appBody) return null;
  const bodyRect = appBody.getBoundingClientRect();
  const sidebarRect = document.querySelector('.app-sidebar')?.getBoundingClientRect();
  const contentLeft = sidebarRect ? sidebarRect.right : bodyRect.left;

  if (clientX < contentLeft || clientX > bodyRect.right || clientY < bodyRect.top || clientY > bodyRect.bottom) {
    return null;
  }

  const contentWidth = bodyRect.right - contentLeft;
  const contentHeight = bodyRect.bottom - bodyRect.top;
  if (contentWidth <= 0 || contentHeight <= 0) return null;

  // Top/bottom gets a much larger acceptance margin than left/right (see
  // the constants above) — this is a deliberate hierarchy, not a
  // "whichever fraction happens to be smaller" comparison. Comparing raw
  // fractions across two different denominators (contentWidth vs
  // contentHeight) at the *same* threshold doesn't capture "which edge
  // does this feel closest to" either: content is normally much wider
  // than tall, so with equal margins a drag anywhere right-of-center
  // still resolves to 'right' the instant it's outside dead center,
  // simply because 25% of a short height is reached almost immediately.
  // Requiring left/right to be within a narrow band of the actual edge
  // (while top/bottom claims almost the whole area) matches "top/bottom
  // is the default, left/right takes a deliberate drag to the side".
  const distances: Record<DockZone, number> = {
    top: (clientY - bodyRect.top) / contentHeight,
    bottom: (bodyRect.bottom - clientY) / contentHeight,
    left: (clientX - contentLeft) / contentWidth,
    right: (bodyRect.right - clientX) / contentWidth,
  };
  const verticalNearest: DockZone = distances.top <= distances.bottom ? 'top' : 'bottom';
  const horizontalNearest: DockZone = distances.left <= distances.right ? 'left' : 'right';
  let nearest: DockZone;
  if (distances[verticalNearest] <= OUTER_MARGIN_RATIO_VERTICAL) {
    nearest = verticalNearest;
  } else if (distances[horizontalNearest] <= OUTER_MARGIN_RATIO_HORIZONTAL) {
    nearest = horizontalNearest;
  } else {
    return null;
  }

  // If that edge already has a panel docked there, show *its* actual
  // on-screen rect instead of a generic band — dropping here joins that
  // existing panel as a tab, so the candidate frame should look like what
  // it's actually landing on, not a same-sized sliver that may not even
  // line up with where the real panel is (its zone can be a different
  // width/height than this generic band).
  const occupantBody = document.querySelector<HTMLElement>(`.dock-panel-${nearest} .dock-panel-body`);
  if (occupantBody) {
    const rect = toDropRect(occupantBody.getBoundingClientRect());
    return { rect: insetRect(rect, 6), action: { kind: 'place', zone: nearest } };
  }

  const band = Math.max(OUTER_BAND_MIN, Math.min(contentWidth, contentHeight) * OUTER_BAND_RATIO);
  let rect: DropRect;
  switch (nearest) {
    case 'top':
      rect = { left: contentLeft, top: bodyRect.top, width: contentWidth, height: band };
      break;
    case 'bottom':
      rect = { left: contentLeft, top: bodyRect.bottom - band, width: contentWidth, height: band };
      break;
    case 'left':
      rect = { left: contentLeft, top: bodyRect.top, width: band, height: contentHeight };
      break;
    case 'right':
      rect = { left: bodyRect.right - band, top: bodyRect.top, width: band, height: contentHeight };
      break;
  }
  return { rect, action: { kind: 'place', zone: nearest } };
}
