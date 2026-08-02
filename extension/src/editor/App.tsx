import { useEffect, useMemo, useState } from 'react';
import { getStoredValue, setStoredValue } from '../shared/chromeStorage';
import { useWorkspaceStore } from './state/workspaceStore';
import { useEditorTabsStore } from './state/editorTabsStore';
import { useTerminalStore } from './state/terminalStore';
import { useKeybindingStore } from './state/keybindingStore';
import { useLspStore } from './lsp/lspStore';
import { useRunCommandStore, extensionOf, buildRunCommand } from './state/runCommandStore';
import { useBuildStore } from './state/buildStore';
import { useNamedCommandStore } from './state/namedCommandStore';
import {
  initExtensionHostBridge,
  activateAutoStartExtensions,
  startFileTreeAutoRefresh,
} from './extensions/extensionHostClient';
import { useExtensionsStore } from './state/extensionsStore';
import { makeExtensionSettingsCategory } from './extensions/extensionSettingsCategory';
import { resolveRelativeFilePath } from './terminal/resolveRelativeFilePath';
import { useDockStore, panelsInZone } from './state/dockStore';
import { FileTree } from './components/FileTree/FileTree';
import { EditorToolbar } from './components/EditorToolbar';
import { EditorLayout } from './components/EditorLayout';
import { EditorDragOverlay } from './components/EditorDragOverlay';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import { DockPanel, panelLabel } from './components/DockPanel';
import { parseExtensionPanelId } from './extensions/extensionPanelId';
import { DockDragOverlay } from './components/DockDragOverlay';
import { ExtensionNotifications } from './components/ExtensionNotifications';
import { ExtensionQuickPick } from './components/ExtensionQuickPick';
import { ActivityBar, type SidebarView } from './components/ActivityBar';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { SourceControlPanel } from './components/SourceControlPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { MenuBar, type Menu } from './components/MenuBar';
import { SettingsModal, type SettingsCategory } from './components/SettingsModal';
import { ResizeHandle } from './components/ResizeHandle';
import { QuickOpenModal } from './components/QuickOpenModal';
import { AppCommandBar } from './components/AppCommandBar';
import { WorkspacePathBanner } from './components/WorkspacePathBanner';
import { WorkspaceRealPathModal } from './components/WorkspaceRealPathModal';
import type { Command } from './commands/appCommands';
import { TextEditContextMenu, type TextEditMenuState } from './components/TextEditContextMenu';
import { OpenAnywayModal } from './components/OpenAnywayModal';
import { useResizable } from './hooks/useResizable';
import { usePromptTemplateStore } from './state/promptTemplateStore';
import { usePlanPromptTemplateStore } from './state/planPromptTemplateStore';
import { getActiveEditor } from './monaco/editorInstanceRegistry';
import { ensureFileAtPath } from './copilot/resolveWorkspaceFile';
import { writeFileText } from './fs/fsaWorkspace';
import ceLogoUrl from './assets/ce-logo.png';

export default function App() {
  const status = useWorkspaceStore((s) => s.status);
  const errorMessage = useWorkspaceStore((s) => s.errorMessage);
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const reconnect = useWorkspaceStore((s) => s.reconnect);
  const closeFolder = useWorkspaceStore((s) => s.closeFolder);
  const restoreFromLastSession = useWorkspaceStore((s) => s.restoreFromLastSession);

  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const saveFile = useEditorTabsStore((s) => s.saveFile);
  const openFile = useEditorTabsStore((s) => s.openFile);
  const activeTab = openFiles.find((f) => f.id === activeFileId);

  const ensureTerminalConnected = useTerminalStore((s) => s.ensureConnected);

  const loadKeybindingMode = useKeybindingStore((s) => s.loadMode);

  const loadLspWorkspaceRootOverride = useLspStore((s) => s.loadWorkspaceRootOverride);

  const runCommands = useRunCommandStore((s) => s.commands);
  const loadRunCommands = useRunCommandStore((s) => s.loadCommands);
  const loadBuildSettings = useBuildStore((s) => s.loadSettings);
  const loadNamedCommands = useNamedCommandStore((s) => s.loadCommands);
  const queueRunRequest = useTerminalStore((s) => s.queueRunRequest);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null);
  const loadPromptTemplates = usePromptTemplateStore((s) => s.loadTemplates);
  const loadPlanPromptTemplates = usePlanPromptTemplateStore((s) => s.loadTemplates);

  const dockPanels = useDockStore((s) => s.panels);
  const dockActiveByZone = useDockStore((s) => s.activeByZone);
  const dockSplitByZone = useDockStore((s) => s.splitByZone);
  const dockSplitRatio = useDockStore((s) => s.splitRatio);
  const setDockSplitRatio = useDockStore((s) => s.setSplitRatio);
  const loadDock = useDockStore((s) => s.load);
  const toggleDockVisible = useDockStore((s) => s.toggleVisible);
  const setDockVisible = useDockStore((s) => s.setVisible);

  const sidebar = useResizable({
    storageKey: 'uiSidebarWidth',
    defaultSize: 260,
    min: 150,
    max: 600,
    axis: 'x',
    directionSign: 1,
  });
  // null = sidebar closed. Otherwise which view (Explorer/Extensions) is
  // showing in it — VS Code-style: the activity bar icons switch a single
  // sidebar slot's content rather than each owning independent visibility.
  const [activeSidebarView, setActiveSidebarView] = useState<SidebarView | null>('explorer');
  useEffect(() => {
    void getStoredValue<SidebarView | null>('uiActiveSidebarView').then((stored) => {
      if (stored !== undefined) setActiveSidebarView(stored);
    });
  }, []);
  // An extension asked to open its own settings — either the "⚙ 設定"
  // button on its ExtensionsPanel.tsx card, or its own webview calling
  // `executeCommand('workbench.action.openSettings', ...)` (see
  // extensionHostClient.ts's initExtensionHostBridge). Both funnel through
  // the same request so SettingsModal opens pre-filtered to that
  // extension's category regardless of which one triggered it.
  const openSettingsRequest = useExtensionsStore((s) => s.openSettingsRequest);
  // Only suppresses WelcomeScreen while the extension tab is the actively
  // shown content (not merely open-but-switched-away-from in some group's
  // strip) — see ExtensionDetailView.tsx, now rendered inline by
  // EditorGroupPane.tsx rather than as an app-wide overlay.
  const viewingExtensionActive = useExtensionsStore((s) => s.viewingExtensionActive);
  const installedExtensions = useExtensionsStore((s) => s.extensions);
  useEffect(() => {
    if (!openSettingsRequest) return;
    setSettingsCategory(makeExtensionSettingsCategory(openSettingsRequest));
    useExtensionsStore.getState().clearOpenSettingsRequest();
  }, [openSettingsRequest]);
  function selectSidebarView(view: SidebarView) {
    setActiveSidebarView((cur) => {
      const next = cur === view ? null : view;
      void setStoredValue('uiActiveSidebarView', next);
      return next;
    });
  }
  // One resizable size per dock zone — VS Code-style docking means Terminal
  // and Copilot can each end up on any of the four edges independently, so
  // each edge needs its own remembered size regardless of which panel (or
  // panels, if dragged onto the same edge) currently occupies it.
  const topDock = useResizable({
    storageKey: 'uiDockSize:top',
    defaultSize: 220,
    min: 100,
    max: 700,
    axis: 'y',
    directionSign: 1,
  });
  const bottomDock = useResizable({
    storageKey: 'uiDockSize:bottom',
    defaultSize: 300,
    min: 120,
    max: 800,
    axis: 'y',
    directionSign: -1,
  });
  const leftDock = useResizable({
    storageKey: 'uiDockSize:left',
    defaultSize: 280,
    min: 150,
    max: 700,
    axis: 'x',
    directionSign: 1,
  });
  const rightDock = useResizable({
    storageKey: 'uiDockSize:right',
    defaultSize: 320,
    min: 150,
    max: 700,
    axis: 'x',
    directionSign: -1,
  });
  useEffect(() => {
    void restoreFromLastSession();
    void ensureTerminalConnected();
    void loadRunCommands();
    void loadBuildSettings();
    void loadNamedCommands();
    initExtensionHostBridge();
    void activateAutoStartExtensions();
    startFileTreeAutoRefresh();
    void loadPromptTemplates();
    void loadPlanPromptTemplates();
    void loadKeybindingMode();
    void loadLspWorkspaceRootOverride();
    void loadDock();
  }, [
    restoreFromLastSession,
    ensureTerminalConnected,
    loadRunCommands,
    loadBuildSettings,
    loadNamedCommands,
    loadPromptTemplates,
    loadPlanPromptTemplates,
    loadKeybindingMode,
    loadLspWorkspaceRootOverride,
    loadDock,
  ]);

  const topPanels = panelsInZone(dockPanels, 'top');
  const bottomPanels = panelsInZone(dockPanels, 'bottom');
  const leftPanels = panelsInZone(dockPanels, 'left');
  const rightPanels = panelsInZone(dockPanels, 'right');

  const runCommandTemplate = activeTab ? (runCommands[extensionOf(activeTab.name) ?? ''] ?? null) : null;

  function handleRun() {
    if (!activeTab || !runCommandTemplate) return;
    const relativePath = resolveRelativeFilePath(activeTab.pathSegments);
    queueRunRequest(buildRunCommand(runCommandTemplate, relativePath));
    setDockVisible('terminal', true);
  }

  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [workspacePathModalOpen, setWorkspacePathModalOpen] = useState(false);
  const [textEditMenu, setTextEditMenu] = useState<TextEditMenuState | null>(null);

  // App-wide commands, reachable from both AppCommandBar (the persistent
  // header bar) and QuickOpenModal's Ctrl+P ">" mode — defined once here
  // so the two can never drift apart. Currently just the one command;
  // more can be appended without either consumer changing.
  const commands: Command[] = useMemo(
    () => [
      {
        id: 'register-workspace-path',
        label: 'ワークスペースの実パスを登録...',
        run: () => setWorkspacePathModalOpen(true),
      },
    ],
    [],
  );

  // Ctrl+P (Cmd+P on mac) opens quick-open from anywhere, matching VS
  // Code — preventDefault so the browser's own print dialog doesn't fire.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickOpenOpen(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // The browser's native right-click menu never belongs in this app —
  // every position either has its own dedicated context menu (file tree,
  // editor tabs, terminal, dock panel tabs, Monaco itself) or falls back
  // to a generic 切り取り/コピー/貼り付け menu for plain text fields, or
  // shows nothing at all if none of that applies. A capture-phase
  // listener on the document catches every position, including ones with
  // no dedicated menu, before any per-element handler runs; those
  // handlers' own preventDefault()/stopPropagation() calls are unaffected
  // since capture always fires first regardless of what happens later.
  useEffect(() => {
    function handleContextMenu(e: MouseEvent) {
      e.preventDefault();
      const target = e.target as Element | null;
      if (!target) return;
      // These already supply their own richer context menu (or, for
      // Monaco/the terminal, their own native-feeling one) — never race
      // a generic text-edit menu on top of those.
      if (
        target.closest(
          '.file-tree, .dock-panel-tabs, .editor-group-tabs, .monaco-editor, .terminal-session-host',
        )
      ) {
        return;
      }
      const isTextArea = target instanceof HTMLTextAreaElement && !target.disabled;
      const isTextInput =
        target instanceof HTMLInputElement &&
        !target.disabled &&
        ['text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(target.type);
      if (isTextArea || isTextInput) {
        // Stop this same event from continuing on to window, where the
        // menu we're about to mount registers its own outside-click
        // dismiss listener — without this, that listener catches this
        // event's tail end on its way past and closes the menu the
        // instant it opens (the exact self-dismiss bug already fixed for
        // the file tree/editor tab menus, just via a different path since
        // this one opens from a document-level capture listener instead
        // of a per-element handler).
        e.stopPropagation();
        setTextEditMenu({ x: e.clientX, y: e.clientY, target: target as HTMLInputElement | HTMLTextAreaElement });
      }
    }
    document.addEventListener('contextmenu', handleContextMenu, true);
    return () => document.removeEventListener('contextmenu', handleContextMenu, true);
  }, []);

  async function handleSaveAs() {
    if (!activeTab || !rootHandle || activeTab.kind !== 'text' || !activeTab.model) return;
    const newName = window.prompt('名前を付けて保存', activeTab.name);
    if (!newName || newName === activeTab.name) return;
    try {
      const parentSegments = activeTab.pathSegments.slice(0, -1);
      const node = await ensureFileAtPath(rootHandle, [...parentSegments, newName].join('/'));
      await writeFileText(node.handle as FileSystemFileHandle, activeTab.model.getValue());
      await useWorkspaceStore.getState().refreshDirectoryAt(rootHandle, []);
      await openFile(node);
    } catch (err) {
      window.alert(`保存できませんでした: ${(err as Error).message}`);
    }
  }

  // Clicking a menu item moves DOM focus to the menu button, so the editor
  // is no longer focused by the time the command runs — harmless for plain
  // mutations (undo/comment toggle), but commands that open their own
  // focused widget (goto-line's quick-input, in particular) silently
  // no-op without an explicitly re-focused editor first.
  function triggerEditorAction(handlerId: string) {
    const editor = getActiveEditor();
    editor?.focus();
    editor?.trigger('menu', handlerId, null);
  }

  // editor.action.toggleWordWrap isn't registered in this Monaco build —
  // flip the option directly instead of going through .trigger().
  function handleToggleWordWrap() {
    const editor = getActiveEditor();
    if (!editor) return;
    const current = editor.getRawOptions().wordWrap;
    editor.updateOptions({ wordWrap: current === 'on' ? 'off' : 'on' });
    editor.focus();
  }

  // A single entry point into the unified settings window — its own left
  // nav is where プロンプト/実行コマンド etc. actually live now, so File
  // (and the activity bar's gear icon) only need to open it once.
  function openSettings() {
    setSettingsCategory('promptTemplates');
  }

  function handleShowAbout() {
    const version = chrome.runtime.getManifest().version;
    window.alert(`M365 Copilot Code Editor\nバージョン: ${version}`);
  }

  const menus: Menu[] = [
    {
      // Settings lives here (VS Code's own File > Preferences > Settings
      // precedent) rather than as its own top-level menu — one less menu
      // to scan, and it's grouped with the other "app-level" items instead
      // of floating on its own.
      label: 'ファイル',
      items: [
        { label: 'ファイルへ移動... (Ctrl+P)', onClick: () => setQuickOpenOpen(true), disabled: !rootHandle },
        { label: 'フォルダを開く...', onClick: () => void openFolder() },
        {
          label: '保存',
          onClick: () => {
            if (activeFileId) void saveFile(activeFileId);
          },
          disabled: !activeFileId,
        },
        {
          label: '名前を付けて保存...',
          onClick: () => void handleSaveAs(),
          disabled: !activeTab,
        },
        {
          label: 'フォルダを閉じる',
          onClick: () => void closeFolder(),
          disabled: status !== 'connected' && status !== 'needs-reconnect',
        },
        { separator: true },
        { label: '設定...', onClick: openSettings },
      ],
    },
    {
      label: '編集',
      items: [
        { label: '元に戻す (Ctrl+Z)', onClick: () => triggerEditorAction('undo') },
        { label: 'やり直し (Ctrl+Y)', onClick: () => triggerEditorAction('redo') },
        {
          label: '検索 (Ctrl+F)',
          onClick: () => triggerEditorAction('actions.find'),
        },
        {
          label: '置換 (Ctrl+H)',
          onClick: () => triggerEditorAction('editor.action.startFindReplaceAction'),
        },
        {
          label: '行コメントの切り替え (Ctrl+/)',
          onClick: () => triggerEditorAction('editor.action.commentLine'),
        },
        {
          label: 'ブロックコメントの切り替え',
          onClick: () => triggerEditorAction('editor.action.blockComment'),
        },
        {
          label: '行へ移動... (Ctrl+G)',
          onClick: () => triggerEditorAction('editor.action.gotoLine'),
        },
      ],
    },
    {
      label: '表示',
      items: [
        {
          label: 'ターミナル',
          onClick: () => toggleDockVisible('terminal'),
          checked: dockPanels.terminal.visible,
        },
        {
          label: 'Copilot',
          onClick: () => toggleDockVisible('copilot'),
          checked: dockPanels.copilot.visible,
        },
        {
          label: 'ビルドコンソール',
          onClick: () => toggleDockVisible('buildConsole'),
          checked: dockPanels.buildConsole.visible,
        },
        // Extension webview panels — only listed once registered (the
        // extension has been activated at least once this session; see
        // extensionsStore.ts's setWebviewHtml/registerPanel). Without
        // this, hiding one via its tab's own context menu (DockPanel.tsx)
        // had no way back if it was the only panel in its zone — the
        // whole zone stops rendering with zero visible panels, taking its
        // tab strip (and thus the "show" toggle that lives there) with
        // it. Real VS Code's own View menu lists every panel/view the
        // same way, not just built-ins.
        ...Object.keys(dockPanels)
          .filter((id) => parseExtensionPanelId(id))
          .map((id) => ({
            label: panelLabel(id, installedExtensions),
            onClick: () => toggleDockVisible(id),
            checked: dockPanels[id].visible,
          })),
        {
          label: '折り返しの切り替え (Alt+Z)',
          onClick: handleToggleWordWrap,
        },
      ],
    },
    {
      label: 'ビルド',
      items: [
        {
          label: 'ビルドを実行',
          onClick: () => {
            setDockVisible('buildConsole', true);
            useBuildStore.getState().requestAction('build');
          },
        },
      ],
    },
    {
      label: '実行',
      items: [
        {
          label: '通常実行',
          onClick: () => {
            setDockVisible('buildConsole', true);
            useBuildStore.getState().requestAction('run');
          },
          disabled: !runCommandTemplate,
        },
        {
          label: 'デバッガ実行',
          onClick: () => {
            setDockVisible('buildConsole', true);
            useBuildStore.getState().requestAction('debug');
          },
        },
      ],
    },
    {
      label: 'ヘルプ',
      items: [{ label: 'バージョン情報', onClick: handleShowAbout }],
    },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <img className="app-title-icon" src={ceLogoUrl} alt="M365 Copilot Code Editor" />
        <MenuBar menus={menus} />
        {status === 'needs-reconnect' && (
          <button onClick={() => void reconnect()}>ワークスペースに再接続</button>
        )}
        <AppCommandBar commands={commands} />
        {runCommandTemplate && <button onClick={handleRun}>▶ 実行</button>}
        {errorMessage && <span className="app-error">{errorMessage}</span>}
      </header>
      <WorkspacePathBanner onOpenModal={() => setWorkspacePathModalOpen(true)} />
      <div className="app-body">
        <ActivityBar
          activeView={activeSidebarView}
          onSelectView={selectSidebarView}
          onOpenSettings={openSettings}
        />
        {activeSidebarView && (
          <>
            <aside className="app-sidebar" style={{ width: sidebar.size }}>
              {activeSidebarView === 'extensions' ? (
                <ExtensionsPanel />
              ) : activeSidebarView === 'source-control' ? (
                <SourceControlPanel />
              ) : status === 'connected' ? (
                <FileTree />
              ) : (
                <div className="app-sidebar-empty">
                  <p>フォルダが開かれていません</p>
                  {status === 'needs-reconnect' ? (
                    <button onClick={() => void reconnect()}>ワークスペースに再接続</button>
                  ) : (
                    <button onClick={() => void openFolder()}>フォルダを開く</button>
                  )}
                </div>
              )}
            </aside>
            <ResizeHandle axis="x" {...sidebar.handleProps} />
          </>
        )}
        {/* top/bottom are the outer bands here (full content width, VS
            Code-style: the panel spans edge-to-edge and left/right sit
            between it and the top band), left/right are nested inside so
            they only span the height between top and bottom, not the
            full content height. */}
        <div className="app-content-column">
          {topPanels.length > 0 && (
            <>
              <DockPanel
                zone="top"
                panelIds={topPanels}
                activePanel={dockActiveByZone.top ?? topPanels[0]}
                size={topDock.size}
                split={dockSplitByZone.top ?? null}
                splitRatio={dockSplitRatio.top ?? 0.5}
                onSplitRatioChange={(ratio) => setDockSplitRatio('top', ratio)}
              />
              <ResizeHandle axis="y" {...topDock.handleProps} />
            </>
          )}
          <div className="app-content-row">
            {leftPanels.length > 0 && (
              <>
                <DockPanel
                  zone="left"
                  panelIds={leftPanels}
                  activePanel={dockActiveByZone.left ?? leftPanels[0]}
                  size={leftDock.size}
                  split={dockSplitByZone.left ?? null}
                  splitRatio={dockSplitRatio.left ?? 0.5}
                  onSplitRatioChange={(ratio) => setDockSplitRatio('left', ratio)}
                />
                <ResizeHandle axis="x" {...leftDock.handleProps} />
              </>
            )}
            <main className="app-main">
              <EditorToolbar />
              <div className="app-editor-area">
                <EditorLayout />
                <EditorDragOverlay />
                {status !== 'connected' && !viewingExtensionActive && (
                  <WelcomeScreen
                    needsReconnect={status === 'needs-reconnect'}
                    onOpenFolder={() => void openFolder()}
                    onReconnect={() => void reconnect()}
                  />
                )}
              </div>
            </main>
            {rightPanels.length > 0 && (
              <>
                <ResizeHandle axis="x" {...rightDock.handleProps} />
                <DockPanel
                  zone="right"
                  panelIds={rightPanels}
                  activePanel={dockActiveByZone.right ?? rightPanels[0]}
                  size={rightDock.size}
                  split={dockSplitByZone.right ?? null}
                  splitRatio={dockSplitRatio.right ?? 0.5}
                  onSplitRatioChange={(ratio) => setDockSplitRatio('right', ratio)}
                />
              </>
            )}
          </div>
          {bottomPanels.length > 0 && (
            <>
              <ResizeHandle axis="y" {...bottomDock.handleProps} />
              <DockPanel
                zone="bottom"
                panelIds={bottomPanels}
                activePanel={dockActiveByZone.bottom ?? bottomPanels[0]}
                size={bottomDock.size}
                split={dockSplitByZone.bottom ?? null}
                splitRatio={dockSplitRatio.bottom ?? 0.5}
                onSplitRatioChange={(ratio) => setDockSplitRatio('bottom', ratio)}
              />
            </>
          )}
        </div>
        <DockDragOverlay />
      </div>
      <ExtensionNotifications />
      <ExtensionQuickPick />
      <StatusBar />
      {settingsCategory && (
        <SettingsModal initialCategory={settingsCategory} onClose={() => setSettingsCategory(null)} />
      )}
      {quickOpenOpen && rootHandle && (
        <QuickOpenModal commands={commands} onClose={() => setQuickOpenOpen(false)} />
      )}
      {workspacePathModalOpen && (
        <WorkspaceRealPathModal onClose={() => setWorkspacePathModalOpen(false)} />
      )}
      {textEditMenu && <TextEditContextMenu state={textEditMenu} onClose={() => setTextEditMenu(null)} />}
      <OpenAnywayModal />
      <TerminalPanel backgroundCaptureOnly />
    </div>
  );
}
