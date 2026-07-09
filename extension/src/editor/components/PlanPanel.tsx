import { useEffect, useState } from 'react';
import { usePlanStore } from '../state/planStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { buildPlanPrompt } from '../copilot/planPromptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { readFileText } from '../fs/fsaWorkspace';
import { parsePlanResponse, fallbackSingleStep } from '../copilot/planParser';
import { FileContextPicker } from './FileContextPicker';
import { PlanStepCard } from './PlanStepCard';
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

  async function handleCopyPlanPrompt() {
    if (!rootHandle || !goal.trim()) return;
    setCopying(true);
    try {
      const repoMap = includeRepoMap ? await buildRepoMap(rootHandle) : undefined;
      const resolved = await resolveWorkspaceFiles(rootHandle, contextFiles);
      const files = await Promise.all(
        [...resolved.entries()].map(async ([path, node]) => ({
          path,
          content: await readFileText(node.handle as FileSystemFileHandle),
        })),
      );
      const prompt = buildPlanPrompt(goal, repoMap, files, planTemplate);
      await navigator.clipboard.writeText(prompt);
      setJustCopiedPlan(true);
      setStatus(null);
    } finally {
      setCopying(false);
    }
  }

  function handleParsePlan() {
    if (!planResponseText.trim()) return;
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
            disabled={!rootHandle || !goal.trim() || copying}
            title={!goal.trim() ? '目標を入力してください' : undefined}
            onClick={() => void handleCopyPlanPrompt()}
          >
            計画プロンプトをコピー
          </button>
          {steps.length > 0 && <button onClick={resetPlan}>計画をリセット</button>}
        </div>
        {justCopiedPlan && (
          <div className="plan-flow-hint">
            ↓ Copilotのチャットに貼り付けて送信し、返ってきた回答を下の②に貼り付けてください
          </div>
        )}
      </div>

      <div className="copilot-section">
        <div className="copilot-section-title">② 計画を取り込む</div>
        <textarea
          className="copilot-instruction-input"
          placeholder="Copilotが返した計画(JSON)をここに貼り付け"
          value={planResponseText}
          onChange={(e) => setPlanResponseText(e.target.value)}
        />
        <div className="copilot-actions">
          <button disabled={!planResponseText.trim()} onClick={handleParsePlan}>
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
