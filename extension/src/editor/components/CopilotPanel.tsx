import { useState } from 'react';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePromptTemplateStore } from '../state/promptTemplateStore';
import { useRunCommandStore, extensionOf, buildRunCommand } from '../state/runCommandStore';
import { useNamedCommandStore } from '../state/namedCommandStore';
import { useDockStore } from '../state/dockStore';
import { buildFileEditPrompt, buildToolResultPrompt, buildRunResultPrompt } from '../copilot/promptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { extractCodeBlocks, type ExtractedCodeBlock } from '../copilot/codeBlockParser';
import { detectControlFlow } from '../copilot/responseControl';
import { runGrepSearch, runListFiles } from '../copilot/localTools';
import { resolveRunToolRequest, resolveNamedToolRequest, type RunToolResolution } from '../copilot/runToolResolver';
import { runAndCapture } from '../copilot/runAndCapture';
import { resolveRelativeFilePath } from '../terminal/resolveRelativeFilePath';
import {
  prepareApplyToTreeNode,
  prepareApplyForNewFile,
  type ApplyPreview,
} from '../copilot/applyToFileFlow';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { readFileText } from '../fs/fsaWorkspace';
import { FileContextPicker } from './FileContextPicker';
import { DiffViewModal } from './DiffViewModal';
import { PlanPanel } from './PlanPanel';
import { ToolRunConfirmation } from './ToolRunConfirmation';
import './CopilotPanel.css';

type CopilotSubTab = 'quick' | 'plan';
type CopilotMode = 'edit' | 'analysis';

export function CopilotPanel() {
  // Top-level choice: what am I trying to do. Drives `analysisOnly`
  // uniformly across both the quick-request flow and PlanPanel/
  // PlanStepCard. Both the quick-request panel and PlanPanel are mounted
  // twice — once per mode — and kept alive simultaneously (see `visible`
  // below) rather than conditionally rendered, so switching modes never
  // resets or mixes together an in-progress edit session with an
  // in-progress analysis session.
  const [mode, setMode] = useState<CopilotMode>('edit');
  const [subTab, setSubTab] = useState<CopilotSubTab>('quick');

  return (
    <div className="copilot-panel">
      <div className="copilot-mode-tabs">
        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
          編集モード
        </button>
        <button className={mode === 'analysis' ? 'active' : ''} onClick={() => setMode('analysis')}>
          解析モード
        </button>
      </div>
      <div className="copilot-subtabs">
        <button
          className={subTab === 'quick' ? 'active' : ''}
          onClick={() => setSubTab('quick')}
        >
          単発リクエスト
        </button>
        <button className={subTab === 'plan' ? 'active' : ''} onClick={() => setSubTab('plan')}>
          計画実行
        </button>
      </div>

      <QuickRequestPanel analysisOnly={false} visible={mode === 'edit' && subTab === 'quick'} />
      <QuickRequestPanel analysisOnly={true} visible={mode === 'analysis' && subTab === 'quick'} />
      <PlanPanel analysisOnly={false} visible={mode === 'edit' && subTab === 'plan'} />
      <PlanPanel analysisOnly={true} visible={mode === 'analysis' && subTab === 'plan'} />
    </div>
  );
}

interface QuickRequestPanelProps {
  /** Fixed for this instance's whole lifetime — CopilotPanel mounts one
   * QuickRequestPanel per mode rather than toggling this on a shared
   * instance, so each mode's instruction/response/blocks stay independent
   * local state instead of one shared set that gets reinterpreted when the
   * mode changes. */
  analysisOnly: boolean;
  visible: boolean;
}

function QuickRequestPanel({ analysisOnly, visible }: QuickRequestPanelProps) {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const promptTemplates = usePromptTemplateStore((s) => s.templates);
  const selectedTemplateId = usePromptTemplateStore((s) => s.selectedTemplateId);
  const selectPromptTemplate = usePromptTemplateStore((s) => s.selectTemplate);
  const promptTemplate =
    promptTemplates.find((t) => t.id === selectedTemplateId)?.template ?? promptTemplates[0]?.template;

  const [status, setStatus] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [includeRepoMap, setIncludeRepoMap] = useState(false);
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [pastedResponse, setPastedResponse] = useState('');
  const [blocks, setBlocks] = useState<ExtractedCodeBlock[]>([]);
  const [applyTargetByBlock, setApplyTargetByBlock] = useState<Record<string, string>>({});
  const [diffPreview, setDiffPreview] = useState<ApplyPreview | null>(null);
  const [justCopiedPrompt, setJustCopiedPrompt] = useState(false);
  const [analysisText, setAnalysisText] = useState<string | null>(null);

  const runCommands = useRunCommandStore((s) => s.commands);
  const namedCommands = useNamedCommandStore((s) => s.commands);
  const runCommandTemplate = activeTab ? (runCommands[extensionOf(activeTab.name) ?? ''] ?? null) : null;
  const [checkingRun, setCheckingRun] = useState(false);

  const [pendingToolRun, setPendingToolRun] = useState<{ path: string; command: string } | null>(null);
  const [runningToolRun, setRunningToolRun] = useState(false);

  // Takes an explicit file list rather than reading contextFiles from state
  // — handleParseResponse needs to copy a prompt built from a just-merged
  // list in the same tick a NEED_FILES reply is detected, before the state
  // update from that merge has actually landed.
  async function copyPromptWithFiles(files: string[]) {
    if (!rootHandle) return;
    const repoMap = includeRepoMap ? await buildRepoMap(rootHandle) : undefined;
    const resolved = await resolveWorkspaceFiles(rootHandle, files);
    const resolvedFiles = await Promise.all(
      [...resolved.entries()].map(async ([path, node]) => {
        // Prefer the live editor buffer over disk in case it's unsaved —
        // image tabs have no text buffer at all, so fall back to disk same
        // as if it weren't open (not meaningfully "text" either way).
        const openTab = openFiles.find((f) => f.pathSegments.join('/') === path);
        const content =
          openTab?.model?.getValue() ?? (await readFileText(node.handle as FileSystemFileHandle));
        return { path, content };
      }),
    );
    // A path that isn't a real file yet (e.g. added via a NEED_FILES
    // request for a file Copilot wants created) shouldn't just vanish from
    // the prompt — say so explicitly instead of silently dropping it.
    const newFiles = files
      .filter((path) => !resolved.has(path))
      .map((path) => ({ path, content: '', isNew: true }));
    const prompt = buildFileEditPrompt(
      instruction,
      [...resolvedFiles, ...newFiles],
      repoMap,
      promptTemplate,
      analysisOnly,
    );
    await navigator.clipboard.writeText(prompt);
  }

  async function handleCopyPrompt() {
    await copyPromptWithFiles(contextFiles);
    setJustCopiedPrompt(true);
    setStatus(null);
  }

  // Each block defaults to its own detected suggestedPath — critical for a
  // multi-file response (several `path`:\n```\n...``` blocks), where every
  // block needs a DIFFERENT target. Only when a block has no detected path
  // at all does it fall back to the active file, since that's the one
  // sensible guess for a genuinely single-file response.
  async function handleParseResponse() {
    if (!pastedResponse.trim()) return;
    const flow = detectControlFlow(pastedResponse);

    if (flow.kind === 'needFiles') {
      const merged = [...new Set([...contextFiles, ...flow.paths])];
      setContextFiles(merged);
      setBlocks([]);
      setAnalysisText(null);
      setPastedResponse('');
      setJustCopiedPrompt(false);
      setStatus('Copilotの要求に応じてファイルを追加中...');
      void copyPromptWithFiles(merged).then(() => {
        setJustCopiedPrompt(true);
        setStatus(`Copilotの要求により以下のファイルをコンテキストに追加しました: ${flow.paths.join(', ')}`);
      });
      return;
    }

    if (flow.kind === 'grep' && rootHandle) {
      setBlocks([]);
      setAnalysisText(null);
      setPastedResponse('');
      setJustCopiedPrompt(false);
      setStatus(`「${flow.pattern}」を検索中...`);
      void runGrepSearch(rootHandle, flow.pattern).then(async (result) => {
        await navigator.clipboard.writeText(buildToolResultPrompt('検索(grep)', flow.pattern, result));
        setJustCopiedPrompt(true);
        setStatus('検索結果を踏まえたプロンプトをコピーしました。');
      });
      return;
    }

    if (flow.kind === 'listFiles' && rootHandle) {
      setBlocks([]);
      setAnalysisText(null);
      setPastedResponse('');
      setJustCopiedPrompt(false);
      setStatus('ファイル一覧を取得中...');
      void runListFiles(rootHandle, flow.query).then(async (result) => {
        await navigator.clipboard.writeText(buildToolResultPrompt('ファイル一覧', flow.query, result));
        setJustCopiedPrompt(true);
        setStatus('ファイル一覧を踏まえたプロンプトをコピーしました。');
      });
      return;
    }

    if (flow.kind === 'runTool' && rootHandle) {
      setBlocks([]);
      setAnalysisText(null);
      setPastedResponse('');
      setJustCopiedPrompt(false);
      setStatus(`「${flow.path}」の実行可否を確認中...`);
      const resolution: RunToolResolution = await resolveRunToolRequest(rootHandle, flow.path, runCommands);
      if (!resolution.ok) {
        await navigator.clipboard.writeText(buildToolResultPrompt('実行リクエスト', resolution.path, resolution.message));
        setJustCopiedPrompt(true);
        setStatus('実行できなかった旨を踏まえたプロンプトをコピーしました。');
        return;
      }
      setPendingToolRun({ path: resolution.path, command: resolution.command });
      setStatus(null);
      return;
    }

    if (flow.kind === 'runToolNamed') {
      setBlocks([]);
      setAnalysisText(null);
      setPastedResponse('');
      setJustCopiedPrompt(false);
      setStatus(`「${flow.name}」の実行可否を確認中...`);
      const resolution: RunToolResolution = resolveNamedToolRequest(flow.name, namedCommands);
      if (!resolution.ok) {
        await navigator.clipboard.writeText(buildToolResultPrompt('実行リクエスト', resolution.path, resolution.message));
        setJustCopiedPrompt(true);
        setStatus('実行できなかった旨を踏まえたプロンプトをコピーしました。');
        return;
      }
      setPendingToolRun({ path: resolution.path, command: resolution.command });
      setStatus(null);
      return;
    }

    setJustCopiedPrompt(false);
    if (analysisOnly) {
      setBlocks([]);
      setApplyTargetByBlock({});
      setAnalysisText(pastedResponse);
      setStatus(null);
      return;
    }
    setAnalysisText(null);
    const parsed = extractCodeBlocks(pastedResponse);
    setBlocks(parsed);
    const activePath = activeTab?.pathSegments.join('/') ?? '';
    const defaults: Record<string, string> = {};
    for (const block of parsed) defaults[block.id] = block.suggestedPath ?? activePath;
    setApplyTargetByBlock(defaults);
    setStatus(null);
  }

  async function handleRunAndCheck() {
    if (!activeTab || !runCommandTemplate) return;
    setCheckingRun(true);
    setStatus('実行中...');
    useDockStore.getState().setVisible('terminal', true);
    const command = buildRunCommand(runCommandTemplate, resolveRelativeFilePath(activeTab.pathSegments));
    const result = await runAndCapture(command, `実行: ${activeTab.name}`);
    setCheckingRun(false);
    if (result.exitCode === 0) {
      setStatus('✓ エラーなし(終了コード 0)');
      return;
    }
    await navigator.clipboard.writeText(buildRunResultPrompt(result.command, result.exitCode, result.output));
    setJustCopiedPrompt(true);
    setStatus(`終了コード ${result.exitCode ?? '不明'} で終了しました。エラー内容を踏まえたプロンプトをコピーしました。`);
  }

  async function handleConfirmToolRun() {
    if (!pendingToolRun) return;
    setRunningToolRun(true);
    useDockStore.getState().setVisible('terminal', true);
    const result = await runAndCapture(pendingToolRun.command, `実行: ${pendingToolRun.path}`);
    setRunningToolRun(false);
    setPendingToolRun(null);
    // Unlike handleRunAndCheck's manual button, always copy a follow-up
    // here — Copilot explicitly asked for this and is waiting on the
    // result either way (e.g. "run the tests" — success matters too).
    await navigator.clipboard.writeText(buildRunResultPrompt(result.command, result.exitCode, result.output));
    setJustCopiedPrompt(true);
    setStatus(
      result.exitCode === 0
        ? '実行が成功しました。結果を踏まえたプロンプトをコピーしました。'
        : `終了コード ${result.exitCode ?? '不明'} でした。結果を踏まえたプロンプトをコピーしました。`,
    );
  }

  function handleRejectToolRun() {
    setPendingToolRun(null);
    setStatus('実行をキャンセルしました。');
  }

  async function resolveApplyPreview(targetPath: string, block: ExtractedCodeBlock): Promise<ApplyPreview | null> {
    if (!rootHandle) return null;
    const resolved = await resolveWorkspaceFiles(rootHandle, [targetPath]);
    const node = resolved.get(targetPath);
    if (!node) return prepareApplyForNewFile(rootHandle, targetPath, block);
    return prepareApplyToTreeNode(node, block);
  }

  async function handlePreviewApply(block: ExtractedCodeBlock) {
    if (!rootHandle) return;
    const targetPath = applyTargetByBlock[block.id];
    if (!targetPath) {
      setStatus('適用先のファイルを指定してください。');
      return;
    }
    const preview = await resolveApplyPreview(targetPath, block);
    if (!preview) {
      setStatus('適用先のファイルを開けませんでした。');
      return;
    }
    setStatus(preview.original === '' ? `「${targetPath}」は新規ファイルとして作成されます。` : null);
    setDiffPreview(preview);
  }

  async function handleApplyAll() {
    if (!rootHandle) return;
    let applied = 0;
    for (const block of blocks) {
      const targetPath = applyTargetByBlock[block.id];
      if (!targetPath) continue;
      const preview = await resolveApplyPreview(targetPath, block);
      if (!preview) continue;
      await preview.apply();
      applied++;
    }
    setStatus(`${applied}/${blocks.length}件のコードブロックを適用しました。`);
  }

  return (
    <div style={{ display: visible ? 'contents' : 'none' }}>
      <div className="copilot-sections-column">
      {(justCopiedPrompt || blocks.length > 0) && instruction.trim() && (
        <div className="copilot-progress-bar">
          <span className="copilot-progress-goal" title={instruction}>
            {instruction}
          </span>
          <span className="copilot-progress-count">
            {blocks.length > 0 ? '③ 解析結果を確認中' : '② 回答待ち'}
          </span>
        </div>
      )}
      <div className="copilot-section">
        <div className="copilot-section-title">① プロンプト作成</div>
        <div className="copilot-hint">
          Copilotへの送信・送信ボタンの操作は行いません。プロンプトをコピーし、
          ご自身でCopilotのタブに貼り付けて送信してください。
        </div>
        {rootHandle ? (
          <>
            <textarea
              className="copilot-instruction-input"
              placeholder="指示を入力(コンテキストファイルが0件ならrepomapのみの一般的な質問にもなります)"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="copilot-hint">コンテキストファイル(クリックで含める/外す):</div>
            <FileContextPicker
              selectedPaths={contextFiles}
              onAdd={(path) => setContextFiles((prev) => [...prev, path])}
              onRemove={(path) => setContextFiles((prev) => prev.filter((p) => p !== path))}
            />
            <label className="copilot-checkbox-label">
              テンプレート:
              <select
                value={selectedTemplateId}
                onChange={(e) => selectPromptTemplate(e.target.value)}
              >
                {promptTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="copilot-checkbox-label">
              <input
                type="checkbox"
                checked={includeRepoMap}
                onChange={(e) => setIncludeRepoMap(e.target.checked)}
              />
              リポジトリ構成(repomap)を含める
            </label>
            <div className="copilot-actions">
              <button className="primary" disabled={!instruction.trim()} onClick={() => void handleCopyPrompt()}>
                クリップボードにコピー
              </button>
              {runCommandTemplate && (
                <button disabled={checkingRun} onClick={() => void handleRunAndCheck()}>
                  {checkingRun ? '実行中...' : '▶ 実行してエラーを確認'}
                </button>
              )}
            </div>
            {justCopiedPrompt && (
              <div className="copilot-flow-hint">
                ↓ Copilotのチャットに貼り付けて送信し、返ってきた回答を下の②に貼り付けてください
              </div>
            )}
          </>
        ) : (
          <div className="copilot-hint">フォルダを開くとプロンプトを作成できます。</div>
        )}
      </div>

      <div className="copilot-section">
        <div className="copilot-section-title">② 回答の取り込み</div>
        <div className="copilot-hint">
          Copilotの回答をコピーし、下に貼り付けてください(自動取得は行いません)。
        </div>
        <textarea
          className="copilot-instruction-input"
          placeholder="Copilotの回答をここに貼り付け"
          value={pastedResponse}
          onChange={(e) => setPastedResponse(e.target.value)}
        />
        <div className="copilot-actions">
          <button className="primary" disabled={!pastedResponse.trim()} onClick={() => void handleParseResponse()}>
            コードブロックを解析
          </button>
        </div>
      </div>

      {pendingToolRun && (
        <ToolRunConfirmation
          path={pendingToolRun.path}
          command={pendingToolRun.command}
          running={runningToolRun}
          onConfirm={() => void handleConfirmToolRun()}
          onReject={handleRejectToolRun}
        />
      )}

      <div className="copilot-section">
        <div className="copilot-section-title">③ 解析結果</div>
        {analysisText !== null ? (
          <pre className="copilot-analysis-text">{analysisText}</pre>
        ) : blocks.length === 0 ? (
          <div className="copilot-hint">まだ解析されたコードブロックはありません。</div>
        ) : (
          <>
          {blocks.length > 0 && (
            <div className="copilot-actions">
              <button className="primary" onClick={() => void handleApplyAll()}>
                すべて適用
              </button>
            </div>
          )}
          {blocks.map((block) => (
            <div key={block.id} className="copilot-block-card">
              <div className="copilot-block-header">
                <span>{block.language ?? 'plaintext'}</span>
                {block.suggestedPath && <span className="copilot-suggested-path">{block.suggestedPath}</span>}
              </div>
              <pre className="copilot-block-preview">{block.code.slice(0, 300)}</pre>
              <div className="copilot-actions">
                <input
                  type="text"
                  className="copilot-target-path-input"
                  placeholder="適用先の相対パス(新規ファイルも可)"
                  value={applyTargetByBlock[block.id] ?? ''}
                  onChange={(e) =>
                    setApplyTargetByBlock((prev) => ({ ...prev, [block.id]: e.target.value }))
                  }
                />
                <button onClick={() => void handlePreviewApply(block)}>差分を確認して適用</button>
              </div>
            </div>
          ))}
          </>
        )}
      </div>
      </div>

      {status && <div className="copilot-status">{status}</div>}

      {diffPreview && (
        <DiffViewModal
          fileName={diffPreview.fileName}
          original={diffPreview.original}
          modified={diffPreview.modified}
          language={diffPreview.language}
          onAccept={() => {
            void diffPreview.apply().then(() => setDiffPreview(null));
          }}
          onCancel={() => setDiffPreview(null)}
        />
      )}
    </div>
  );
}
