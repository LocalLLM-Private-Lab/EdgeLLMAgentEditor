import { useEffect, useState } from 'react';
import { usePlanStore } from '../state/planStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { buildPlanPrompt } from '../copilot/planPromptTemplates';
import { buildToolResultPrompt } from '../copilot/promptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { readFileText } from '../fs/fsaWorkspace';
import { parsePlanResponse, fallbackSingleStep } from '../copilot/planParser';
import { detectNeedFilesRequest, detectGrepRequest, detectListFilesRequest } from '../copilot/responseControl';
import { runGrepSearch, runListFiles } from '../copilot/localTools';
import { FileContextPicker } from './FileContextPicker';
import { PlanStepCard, STATUS_LABEL } from './PlanStepCard';
import './CopilotPanel.css';
import './PlanPanel.css';

export function PlanPanel() {
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const planTemplate = usePlanPromptTemplateStore((s) => s.planTemplate);

  const loaded = usePlanStore((s) => s.loaded);
  const loadPlan = usePlanStore((s) => s.loadPlan);
  const goal = usePlanStore((s) => s.goal);
  const contextFiles = usePlanStore((s) => s.contextFiles);
  const steps = usePlanStore((s) => s.steps);
  const activeStepId = usePlanStore((s) => s.activeStepId);
  const setGoal = usePlanStore((s) => s.setGoal);
  const addContextFile = usePlanStore((s) => s.addContextFile);
  const addContextFiles = usePlanStore((s) => s.addContextFiles);
  const removeContextFile = usePlanStore((s) => s.removeContextFile);
  const setSteps = usePlanStore((s) => s.setSteps);
  const setStepStatus = usePlanStore((s) => s.setStepStatus);
  const setStepFiles = usePlanStore((s) => s.setStepFiles);
  const setActiveStepId = usePlanStore((s) => s.setActiveStepId);
  const resetPlan = usePlanStore((s) => s.resetPlan);

  const [includeRepoMap, setIncludeRepoMap] = useState(true);
  const [copying, setCopying] = useState(false);
  const [justCopiedPlan, setJustCopiedPlan] = useState(false);
  const [planResponseText, setPlanResponseText] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  // Takes an explicit file list rather than reading contextFiles from state
  // — handleParsePlan needs to copy a prompt built from a just-merged list
  // in the same tick a NEED_FILES reply is detected, before the store
  // update from that merge has actually landed.
  async function copyPlanPromptWithFiles(files: string[]) {
    if (!rootHandle || !goal.trim()) return;
    const repoMap = includeRepoMap ? await buildRepoMap(rootHandle) : undefined;
    const resolved = await resolveWorkspaceFiles(rootHandle, files);
    const resolvedFiles = await Promise.all(
      [...resolved.entries()].map(async ([path, node]) => ({
        path,
        content: await readFileText(node.handle as FileSystemFileHandle),
      })),
    );
    // A path that isn't a real file yet shouldn't just vanish from the
    // prompt — say so explicitly instead of silently dropping it.
    const newFiles = files
      .filter((path) => !resolved.has(path))
      .map((path) => ({ path, content: '', isNew: true }));
    const prompt = buildPlanPrompt(goal, repoMap, [...resolvedFiles, ...newFiles], planTemplate);
    await navigator.clipboard.writeText(prompt);
  }

  async function handleCopyPlanPrompt() {
    setCopying(true);
    try {
      await copyPlanPromptWithFiles(contextFiles);
      setJustCopiedPlan(true);
      setStatus(null);
    } finally {
      setCopying(false);
    }
  }

  function handleParsePlan() {
    if (!planResponseText.trim()) return;
    const needFiles = detectNeedFilesRequest(planResponseText);
    if (needFiles) {
      const merged = [...new Set([...contextFiles, ...needFiles])];
      addContextFiles(needFiles);
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus('Copilotの要求に応じてファイルを追加中...');
      void copyPlanPromptWithFiles(merged).then(() => {
        setJustCopiedPlan(true);
        setStatus(`Copilotの要求により以下のファイルをコンテキストに追加しました: ${needFiles.join(', ')}`);
      });
      return;
    }

    if (rootHandle) {
      const grepPattern = detectGrepRequest(planResponseText);
      if (grepPattern) {
        setJustCopiedPlan(false);
        setPlanResponseText('');
        setStatus(`「${grepPattern}」を検索中...`);
        void runGrepSearch(rootHandle, grepPattern).then(async (result) => {
          await navigator.clipboard.writeText(buildToolResultPrompt('検索(grep)', grepPattern, result));
          setJustCopiedPlan(true);
          setStatus('検索結果を踏まえたプロンプトをコピーしました。');
        });
        return;
      }

      const listQuery = detectListFilesRequest(planResponseText);
      if (listQuery !== null) {
        setJustCopiedPlan(false);
        setPlanResponseText('');
        setStatus('ファイル一覧を取得中...');
        void runListFiles(rootHandle, listQuery).then(async (result) => {
          await navigator.clipboard.writeText(buildToolResultPrompt('ファイル一覧', listQuery, result));
          setJustCopiedPlan(true);
          setStatus('ファイル一覧を踏まえたプロンプトをコピーしました。');
        });
        return;
      }
    }

    const parsed = parsePlanResponse(planResponseText);
    if (parsed) {
      setSteps(parsed);
      setStatus(`${parsed.length}件のステップを読み込みました。下のステップ一覧から①ずつ実行してください。`);
    } else {
      setSteps(fallbackSingleStep(planResponseText));
      setStatus(
        'JSON形式として解析できなかったため、回答全体を1つのステップとして扱いました。内容を確認し、必要ならファイルを手動で追加してください。',
      );
    }
    setJustCopiedPlan(false);
    setPlanResponseText('');
  }

  // Clicking the already-focused step's header collapses it (accordion
  // toggle); clicking a different one focuses it and collapses the rest.
  function handleToggleStep(stepId: string) {
    setActiveStepId(activeStepId === stepId ? null : stepId);
  }

  // Completing the focused step moves focus to the next not-yet-done one,
  // so attention naturally follows the remaining work instead of staying
  // on a step that's already finished.
  function handleStepStatusChange(stepId: string, status: (typeof steps)[number]['status']) {
    setStepStatus(stepId, status);
    if (status === 'done' && activeStepId === stepId) {
      const next = steps.find((s) => s.id !== stepId && s.status !== 'done');
      setActiveStepId(next ? next.id : null);
    }
  }

  if (!loaded) return null;

  const doneCount = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="plan-panel">
      {!rootHandle && (
        <div className="copilot-status">先にフォルダを開いてください。</div>
      )}

      {steps.length > 0 && (
        <div className="copilot-progress-bar">
          <span className="copilot-progress-goal" title={goal}>
            {goal}
          </span>
          <span className="plan-progress-track">
            {steps.map((s) => (
              <span
                key={s.id}
                className={`plan-progress-seg plan-progress-seg-${s.status}`}
                title={`${s.description}(${STATUS_LABEL[s.status]})`}
              />
            ))}
          </span>
          <span className="copilot-progress-count">
            {doneCount}/{steps.length} 完了
          </span>
        </div>
      )}

      <div className="copilot-section">
        <div className="copilot-section-title">① 計画を作成</div>
        <div className="copilot-hint">
          複数ファイルにまたがる目標を入力してください。関連するファイルをコンテキストに追加すると、より的確な計画になります。
        </div>
        <textarea
          className="copilot-instruction-input"
          placeholder="達成したい目標を入力(例: エラーハンドリングを全ファイルで統一する)"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <FileContextPicker
          selectedPaths={contextFiles}
          onAdd={addContextFile}
          onRemove={removeContextFile}
        />
        <label className="copilot-checkbox-label">
          <input
            type="checkbox"
            checked={includeRepoMap}
            onChange={(e) => setIncludeRepoMap(e.target.checked)}
          />
          リポジトリ構成(repomap)を含める
        </label>
        <div className="copilot-actions">
          <button
            className="primary"
            disabled={!rootHandle || !goal.trim() || copying}
            title={!goal.trim() ? '目標を入力してください' : undefined}
            onClick={() => void handleCopyPlanPrompt()}
          >
            計画プロンプトをコピー
          </button>
          {steps.length > 0 && <button onClick={resetPlan}>計画をリセット</button>}
        </div>
        {justCopiedPlan && (
          <div className="copilot-flow-hint">
            ↓ Copilotのチャットに貼り付けて送信し、返ってきた回答を下の②に貼り付けてください
          </div>
        )}
      </div>

      <div className="copilot-section">
        <div className="copilot-section-title">② 計画を取り込む</div>
        <textarea
          className="copilot-instruction-input"
          placeholder="Copilotの回答をここに貼り付け(前後に説明文があっても構いません)"
          value={planResponseText}
          onChange={(e) => setPlanResponseText(e.target.value)}
        />
        <div className="copilot-actions">
          <button className="primary" disabled={!planResponseText.trim()} onClick={handleParsePlan}>
            計画を解析
          </button>
        </div>
      </div>

      {status && <div className="copilot-status">{status}</div>}

      {steps.length > 0 && (
        <div className="copilot-section">
          <div className="copilot-section-title">
            ③ ステップを実行 ({doneCount}/{steps.length} 完了)
          </div>
          <div className="copilot-hint">
            注目しているステップだけが展開されます。ヘッダーをクリックすると切り替えられます。
          </div>
          {steps.map((step, index) => (
            <PlanStepCard
              key={step.id}
              step={step}
              index={index}
              allSteps={steps}
              goal={goal}
              rootHandle={rootHandle}
              isActive={step.id === activeStepId}
              onFocus={() => handleToggleStep(step.id)}
              onStatusChange={(s) => handleStepStatusChange(step.id, s)}
              onFilesChange={(files) => setStepFiles(step.id, files)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
