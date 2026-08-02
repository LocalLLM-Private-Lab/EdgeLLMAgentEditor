import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDockStore } from '../state/dockStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useRunCommandStore, buildRunCommand, extensionOf } from '../state/runCommandStore';
import { useBreakpointStore } from '../state/breakpointStore';
import { useBuildStore, DEFAULT_DEBUG_LAUNCH_CONFIG, type BuildAction } from '../state/buildStore';
import { useDebugStore } from '../state/debugStore';
import { parseProjectLaunchConfigurations, parseProjectTasks, useProjectTaskStore, type ProjectLaunchConfiguration, type ProjectTask } from '../state/projectTaskStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { resolveRelativeFilePath } from '../terminal/resolveRelativeFilePath';
import { runAndCapture } from '../copilot/runAndCapture';
import './BuildConsolePanel.css';

function absoluteFilePath(root: string | null, pathSegments: string[]): string {
  if (!root) return pathSegments.join('/');
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${pathSegments.join(separator)}`;
}

function parseAdapterArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Fall back to a small command-line tokenizer for convenience.
  }
  return (trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((item) => item.replace(/^['"]|['"]$/g, ''));
}

function parseLaunchConfig(template: string, filePath: string, workspace: string | null): Record<string, unknown> {
  const encodedFilePath = JSON.stringify(filePath).slice(1, -1);
  const encodedWorkspace = JSON.stringify(workspace ?? '').slice(1, -1);
  const resolved = template
    .replaceAll('${file}', encodedFilePath)
    .replaceAll('${workspace}', encodedWorkspace)
    .replaceAll('${workspaceFolder}', encodedWorkspace)
    .replaceAll('{file}', encodedFilePath)
    .replaceAll('{workspace}', encodedWorkspace)
    .replaceAll('{breakpoints}', '');
  const parsed: unknown = JSON.parse(resolved);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('起動設定はJSONオブジェクトで指定してください。');
  return parsed as Record<string, unknown>;
}

function debugLanguageForFile(fileName: string): string | null {
  const extension = extensionOf(fileName);
  if (extension === 'py') return 'python';
  if (extension === 'go') return 'go';
  if (extension === 'c' || extension === 'cc' || extension === 'cpp' || extension === 'cxx' || extension === 'h' || extension === 'hpp') return 'cpp';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs' || extension === 'ts' || extension === 'tsx') return 'javascript';
  if (extension === 'rs') return 'rust';
  if (extension === 'rb') return 'ruby';
  return null;
}

function launchConfigurationMatchesLanguage(configuration: ProjectLaunchConfiguration, language: string | null): boolean {
  if (!language) return false;
  const name = typeof configuration.name === 'string' ? configuration.name.toLowerCase() : '';
  const type = typeof configuration.type === 'string' ? configuration.type.toLowerCase() : '';
  const descriptor = `${name} ${type}`;
  switch (language) {
    case 'python': return /python|debugpy/.test(descriptor);
    case 'go': return /go|delve/.test(descriptor);
    case 'cpp': return /c\+\+|cpp|cppdbg|cppvsdbg/.test(descriptor);
    case 'javascript': return /javascript|typescript|node|pwa-node|js-debug/.test(descriptor);
    case 'rust': return /rust|lldb|codelldb/.test(descriptor);
    case 'ruby': return /ruby|rdbg|readapt/.test(descriptor);
    default: return false;
  }
}

function defaultLaunchConfigForLanguage(language: string): string {
  switch (language) {
    case 'javascript': return '{"type":"pwa-node","request":"launch","program":"{file}","cwd":"{workspace}","sourceMaps":true}';
    case 'ruby': return '{"type":"ruby-debug","request":"launch","program":"{file}","programArgs":[],"useBundler":false}';
    case 'rust': return '{"type":"lldb","request":"launch","program":"{file}","cwd":"{workspace}"}';
    case 'go': return '{"type":"go","request":"launch","program":"{file}","cwd":"{workspace}"}';
    case 'cpp': return '{"type":"cppdbg","request":"launch","program":"{file}","cwd":"{workspace}"}';
    default: return DEFAULT_DEBUG_LAUNCH_CONFIG;
  }
}

function shellPath(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function resolveProjectCommand(template: string, filePath: string, workspace: string | null): string {
  const workspaceValue = workspace ? shellPath(workspace) : '';
  const normalized = template
    .replaceAll('${file}', '{file}')
    .replaceAll('${workspaceFolder}', workspaceValue)
    .replaceAll('${workspace}', workspaceValue);
  return buildRunCommand(normalized, filePath);
}

function resolveProjectCwd(template: string | undefined, workspace: string | null): string | undefined {
  if (!template?.trim()) return workspace ?? undefined;
  const normalized = template
    .trim()
    .replaceAll('${workspaceFolder}', workspace ?? '')
    .replaceAll('${workspace}', workspace ?? '')
    .replaceAll('{workspace}', workspace ?? '');
  if (!workspace || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\') || normalized.startsWith('/')) return normalized;
  const separator = workspace.includes('\\') ? '\\' : '/';
  return `${workspace.replace(/[\\/]+$/, '')}${separator}${normalized.replace(/^[\\/]+/, '')}`;
}

function projectTask(tasks: ProjectTask[], id: string): ProjectTask | undefined {
  return tasks.find((task) => task.id === id) ?? tasks.find((task) => task.label?.toLowerCase() === id);
}

function safeProjectTasks(value: string): ProjectTask[] {
  try {
    return parseProjectTasks(value);
  } catch {
    return [];
  }
}

function safeProjectLaunchConfigurations(value: string): ProjectLaunchConfiguration[] {
  try {
    return parseProjectLaunchConfigurations(value);
  } catch {
    return [];
  }
}

export function BuildConsolePanel() {
  const activeFileId = useEditorTabsStore((state) => state.activeFileId);
  const openFiles = useEditorTabsStore((state) => state.openFiles);
  const runCommands = useRunCommandStore((state) => state.commands);
  const setDockVisible = useDockStore((state) => state.setVisible);
  const rootHandle = useWorkspaceStore((state) => state.rootHandle);
  const workspaceRealPath = useWorkspaceStore((state) => state.workspaceRealPath);
  const activeTab = openFiles.find((file) => file.id === activeFileId);
  const activePath = activeTab?.pathSegments.join('/') ?? '';
  const breakpoints = useBreakpointStore((state) => state.breakpoints[activePath] ?? EMPTY_BREAKPOINTS);

  const buildCommand = useBuildStore((state) => state.buildCommand);
  const debugAdapterCommand = useBuildStore((state) => state.debugAdapterCommand);
  const debugAdapterArgs = useBuildStore((state) => state.debugAdapterArgs);
  const autoInstallDebugAdapter = useBuildStore((state) => state.autoInstallDebugAdapter);
  const debugLaunchConfig = useBuildStore((state) => state.debugLaunchConfig);
  const output = useBuildStore((state) => state.output);
  const lastCommand = useBuildStore((state) => state.lastCommand);
  const lastExitCode = useBuildStore((state) => state.lastExitCode);
  const running = useBuildStore((state) => state.running);
  const pendingAction = useBuildStore((state) => state.pendingAction);
  const loadSettings = useBuildStore((state) => state.loadSettings);
  const setResult = useBuildStore((state) => state.setResult);
  const setRunning = useBuildStore((state) => state.setRunning);
  const consumeAction = useBuildStore((state) => state.consumeAction);
  const clearOutput = useBuildStore((state) => state.clearOutput);

  const projectTasksJson = useProjectTaskStore((state) => state.tasksJson);
  const projectLaunchJson = useProjectTaskStore((state) => state.launchJson);
  const projectSettingsLoaded = useProjectTaskStore((state) => state.loaded);
  const loadProjectSettings = useProjectTaskStore((state) => state.loadProjectSettings);

  const debugStatus = useDebugStore((state) => state.status);
  const debugMessage = useDebugStore((state) => state.message);
  const debugOutput = useDebugStore((state) => state.output);
  const stackFrames = useDebugStore((state) => state.stackFrames);
  const scopes = useDebugStore((state) => state.scopes);
  const variables = useDebugStore((state) => state.variables);
  const startDebugger = useDebugStore((state) => state.start);
  const ensureAdapter = useDebugStore((state) => state.ensureAdapter);
  const setDebugMessage = useDebugStore((state) => state.setMessage);
  const stopDebugger = useDebugStore((state) => state.stop);
  const continueExecution = useDebugStore((state) => state.continueExecution);
  const pause = useDebugStore((state) => state.pause);
  const stepOver = useDebugStore((state) => state.stepOver);
  const stepInto = useDebugStore((state) => state.stepInto);
  const stepOut = useDebugStore((state) => state.stepOut);
  const selectFrame = useDebugStore((state) => state.selectFrame);
  const clearDebugger = useDebugStore((state) => state.clear);
  const [debugConfigError, setDebugConfigError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadProjectSettings();
  }, [loadProjectSettings, rootHandle]);

  const projectTasks = useMemo(() => safeProjectTasks(projectTasksJson), [projectTasksJson]);
  const projectLaunchConfigurations = useMemo(() => safeProjectLaunchConfigurations(projectLaunchJson), [projectLaunchJson]);
  const projectAutoInstallDebugAdapter = typeof projectLaunchConfigurations[0]?.autoInstallDebugAdapter === 'boolean'
    ? projectLaunchConfigurations[0].autoInstallDebugAdapter
    : autoInstallDebugAdapter;
  const projectAdapterCommand = typeof projectLaunchConfigurations[0]?.adapterCommand === 'string'
    ? projectLaunchConfigurations[0].adapterCommand.trim()
    : '';
  const projectBuildTask = projectTask(projectTasks, 'build');
  const projectRunTask = projectTask(projectTasks, 'run');
  const effectiveBuildCommand = projectBuildTask?.command.trim() || buildCommand;
  const runTemplate = activeTab ? runCommands[extensionOf(activeTab.name) ?? ''] : undefined;
  const effectiveRunCommand = projectRunTask?.command.trim() || runTemplate;

  const execute = useCallback(
    async (action: Exclude<BuildAction, 'debug'>) => {
      if (running || !activeTab || activeTab.kind !== 'text') return;
      const filePath = resolveRelativeFilePath(activeTab.pathSegments);
      const template = action === 'build' ? effectiveBuildCommand : effectiveRunCommand;
      if (!template) return;
      const command = resolveProjectCommand(template, filePath, workspaceRealPath);
      const taskCwd = action === 'build' ? projectBuildTask?.cwd : projectRunTask?.cwd;
      setRunning(true);
      // Keep a normal terminal session mounted for the foreground capture,
      // while making the build console the active panel that shows the live
      // captured output.
      setDockVisible('terminal', true);
      setDockVisible('buildConsole', true);
      setResult({ output: '', command, exitCode: null });
      try {
        const result = await runAndCapture(command, action === 'build' ? 'ビルド' : '通常実行', {
          background: false,
          cwd: resolveProjectCwd(taskCwd, workspaceRealPath),
          onOutput: (liveOutput) => setResult({ output: liveOutput || '(実行中...)', command, exitCode: null }),
        });
        setResult({ output: result.output || '(出力なし)', command: result.command, exitCode: result.exitCode });
      } finally {
        setRunning(false);
      }
    },
    [activeTab, effectiveBuildCommand, effectiveRunCommand, projectBuildTask?.cwd, projectRunTask?.cwd, running, setDockVisible, setResult, setRunning, workspaceRealPath],
  );

  const start = useCallback(async () => {
    if (!activeTab || activeTab.kind !== 'text' || debugStatus === 'starting' || debugStatus === 'running' || debugStatus === 'paused') return;
    setDebugConfigError(null);
    try {
      const filePath = absoluteFilePath(workspaceRealPath, activeTab.pathSegments);
      const language = debugLanguageForFile(activeTab.name);
      const projectLaunchConfiguration = projectLaunchConfigurations.find((configuration) => launchConfigurationMatchesLanguage(configuration, language));
      const launchConfiguration = projectLaunchConfiguration
        ? { ...projectLaunchConfiguration }
        : null;
      const configuredAdapterCommand = typeof launchConfiguration?.adapterCommand === 'string' ? launchConfiguration.adapterCommand : '';
      const configuredAdapterArgs = Array.isArray(launchConfiguration?.adapterArgs) && launchConfiguration.adapterArgs.every((item) => typeof item === 'string')
        ? launchConfiguration.adapterArgs as string[]
        : typeof launchConfiguration?.adapterArgs === 'string' ? parseAdapterArgs(launchConfiguration.adapterArgs) : [];
      const configuredAdapterTransport = launchConfiguration?.adapterTransport === 'tcp' ? 'tcp' : 'stdio';
      const configuredAdapterPort = typeof launchConfiguration?.adapterPort === 'number' ? launchConfiguration.adapterPort : undefined;
      const configuredAutoInstall = typeof launchConfiguration?.autoInstallDebugAdapter === 'boolean'
        ? launchConfiguration.autoInstallDebugAdapter
        : autoInstallDebugAdapter;
      if (launchConfiguration) {
        delete launchConfiguration.adapterCommand;
        delete launchConfiguration.adapterArgs;
        delete launchConfiguration.adapterTransport;
        delete launchConfiguration.adapterPort;
        delete launchConfiguration.autoInstallDebugAdapter;
      }
      const launchTemplate = launchConfiguration
        ? JSON.stringify(launchConfiguration)
        : debugLaunchConfig === DEFAULT_DEBUG_LAUNCH_CONFIG && language ? defaultLaunchConfigForLanguage(language) : debugLaunchConfig;
      const launchArguments = parseLaunchConfig(launchTemplate, filePath, workspaceRealPath);
      let adapterCommand = configuredAdapterCommand.trim() || debugAdapterCommand.trim();
      let adapterArgs = configuredAdapterCommand.trim() ? configuredAdapterArgs : parseAdapterArgs(debugAdapterArgs);
      let adapterTransport: 'stdio' | 'tcp' = configuredAdapterCommand.trim() ? configuredAdapterTransport : 'stdio';
      let adapterPort: number | undefined = configuredAdapterCommand.trim() ? configuredAdapterPort : undefined;
      if (configuredAutoInstall && !adapterCommand) {
        if (!language) throw new Error('この言語のDAPアダプター自動導入には未対応です。実行ファイルを手動指定してください。');
        setDebugMessage(`${language}用DAPアダプターを確認・導入しています...`);
        const resolved = await ensureAdapter(language);
        adapterCommand = resolved.command;
        adapterArgs = resolved.args;
        adapterTransport = resolved.transport;
        adapterPort = resolved.port ?? undefined;
      }
      if (!adapterCommand) throw new Error('デバッグアダプターの実行ファイルを指定してください。');
      await startDebugger({
        adapterCommand,
        adapterArgs,
        adapterTransport,
        adapterPort,
        cwd: workspaceRealPath ?? undefined,
        launchArguments,
        sourcePath: filePath,
        breakpoints,
      });
    } catch (error) {
      setDebugConfigError(error instanceof Error ? error.message : 'デバッグ設定を読み込めません。');
    }
  }, [activeTab, autoInstallDebugAdapter, breakpoints, debugAdapterArgs, debugAdapterCommand, debugLaunchConfig, debugStatus, ensureAdapter, projectLaunchConfigurations, setDebugMessage, startDebugger, workspaceRealPath]);

  useEffect(() => {
    if (!pendingAction || !projectSettingsLoaded) return;
    const action = consumeAction();
    if (action === 'debug') void start();
    else if (action) void execute(action);
  }, [consumeAction, execute, pendingAction, projectSettingsLoaded, start]);

  const debugActive = debugStatus === 'starting' || debugStatus === 'running' || debugStatus === 'paused';

  return (
    <div className="build-console-panel">
      <div className="build-console-toolbar">
        <button onClick={() => void execute('build')} disabled={running || !effectiveBuildCommand.trim()}>
          {running ? '実行中...' : 'ビルド'}
        </button>
        <button onClick={() => void execute('run')} disabled={running || !effectiveRunCommand || !activeTab}>
          通常実行
        </button>
        <button onClick={() => void start()} disabled={debugActive || (!projectAutoInstallDebugAdapter && !projectAdapterCommand && !debugAdapterCommand.trim()) || !activeTab}>
          デバッガ開始
        </button>
        <button onClick={stopDebugger} disabled={!debugActive}>
          停止
        </button>
        <button onClick={continueExecution} disabled={debugStatus !== 'paused'}>
          再開
        </button>
        <button onClick={pause} disabled={debugStatus !== 'running'}>
          一時停止
        </button>
        <button onClick={stepOver} disabled={debugStatus !== 'paused'}>
          ステップオーバー
        </button>
        <button onClick={stepInto} disabled={debugStatus !== 'paused'}>
          ステップイン
        </button>
        <button onClick={stepOut} disabled={debugStatus !== 'paused'}>
          ステップアウト
        </button>
        <button onClick={() => { clearOutput(); clearDebugger(); }} disabled={running || debugActive}>
          クリア
        </button>
        <span className={`debug-status debug-status-${debugStatus}`}>デバッグ: {debugStatus}</span>
        {lastCommand && <span className={`build-console-result ${lastExitCode === 0 ? 'success' : 'failure'}`}>終了コード: {lastExitCode ?? '不明'}</span>}
      </div>

      {debugConfigError && <div className="debug-error">{debugConfigError}</div>}
      <div className="build-console-breakpoints">
        <span>ブレークポイント</span>
        <span>{breakpoints.length > 0 ? `${activePath}: ${breakpoints.join(', ')}` : '設定なし'}</span>
      </div>

      <div className="debug-layout">
        <section className="debug-section">
          <h4>コールスタック</h4>
          {stackFrames.length === 0 ? <div className="build-console-empty">停止時に表示されます。</div> : stackFrames.map((frame) => (
            <button className="debug-stack-frame" key={frame.id} onClick={() => selectFrame(frame.id)}>
              <span>{frame.name}</span>
              <small>{frame.source?.name ?? ''}:{frame.line ?? ''}</small>
            </button>
          ))}
        </section>
        <section className="debug-section">
          <h4>スコープ</h4>
          {scopes.length === 0 ? <div className="build-console-empty">停止時に表示されます。</div> : scopes.map((scope) => <div className="debug-scope" key={`${scope.name}-${scope.variablesReference}`}>{scope.name}</div>)}
          <h4>変数</h4>
          {variables.length === 0 ? <div className="build-console-empty">ローカル変数は停止時に表示されます。</div> : variables.map((variable) => <div className="debug-variable" key={variable.name}><span>{variable.name}</span><span>{variable.type ? `${variable.type} ` : ''}{variable.value}</span></div>)}
        </section>
      </div>

      {debugMessage && <div className="debug-message">{debugMessage}</div>}
      {(lastCommand || debugOutput) && <div className="build-console-command">{lastCommand || 'デバッグ出力'}</div>}
      <pre className="build-console-output">{debugActive || debugOutput ? debugOutput : output}</pre>
    </div>
  );
}

const EMPTY_BREAKPOINTS: number[] = [];
