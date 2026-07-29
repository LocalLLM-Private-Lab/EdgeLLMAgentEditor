import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditorTabsStore, tabsInGroup } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useExtensionsStore } from '../state/extensionsStore';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { computeEditorDropTarget } from './editorDropTarget';
import { MonacoEditorPane } from './MonacoEditorPane';
import { ImageViewerPane } from './ImageViewerPane';
import { ExtensionDetailView } from './ExtensionDetailView';
import { FileIcon } from './FileIcon';
import '../components/MenuBar.css';
import './EditorGroupPane.css';

const DRAG_THRESHOLD_PX = 4;

interface TabContextMenuState {
  x: number;
  y: number;
  fileId: string;
}

/** A file tab that can be pulled out and redocked into another group, or
 * dropped on an edge to split its own group — same plain-Pointer-Events +
 * setPointerCapture technique as the dock system's DraggableTab, and for
 * the same reason (native HTML5 Drag and Drop proved unreliable there). */
function DraggableFileTab({
  fileId,
  name,
  isDirty,
  isPreview,
  active,
  onClick,
  onClose,
  onContextMenu,
}: {
  fileId: string;
  name: string;
  isDirty: boolean;
  isPreview: boolean;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const setDraggingTab = useEditorTabsStore((s) => s.setDraggingTab);
  const setPointerPosition = useEditorTabsStore((s) => s.setPointerPosition);
  const moveTabToGroup = useEditorTabsStore((s) => s.moveTabToGroup);
  const splitGroupWithTab = useEditorTabsStore((s) => s.splitGroupWithTab);
  const pinTab = useEditorTabsStore((s) => s.pinTab);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

  function finishDrag(e: ReactPointerEvent) {
    if (isDragging.current) {
      const target = computeEditorDropTarget(e.clientX, e.clientY, fileId);
      if (target) {
        if (target.action.kind === 'join') moveTabToGroup(fileId, target.action.groupId);
        else if (target.action.kind === 'reorder') moveTabToGroup(fileId, target.action.groupId, target.action.beforeFileId);
        else splitGroupWithTab(fileId, target.action.groupId, target.action.edge);
      }
    }
    pointerDownAt.current = null;
    isDragging.current = false;
    setDraggingTab(null);
  }

  return (
    <div
      className={`editor-tab ${active ? 'active' : ''} ${isPreview ? 'preview' : ''}`}
      data-file-id={fileId}
      style={{ touchAction: 'none' }}
      onClick={onClick}
      onDoubleClick={() => pinTab(fileId)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Capturing the pointer here (on the tab, not the button) redirects
        // the eventual mouseup/click to the tab itself — fine for starting
        // a drag from most of the tab, but it means a press-and-release on
        // the close button would never actually fire the button's own
        // onClick, since the click ends up targeted at the tab instead.
        // Skip capture entirely when the press starts on the close button
        // so its plain click behaves normally.
        if ((e.target as HTMLElement).closest('.editor-tab-close')) return;
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
          setDraggingTab(fileId);
        }
        setPointerPosition(e.clientX, e.clientY);
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <FileIcon name={name} />
      <span className="editor-tab-name">
        {isDirty ? '● ' : ''}
        {name}
      </span>
      <button
        className="editor-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`${name} を閉じる`}
      >
        ×
      </button>
    </div>
  );
}

/** One leaf of the editor split tree: its own tab strip plus its own
 * Monaco instance. Every group gets a real, separately-mounted editor —
 * not a shared singleton switching models — so two groups showing
 * different files render simultaneously, same as VS Code's split editors. */
export function EditorGroupPane({ groupId }: { groupId: string }) {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.groups[groupId]?.activeFileId ?? null);
  const setActiveFile = useEditorTabsStore((s) => s.setActiveFile);
  const closeFile = useEditorTabsStore((s) => s.closeFile);
  const closeOtherTabsInGroup = useEditorTabsStore((s) => s.closeOtherTabsInGroup);
  const closeTabsToRightInGroup = useEditorTabsStore((s) => s.closeTabsToRightInGroup);
  const closeAllTabsInGroup = useEditorTabsStore((s) => s.closeAllTabsInGroup);
  const setFocusedGroup = useEditorTabsStore((s) => s.setFocusedGroup);
  const tabs = tabsInGroup(openFiles, groupId);

  // An extension's detail page behaves like one more tab in this same
  // strip (see extensionsStore.ts's viewingExtensionId/Group/Active) —
  // "hosted" means its tab lives here; "active" means it's the currently
  // shown content rather than switched away from in favor of a file.
  const viewingExtensionId = useExtensionsStore((s) => s.viewingExtensionId);
  const viewingExtensionGroupId = useExtensionsStore((s) => s.viewingExtensionGroupId);
  const viewingExtensionActive = useExtensionsStore((s) => s.viewingExtensionActive);
  const extensions = useExtensionsStore((s) => s.extensions);
  const viewExtension = useExtensionsStore((s) => s.viewExtension);
  const deactivateExtensionView = useExtensionsStore((s) => s.deactivateExtensionView);
  const closeExtensionView = useExtensionsStore((s) => s.closeExtensionView);
  const hostsExtensionTab = viewingExtensionGroupId === groupId;
  const extensionTabActive = hostsExtensionTab && viewingExtensionActive;
  const viewedExtension = hostsExtensionTab ? extensions.find((e) => e.id === viewingExtensionId) : undefined;

  // An image tab (png/jpg/... — see editorTabsStore.ts's openFile) has no
  // Monaco model at all, so it needs its own content slot the same way the
  // extension tab does — toggled by display, not conditional render, for
  // the same reason (switching to it and back shouldn't tear down/rebuild
  // whatever Monaco was showing).
  const activeTab = tabs.find((t) => t.id === activeFileId);
  const imageTabActive = activeTab?.kind === 'image';

  const [tabMenu, setTabMenu] = useState<TabContextMenuState | null>(null);
  const closeTabMenu = () => setTabMenu(null);
  useDismissOnOutsideClick(closeTabMenu, tabMenu !== null, ['click', 'contextmenu']);

  const menuTab = tabMenu ? tabs.find((t) => t.id === tabMenu.fileId) : undefined;
  const menuTabIndex = menuTab ? tabs.indexOf(menuTab) : -1;

  return (
    <div className="editor-group" data-group-id={groupId}>
      <div className="editor-group-tabs">
        {tabs.map((tab) => (
          <DraggableFileTab
            key={tab.id}
            fileId={tab.id}
            name={tab.name}
            isDirty={tab.isDirty}
            isPreview={tab.isPreview}
            active={!extensionTabActive && tab.id === activeFileId}
            onClick={() => {
              if (hostsExtensionTab) deactivateExtensionView(groupId);
              setActiveFile(tab.id);
            }}
            onClose={() => closeFile(tab.id)}
            onContextMenu={(x, y) => setTabMenu({ x, y, fileId: tab.id })}
          />
        ))}
        {viewedExtension && (
          <div
            className={`editor-tab editor-tab-extension ${extensionTabActive ? 'active' : ''}`}
            onClick={() => {
              setFocusedGroup(groupId);
              viewExtension(viewedExtension.id);
            }}
          >
            {viewedExtension.iconDataUrl ? (
              <img className="editor-tab-extension-icon" src={viewedExtension.iconDataUrl} alt="" />
            ) : (
              <span className="editor-tab-extension-icon-fallback">🧩</span>
            )}
            <span className="editor-tab-name">拡張機能: {viewedExtension.displayName}</span>
            <button
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeExtensionView();
              }}
              aria-label={`${viewedExtension.displayName} を閉じる`}
            >
              ×
            </button>
          </div>
        )}
      </div>
      {tabMenu && menuTab && (
        <div
          className="menu-dropdown"
          style={{ position: 'fixed', top: tabMenu.y, left: tabMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {[
            { label: '閉じる', onClick: () => closeFile(menuTab.id) },
            {
              label: '他のタブを閉じる',
              onClick: () => closeOtherTabsInGroup(groupId, menuTab.id),
              disabled: tabs.length <= 1,
            },
            {
              label: '右側のタブを閉じる',
              onClick: () => closeTabsToRightInGroup(groupId, menuTab.id),
              disabled: menuTabIndex === -1 || menuTabIndex >= tabs.length - 1,
            },
            { label: 'すべて閉じる', onClick: () => closeAllTabsInGroup(groupId) },
            {
              label: 'パスのコピー',
              onClick: () => {
                const rootName = useWorkspaceStore.getState().rootHandle?.name ?? '';
                void navigator.clipboard.writeText([rootName, ...menuTab.pathSegments].join('/'));
              },
            },
            {
              label: '相対パスのコピー',
              onClick: () => void navigator.clipboard.writeText(menuTab.pathSegments.join('/')),
            },
          ].map((item) => (
            <button
              key={item.label}
              className="menu-dropdown-item"
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                closeTabMenu();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div className="editor-group-body" onMouseDownCapture={() => setFocusedGroup(groupId)}>
        {/* Both stay mounted (display toggling, not conditional render) so
            switching to/from the extension tab doesn't tear down and
            recreate the whole Monaco editor instance (keybindings, LSP
            providers, ...) every time — only the model swap that already
            happens for file-to-file switching is cheap; a full remount
            isn't. */}
        <div
          className="editor-group-content-slot"
          style={{ display: extensionTabActive || imageTabActive ? 'none' : 'block' }}
        >
          <MonacoEditorPane groupId={groupId} />
        </div>
        {hostsExtensionTab && (
          <div className="editor-group-content-slot" style={{ display: extensionTabActive ? 'block' : 'none' }}>
            <ExtensionDetailView />
          </div>
        )}
        {imageTabActive && (
          <div className="editor-group-content-slot">
            <ImageViewerPane groupId={groupId} />
          </div>
        )}
      </div>
    </div>
  );
}
