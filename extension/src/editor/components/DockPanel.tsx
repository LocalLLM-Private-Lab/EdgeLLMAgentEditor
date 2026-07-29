import { useCallback, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react';
import { useDockStore, type BuiltinPanelId, type DockZone, type PanelId, type SplitDirection } from '../state/dockStore';
import { useExtensionsStore, type InstalledExtension } from '../state/extensionsStore';
import { parseExtensionPanelId } from '../extensions/extensionPanelId';
import { computeDropTarget } from './dockDropTarget';
import { TerminalPanel } from './TerminalPanel';
import { CopilotPanel } from './CopilotPanel';
import { BuildConsolePanel } from './BuildConsolePanel';
import { ExtensionWebviewPanelContent } from './ExtensionWebviewPanelContent';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import '../components/MenuBar.css';
import './DockPanel.css';

export const PANEL_LABELS: Record<BuiltinPanelId, string> = {
  terminal: 'ターミナル',
  copilot: 'Copilot',
  buildConsole: 'ビルドコンソール',
};
const PANEL_COMPONENTS: Record<BuiltinPanelId, ComponentType> = {
  terminal: TerminalPanel,
  copilot: CopilotPanel,
  buildConsole: BuildConsolePanel,
};

/** Built-in panels use the static table above; an extension webview panel
 * (id shaped `ext:<extensionId>:<viewId>`, see extensionPanelId.ts) has no
 * static label — its tab shows the owning extension's displayName instead. */
export function panelLabel(id: PanelId, extensions: InstalledExtension[]): string {
  const extInfo = parseExtensionPanelId(id);
  if (!extInfo) return PANEL_LABELS[id as BuiltinPanelId] ?? id;
  return extensions.find((e) => e.id === extInfo.extensionId)?.displayName ?? extInfo.extensionId;
}

function PanelTabLabel({ id }: { id: PanelId }) {
  const extensions = useExtensionsStore((s) => s.extensions);
  return <>{panelLabel(id, extensions)}</>;
}

const DRAG_THRESHOLD_PX = 4;

interface DockTabMenuState {
  x: number;
  y: number;
  id: PanelId;
}

/** 非表示(閉じる)/同じゾーンを共有する他パネルの表示切替 — VS Code のパネル
 * タブ右クリックの「閉じる」相当。組み込みパネルは常に2種類までだったため
 * かつては「もう一方」固定だったが、拡張機能パネルが動的に増えるため、同じ
 * ゾーンにいる他の全パネルを列挙する形に一般化している。 */
function DockTabContextMenu({ state, onClose }: { state: DockTabMenuState; onClose: () => void }) {
  useDismissOnOutsideClick(onClose, true, ['click', 'contextmenu']);
  const panels = useDockStore((s) => s.panels);
  const toggleVisible = useDockStore((s) => s.toggleVisible);
  const extensions = useExtensionsStore((s) => s.extensions);
  const { id } = state;
  const zone = panels[id].zone;
  // Reaching into an unrelated zone from a tab that has nothing to do with
  // it isn't a natural "close this tab" action — only panels sharing this
  // same zone (tabbed/split together, or hidden but would reappear here)
  // are offered.
  const others = Object.keys(panels).filter((p) => p !== id && panels[p].zone === zone);

  const items = [
    { label: `${panelLabel(id, extensions)}を非表示`, onClick: () => toggleVisible(id) },
    ...others.map((otherId) => ({
      label: `${panelLabel(otherId, extensions)}を${panels[otherId].visible ? '非表示' : '表示'}`,
      onClick: () => toggleVisible(otherId),
    })),
  ];

  return (
    <div
      className="menu-dropdown"
      style={{ position: 'fixed', top: state.y, left: state.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className="menu-dropdown-item"
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A tab (or split-pane header) that can be pulled out and redocked.
 * Plain pointer events + setPointerCapture, not the native HTML5 Drag and
 * Drop API — that API turned out unreliable for this (see dockStore's
 * pointerPosition doc comment for the full story). A small movement
 * threshold before "dragging" actually starts keeps a plain click (tab
 * switch) working normally. */
function DraggableTab({ id, active, onClick }: { id: PanelId; active: boolean; onClick: () => void }) {
  const setDraggingPanel = useDockStore((s) => s.setDraggingPanel);
  const setPointerPosition = useDockStore((s) => s.setPointerPosition);
  const movePanel = useDockStore((s) => s.movePanel);
  const splitPanel = useDockStore((s) => s.splitPanel);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const [menu, setMenu] = useState<DockTabMenuState | null>(null);

  function finishDrag(e: ReactPointerEvent) {
    if (isDragging.current) {
      const target = computeDropTarget(e.clientX, e.clientY, id);
      if (target) {
        if (target.action.kind === 'place') movePanel(id, target.action.zone);
        else splitPanel(id, target.action.zone, target.action.edge);
      }
    }
    pointerDownAt.current = null;
    isDragging.current = false;
    setDraggingPanel(null);
  }

  return (
    <>
      <button
        className={active ? 'active' : ''}
        data-panel-id={id}
        style={{ touchAction: 'none' }}
        onClick={onClick}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          pointerDownAt.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!pointerDownAt.current) return;
          if (!isDragging.current) {
            const dx = e.clientX - pointerDownAt.current.x;
            const dy = e.clientY - pointerDownAt.current.y;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            isDragging.current = true;
            setDraggingPanel(id);
          }
          setPointerPosition(e.clientX, e.clientY);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
      >
        <PanelTabLabel id={id} />
      </button>
      {menu && <DockTabContextMenu state={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

function PanelContent({ id }: { id: PanelId }) {
  const extInfo = parseExtensionPanelId(id);
  if (extInfo) return <ExtensionWebviewPanelContent extensionId={extInfo.extensionId} viewId={extInfo.viewId} />;
  const Component = PANEL_COMPONENTS[id as BuiltinPanelId];
  return <Component />;
}

interface DockPanelProps {
  zone: DockZone;
  /** Panels currently visible and assigned to this zone — always >= 1,
   * callers skip rendering entirely when empty. */
  panelIds: PanelId[];
  activePanel: PanelId;
  size: number;
  /** Present when this zone's two panels are shown side by side instead
   * of as tabs (see dockStore.splitPanel). */
  split: { direction: SplitDirection; order: [PanelId, PanelId] } | null;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
}

// Every panel gets its own instance here (not shared across zones), so
// Terminal and Copilot can each live in a completely different zone at
// once — unlike the old single bottom-only panel, which mounted both
// permanently regardless of visibility.
export function DockPanel({ zone, panelIds, activePanel, size, split, splitRatio, onSplitRatioChange }: DockPanelProps) {
  const setActiveInZone = useDockStore((s) => s.setActiveInZone);
  const sizeStyle = zone === 'left' || zone === 'right' ? { width: size } : { height: size };

  const dragStart = useRef<{ pos: number; ratio: number } | null>(null);
  const onDividerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!split) return;
      dragStart.current = { pos: split.direction === 'row' ? e.clientX : e.clientY, ratio: splitRatio };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [split, splitRatio],
  );
  const onDividerPointerMove = useCallback(
    (e: ReactPointerEvent, containerEl: HTMLDivElement | null) => {
      if (!dragStart.current || !split || !containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const total = split.direction === 'row' ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = split.direction === 'row' ? e.clientX : e.clientY;
      const delta = (pos - dragStart.current.pos) / total;
      onSplitRatioChange(dragStart.current.ratio + delta);
    },
    [split, onSplitRatioChange],
  );
  const onDividerPointerUp = useCallback(() => {
    dragStart.current = null;
  }, []);

  if (split && panelIds.length === 2) {
    return (
      <SplitDockPanel
        zone={zone}
        sizeStyle={sizeStyle}
        split={split}
        splitRatio={splitRatio}
        onDividerPointerDown={onDividerPointerDown}
        onDividerPointerMove={onDividerPointerMove}
        onDividerPointerUp={onDividerPointerUp}
      />
    );
  }

  return (
    <div className={`dock-panel dock-panel-${zone}`} style={sizeStyle}>
      <div className="dock-panel-tabs">
        {panelIds.map((id) => (
          <DraggableTab key={id} id={id} active={id === activePanel} onClick={() => setActiveInZone(zone, id)} />
        ))}
      </div>
      <div className="dock-panel-body">
        {panelIds.map((id) => (
          <div key={id} className="dock-panel-tab-content" style={{ display: id === activePanel ? 'block' : 'none' }}>
            <PanelContent id={id} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface SplitDockPanelProps {
  zone: DockZone;
  sizeStyle: { width: number } | { height: number };
  split: { direction: SplitDirection; order: [PanelId, PanelId] };
  splitRatio: number;
  onDividerPointerDown: (e: ReactPointerEvent) => void;
  onDividerPointerMove: (e: ReactPointerEvent, containerEl: HTMLDivElement | null) => void;
  onDividerPointerUp: () => void;
}

function SplitDockPanel({
  zone,
  sizeStyle,
  split,
  splitRatio,
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
}: SplitDockPanelProps) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [first, second] = split.order;
  const firstStyle = split.direction === 'row' ? { width: `${splitRatio * 100}%` } : { height: `${splitRatio * 100}%` };
  const secondStyle =
    split.direction === 'row' ? { width: `${(1 - splitRatio) * 100}%` } : { height: `${(1 - splitRatio) * 100}%` };

  return (
    <div
      ref={setContainerEl}
      className={`dock-panel dock-panel-${zone} dock-panel-split dock-panel-split-${split.direction}`}
      style={sizeStyle}
    >
      <div className="dock-panel-split-pane" style={firstStyle}>
        <div className="dock-panel-tabs">
          <DraggableTab id={first} active={false} onClick={() => {}} />
        </div>
        <div className="dock-panel-body">
          <div className="dock-panel-tab-content" style={{ display: 'block' }}>
            <PanelContent id={first} />
          </div>
        </div>
      </div>
      <div
        className={`dock-panel-split-divider dock-panel-split-divider-${split.direction}`}
        onPointerDown={onDividerPointerDown}
        onPointerMove={(e) => onDividerPointerMove(e, containerEl)}
        onPointerUp={onDividerPointerUp}
      />
      <div className="dock-panel-split-pane" style={secondStyle}>
        <div className="dock-panel-tabs">
          <DraggableTab id={second} active={false} onClick={() => {}} />
        </div>
        <div className="dock-panel-body">
          <div className="dock-panel-tab-content" style={{ display: 'block' }}>
            <PanelContent id={second} />
          </div>
        </div>
      </div>
    </div>
  );
}
