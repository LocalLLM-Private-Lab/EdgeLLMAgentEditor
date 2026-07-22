import { useEffect, useState } from 'react';
import { useWorkspaceStore } from './state/workspaceStore';
import { useEditorTabsStore } from './state/editorTabsStore';
import { useTerminalStore } from './state/terminalStore';
import { useKeybindingStore } from './state/keybindingStore';
import { useLspStore } from './lsp/lspStore';
import { useRunCommandStore, extensionOf, buildRunCommand } from './state/runCommandStore';
import { resolveRelativeFilePath } from './terminal/resolveRelativeFilePath';
import { getStoredValue, setStoredValue } from '../shared/chromeStorage';
import { FileTree } from './components/FileTree/FileTree';
import { EditorTabs } from './components/EditorTabs/EditorTabs';
import { MonacoEditorPane } from './components/MonacoEditorPane';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import { BottomPanel, type BottomPanelTab } from './components/BottomPanel';
import { MenuBar, type Menu } from './components/MenuBar';
import { RunCommandSettingsModal } from './components/RunCommandSettingsModal';
import { PromptTemplateSettingsModal } from './components/PromptTemplateSettingsModal';
import { PlanPromptTemplateSettingsModal } from './components/PlanPromptTemplateSettingsModal';
import { ResizeHandle } from './components/ResizeHandle';
import { QuickOpenModal } from './components/QuickOpenModal';
import { useResizable } from './hooks/useResizable';
import { usePromptTemplateStore } from './state/promptTemplateStore';
import { usePlanPromptTemplateStore } from './state/planPromptTemplateStore';
import { getActiveEditor } from './monaco/editorInstanceRegistry';
import { ensureFileAtPath } from './copilot/resolveWorkspaceFile';
import { writeFileText } from './fs/fsaWorkspace';

const PANEL_STATE_STORAGE_KEY = 'uiPanelState';

interface PanelState {
  terminalEnabled: boolean;
  copilotEnabled: boolean;
  activePanelTab: BottomPanelTab | null;
}

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

  const loadTerminalSettings = useTerminalStore((s) => s.loadSettings);
  const terminalSettings = useTerminalStore((s) => s.settings);
  const connectTerminal = useTerminalStore((s) => s.connect);

  const keybindingMode = useKeybindingStore((s) => s.mode);
  const setKeybindingMode = useKeybindingStore((s) => s.setMode);
  const loadKeybindingMode = useKeybindingStore((s) => s.loadMode);

  const loadLspWorkspaceRootOverride = useLspStore((s) => s.loadWorkspaceRootOverride);

  const runCommands = useRunCommandStore((s) => s.commands);
  const loadRunCommands = useRunCommandStore((s) => s.loadCommands);
  const queueRunRequest = useTerminalStore((s) => s.queueRunRequest);
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const [promptSettingsOpen, setPromptSettingsOpen] = useState(false);
  const [planPromptSettingsOpen, setPlanPromptSettingsOpen] = useState(false);
  const loadPromptTemplates = usePromptTemplateStore((s) => s.loadTemplates);
  const loadPlanPromptTemplates = usePlanPromptTemplateStore((s) => s.loadTemplates);

  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [copilotEnabled, setCopilotEnabled] = useState(false);
  const [activePanelTab, setActivePanelTab] = useState<BottomPanelTab | null>(null);
  const [panelStateLoaded, setPanelStateLoaded] = useState(false);

  const sidebar = useResizable({
    storageKey: 'uiSidebarWidth',
    defaultSize: 260,
    min: 150,
    max: 600,
    axis: 'x',
    directionSign: 1,
  });
  const bottomPanel = useResizable({
    storageKey: 'uiBottomPanelHeight',
    defaultSize: 300,
    min: 120,
    max: 800,
    axis: 'y',
    directionSign: -1,
  });

  useEffect(() => {
    void restoreFromLastSession();
    void loadTerminalSettings();
    void loadRunCommands();
    void loadPromptTemplates();
    void loadPlanPromptTemplates();
    void loadKeybindingMode();
    void loadLspWorkspaceRootOverride();
  }, [
    restoreFromLastSession,
    loadTerminalSettings,
    loadRunCommands,
    loadPromptTemplates,
    loadPlanPromptTemplates,
    loadKeybindingMode,
    loadLspWorkspaceRootOverride,
  ]);

  // Connects to terminal-host as soon as its settings are known, even
  // before the terminal panel has ever been opened, so the terminal
  // connects promptly whenever the panel is first opened.
  useEffect(() => {
    if (terminalSettings) connectTerminal();
  }, [terminalSettings, connectTerminal]);

  // Restore which bottom-panel tabs (if any) were enabled last time.
  useEffect(() => {
    void getStoredValue<PanelState>(PANEL_STATE_STORAGE_KEY).then((saved) => {
      if (saved) {
        setTerminalEnabled(saved.terminalEnabled);
        setCopilotEnabled(saved.copilotEnabled);
        setActivePanelTab(saved.activePanelTab);
      }
      setPanelStateLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!panelStateLoaded) return;
    void setStoredValue(PANEL_STATE_STORAGE_KEY, {
      terminalEnabled,
      copilotEnabled,
      activePanelTab,
    } satisfies PanelState);
  }, [terminalEnabled, copilotEnabled, activePanelTab, panelStateLoaded]);

  const isEnabled = (tab: BottomPanelTab) => (tab === 'terminal' ? terminalEnabled : copilotEnabled);
  const setEnabled = (tab: BottomPanelTab, value: boolean) =>
    tab === 'terminal' ? setTerminalEnabled(value) : setCopilotEnabled(value);
  const otherTab = (tab: BottomPanelTab): BottomPanelTab => (tab === 'terminal' ? 'copilot' : 'terminal');

  // View menu click: toggles that tab's on/off state independently of the
  // other one. Turning one off removes it from the panel's tab strip
  // entirely (rather than just switching which one is displayed) — if it
  // was the one currently shown, fall back to the other tab if it's still
  // enabled, or close the panel if nothing is left enabled.
  function toggleTab(tab: BottomPanelTab) {
    const enabling = !isEnabled(tab);
    setEnabled(tab, enabling);
    if (enabling) {
      setActivePanelTab(tab);
    } else if (activePanelTab === tab) {
      setActivePanelTab(isEnabled(otherTab(tab)) ? otherTab(tab) : null);
    }
  }

  // Always ensures a tab is enabled and brought into view, without the
  // toggle-off behavior above — used when a non-menu action (e.g. Run)
  // needs the terminal visible regardless of its current state.
  function showTab(tab: BottomPanelTab) {
    setEnabled(tab, true);
    setActivePanelTab(tab);
  }

  const runCommandTemplate = activeTab ? (runCommands[extensionOf(activeTab.name) ?? ''] ?? null) : null;

  function handleRun() {
    if (!activeTab || !runCommandTemplate) return;
    const relativePath = resolveRelativeFilePath(activeTab.pathSegments);
    queueRunRequest(buildRunCommand(runCommandTemplate, relativePath));
    showTab('terminal');
  }

  const [quickOpenOpen, setQuickOpenOpen] = useState(false);

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

  async function handleSaveAs() {
    if (!activeTab || !rootHandle) return;
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

  const menus: Menu[] = [
    {
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
          onClick: () => toggleTab('terminal'),
          checked: terminalEnabled,
        },
        {
          label: 'Copilot',
          onClick: () => toggleTab('copilot'),
          checked: copilotEnabled,
        },
        {
          label: '折り返しの切り替え (Alt+Z)',
          onClick: handleToggleWordWrap,
        },
      ],
    },
    {
      label: '操作',
      items: [
        {
          label: 'キーバインド: デフォルト',
          onClick: () => void setKeybindingMode('default'),
          checked: keybindingMode === 'default',
        },
        {
          label: 'キーバインド: Vim',
          onClick: () => void setKeybindingMode('vim'),
          checked: keybindingMode === 'vim',
        },
        {
          label: 'キーバインド: Emacs',
          onClick: () => void setKeybindingMode('emacs'),
          checked: keybindingMode === 'emacs',
        },
      ],
    },
    {
      label: '設定',
      items: [
        { label: '拡張子ごとの実行コマンド...', onClick: () => setRunSettingsOpen(true) },
        { label: 'プロンプトテンプレート...', onClick: () => setPromptSettingsOpen(true) },
        { label: '計画プロンプトテンプレート...', onClick: () => setPlanPromptSettingsOpen(true) },
      ],
    },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">M365 Copilot Code Editor</span>
        <MenuBar menus={menus} />
        {status === 'needs-reconnect' && (
          <button onClick={() => void reconnect()}>ワークスペースに再接続</button>
        )}
        <div className="app-header-spacer" />
        {runCommandTemplate && <button onClick={handleRun}>▶ 実行</button>}
        {errorMessage && <span className="app-error">{errorMessage}</span>}
      </header>
      <div className="app-body">
        <aside className="app-sidebar" style={{ width: sidebar.size }}>
          {status === 'connected' ? (
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
        <main className="app-main">
          <EditorTabs />
          <div className="app-editor-area">
            <MonacoEditorPane />
            {status !== 'connected' && (
              <WelcomeScreen
                needsReconnect={status === 'needs-reconnect'}
                onOpenFolder={() => void openFolder()}
                onReconnect={() => void reconnect()}
              />
            )}
          </div>
          {activePanelTab && (
            <>
              <ResizeHandle axis="y" {...bottomPanel.handleProps} />
              <BottomPanel
                activeTab={activePanelTab}
                onSelectTab={setActivePanelTab}
                terminalEnabled={terminalEnabled}
                copilotEnabled={copilotEnabled}
                height={bottomPanel.size}
              />
            </>
          )}
        </main>
      </div>
      <StatusBar />
      {runSettingsOpen && <RunCommandSettingsModal onClose={() => setRunSettingsOpen(false)} />}
      {promptSettingsOpen && (
        <PromptTemplateSettingsModal onClose={() => setPromptSettingsOpen(false)} />
      )}
      {planPromptSettingsOpen && (
        <PlanPromptTemplateSettingsModal onClose={() => setPlanPromptSettingsOpen(false)} />
      )}
      {quickOpenOpen && rootHandle && <QuickOpenModal onClose={() => setQuickOpenOpen(false)} />}
    </div>
  );
}
