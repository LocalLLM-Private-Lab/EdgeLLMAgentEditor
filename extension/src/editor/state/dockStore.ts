import { create } from 'zustand';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

export type DockZone = 'top' | 'bottom' | 'left' | 'right';
export type PanelId = 'terminal' | 'copilot';
export type SplitDirection = 'row' | 'column';

export const PANEL_IDS: PanelId[] = ['terminal', 'copilot'];
export const DOCK_ZONES: DockZone[] = ['top', 'bottom', 'left', 'right'];

const STORAGE_KEY = 'uiDockLayout';

interface PanelPlacement {
  /** Where this panel currently lives, or would live if made visible again
   * — remembered even while hidden, so re-enabling from the View menu
   * restores it to the same spot instead of always resetting to bottom. */
  zone: DockZone;
  visible: boolean;
}

interface SplitState {
  /** 'row' = side by side (left/right halves); 'column' = stacked
   * (top/bottom halves). */
  direction: SplitDirection;
  /** [first, second] — first is the left/top half, second is the
   * right/bottom half. Only ever the two entries in PANEL_IDS, in
   * whichever order the split was created. */
  order: [PanelId, PanelId];
}

interface StoredLayout {
  panels: Record<PanelId, PanelPlacement>;
  /** Which panel is showing in each zone, for zones two panels share as
   * tabs (dragged into the same spot) — needs its own per-zone tab strip. */
  activeByZone: Partial<Record<DockZone, PanelId>>;
  /** Present only for a zone whose two panels are shown side by side
   * instead of as tabs — see splitPanel(). */
  splitByZone: Partial<Record<DockZone, SplitState>>;
  /** 0..1 position of the divider within a split zone (fraction toward
   * the second pane). Defaults to 0.5 when absent. */
  splitRatio: Partial<Record<DockZone, number>>;
}

// Only used on a genuinely fresh install (load() falls back to this when
// nothing has ever been persisted) — terminal starts visible so the app
// opens ready to use rather than needing a trip to the 表示 menu first;
// any later explicit hide is persisted and respected from then on, this
// default never overrides an actual saved preference.
const DEFAULT_LAYOUT: StoredLayout = {
  panels: {
    terminal: { zone: 'bottom', visible: true },
    copilot: { zone: 'bottom', visible: false },
  },
  activeByZone: {},
  splitByZone: {},
  splitRatio: {},
};

interface DockState extends StoredLayout {
  loaded: boolean;
  /** Panel currently mid-drag (from a DockPanel tab), so DockDragOverlay
   * knows to compute and show a drop target. Not persisted. */
  draggingPanel: PanelId | null;
  /** Live pointer position while dragging (viewport coordinates) — driven
   * by pointermove on the tab being dragged (see DockPanel's
   * DraggableTab), not the native HTML5 Drag and Drop API. That API
   * turned out to be unreliable here: mounting the old drop-target
   * overlay in response to `dragstart` was disruptive enough to the DOM
   * that some browsers cancelled the native drag session outright
   * (dragend fired immediately, with no dragover ever in between), and
   * even after fixing that it still didn't work reliably with a real
   * mouse. Plain pointer events with setPointerCapture — the same
   * approach VS Code itself and most drag-and-drop libraries use for
   * in-page reordering — don't depend on the browser's own drag-session
   * bookkeeping at all. Not persisted. */
  pointerPosition: { x: number; y: number } | null;
  load: () => Promise<void>;
  setDraggingPanel: (id: PanelId | null) => void;
  setPointerPosition: (x: number, y: number) => void;
  /** Moves a panel to a zone, merged as a tab with whatever's already
   * there (collapsing any existing split in that zone back to tabs) —
   * used for outer-edge moves and "drop on the center of an existing
   * panel". Also cleans up the zone this panel is leaving: if it was
   * that zone's active tab, whichever panel remains there (if any)
   * becomes active instead, rather than leaving a stale reference to a
   * panel that's no longer even in that zone. */
  movePanel: (id: PanelId, zone: DockZone) => void;
  /** Splits `zone` — which must currently hold exactly one *other*
   * panel — so `draggedId` and that existing panel sit side by side
   * instead of one replacing the other. `edge` is which side of the
   * existing panel the drag landed on, which determines both the split
   * direction (top/bottom -> column, left/right -> row) and the order
   * (dropped on top/left -> dragged panel goes first). */
  splitPanel: (draggedId: PanelId, zone: DockZone, edge: DockZone) => void;
  setSplitRatio: (zone: DockZone, ratio: number) => void;
  /** Shows/hides a panel without changing its remembered zone (View menu
   * toggle). Hiding falls the zone's active tab back to whichever other
   * panel still shares it, if any, and drops any split that zone had. */
  setVisible: (id: PanelId, visible: boolean) => void;
  toggleVisible: (id: PanelId) => void;
  setActiveInZone: (zone: DockZone, id: PanelId) => void;
}

function persist(get: () => DockState): void {
  const { panels, activeByZone, splitByZone, splitRatio } = get();
  void setStoredValue<StoredLayout>(STORAGE_KEY, { panels, activeByZone, splitByZone, splitRatio });
}

/** Given a panel is leaving `zone` (moved elsewhere, or hidden), picks
 * who should become that zone's active tab: whichever other panel is
 * still visible there, or none. Only matters when the departing panel
 * *was* the active one — otherwise the existing entry is still valid. */
function reassignActiveInZone(
  panels: Record<PanelId, PanelPlacement>,
  activeByZone: Partial<Record<DockZone, PanelId>>,
  zone: DockZone,
  departingId: PanelId,
): Partial<Record<DockZone, PanelId>> {
  if (activeByZone[zone] !== departingId) return activeByZone;
  const next = { ...activeByZone };
  const other = PANEL_IDS.find((p) => p !== departingId && panels[p].visible && panels[p].zone === zone);
  if (other) next[zone] = other;
  else delete next[zone];
  return next;
}

export const useDockStore = create<DockState>((set, get) => ({
  ...DEFAULT_LAYOUT,
  loaded: false,
  draggingPanel: null,
  pointerPosition: null,

  load: async () => {
    const saved = await getStoredValue<StoredLayout>(STORAGE_KEY);
    set({ ...(saved ?? DEFAULT_LAYOUT), loaded: true });
  },

  setDraggingPanel: (id) => set({ draggingPanel: id, pointerPosition: id ? get().pointerPosition : null }),
  setPointerPosition: (x, y) => set({ pointerPosition: { x, y } }),

  movePanel: (id, zone) => {
    set((state) => {
      const previousZone = state.panels[id].zone;
      const panels = { ...state.panels, [id]: { zone, visible: true } };
      let activeByZone = { ...state.activeByZone, [zone]: id };
      const splitByZone = { ...state.splitByZone };
      delete splitByZone[zone]; // joining here is always as tabs, not a split
      if (previousZone !== zone) {
        activeByZone = reassignActiveInZone(panels, activeByZone, previousZone, id);
        // The old zone no longer has two panels either way, so any split
        // it had is meaningless now.
        delete splitByZone[previousZone];
      }
      return { panels, activeByZone, splitByZone };
    });
    persist(get);
  },

  splitPanel: (draggedId, zone, edge) => {
    // The split partner must already be visible *in this zone* — picking
    // "whichever other panel exists globally" would reach across and
    // force-open a panel the user never asked for (e.g. dropping the
    // Terminal tab on its own lone edge summoning a hidden Copilot).
    const { panels } = get();
    const otherPanel = PANEL_IDS.find((p) => p !== draggedId && panels[p].visible && panels[p].zone === zone);
    if (!otherPanel) return;
    const direction: SplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column';
    const draggedFirst = edge === 'top' || edge === 'left';
    const order: [PanelId, PanelId] = draggedFirst ? [draggedId, otherPanel] : [otherPanel, draggedId];

    set((state) => {
      const previousZone = state.panels[draggedId].zone;
      const panels = {
        ...state.panels,
        [draggedId]: { zone, visible: true },
        [otherPanel]: { ...state.panels[otherPanel], zone, visible: true },
      };
      let activeByZone = { ...state.activeByZone };
      delete activeByZone[zone]; // split panes don't use the tab strip's "active" concept
      if (previousZone !== zone) {
        activeByZone = reassignActiveInZone(panels, activeByZone, previousZone, draggedId);
      }
      return {
        panels,
        activeByZone,
        splitByZone: { ...state.splitByZone, [zone]: { direction, order } },
      };
    });
    persist(get);
  },

  setSplitRatio: (zone, ratio) => {
    set((state) => ({ splitRatio: { ...state.splitRatio, [zone]: Math.min(0.85, Math.max(0.15, ratio)) } }));
    persist(get);
  },

  setVisible: (id, visible) => {
    set((state) => {
      const current = state.panels[id];
      const panels = { ...state.panels, [id]: { ...current, visible } };
      let activeByZone = { ...state.activeByZone };
      const splitByZone = { ...state.splitByZone };
      if (visible) {
        activeByZone[current.zone] = id;
      } else {
        activeByZone = reassignActiveInZone(panels, activeByZone, current.zone, id);
        delete splitByZone[current.zone]; // one panel left -> nothing left to split
      }
      return { panels, activeByZone, splitByZone };
    });
    persist(get);
  },

  toggleVisible: (id) => {
    get().setVisible(id, !get().panels[id].visible);
  },

  setActiveInZone: (zone, id) => {
    set((state) => ({ activeByZone: { ...state.activeByZone, [zone]: id } }));
    persist(get);
  },
}));

/** Panels currently visible and docked to `zone`, in a stable order. */
export function panelsInZone(panels: Record<PanelId, PanelPlacement>, zone: DockZone): PanelId[] {
  return PANEL_IDS.filter((id) => panels[id].visible && panels[id].zone === zone);
}
