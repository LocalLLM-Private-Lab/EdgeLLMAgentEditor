import { useEffect, useRef, useState } from 'react';
import { useEditPlanStore, useAnalysisPlanStore } from '../state/planStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { useRunCommandStore } from '../state/runCommandStore';
import { useNamedCommandStore } from '../state/namedCommandStore';
import { useDockStore } from '../state/dockStore';
import { buildPlanPrompt } from '../copilot/planPromptTemplates';
import { buildToolResultPrompt, buildRunResultPrompt } from '../copilot/promptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { readFileText } from '../fs/fsaWorkspace';
import { parsePlanResponse, fallbackSingleStep } from '../copilot/planParser';
import { detectControlFlow } from '../copilot/responseControl';
import { runGrepSearch, runListFiles } from '../copilot/localTools';
import { resolveRunToolRequest, resolveNamedToolRequest, type RunToolResolution } from '../copilot/runToolResolver';
import { runAndCapture } from '../copilot/runAndCapture';
import { FileContextPicker } from './FileContextPicker';
import { PlanStepCard, STATUS_LABEL } from './PlanStepCard';
import { ToolRunConfirmation } from './ToolRunConfirmation';
import './CopilotPanel.css';
import './PlanPanel.css';

interface PlanPanelProps {
  /** From CopilotPanel's top-level 編集モード/解析モード tabs — applies
   * uniformly to every step's prompt (see PlanStepCard), not just the plan
   * itself, so there's no separate per-step checkbox to remember. Also
   * picks which independent plan "slot" this instance reads/writes (see
   * planStore.ts) — CopilotPanel mounts one PlanPanel per mode, so an
   * in-progress editing plan and an in-progress analysis plan never share
   * state. */
  analysisOnly: boolean;
  /** CopilotPanel keeps both modes' PlanPanel mounted at once (so neither
   * loses state when the mode tab is switched) and toggles this instead of
   * conditionally rendering — same reasoning as DockPanel's tab-content
   * panels. */
  visible: boolean;
}

export function PlanPanel({ analysisOnly, visible }: PlanPanelProps) {
  const usePlanStore = analysisOnly ? useAnalysisPlanStore : useEditPlanStore;
  // Two mounted instances (edit/analysis) would otherwise collide on these
  // two fixed-string ids — used both as the actual DOM id and as the
  // scroll-spy/outline "current location" value throughout this
  // component — so every occurrence below is suffixed per instance. Step
  // ids don't need this: each plan's own steps carry their own UUIDs,
  // already unique across both slots.
  const scope = analysisOnly ? 'analysis' : 'edit';
  const goalSectionId = `plan-section-goal-${scope}`;
  const importSectionId = `plan-section-import-${scope}`;

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

  const runCommands = useRunCommandStore((s) => s.commands);
  const namedCommands = useNamedCommandStore((s) => s.commands);
  const [pendingToolRun, setPendingToolRun] = useState<{ path: string; command: string } | null>(null);
  const [runningToolRun, setRunningToolRun] = useState(false);

  // Element id (matches the id= on each section/card below) of whichever
  // part of the plan is "current" — drives the outline's highlight and,
  // in focus mode, which single section is actually rendered.
  const [currentLocation, setCurrentLocation] = useState(goalSectionId);
  const [focusMode, setFocusMode] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  // Scroll-spy: keeps the outline's highlight in sync with whatever's
  // actually scrolled into view, not just the last thing explicitly
  // clicked. Only meaningful outside focus mode, since focus mode hides
  // everything except currentLocation itself (nothing left to scroll past).
  //
  // Position-based rather than IntersectionObserver: an expanded step
  // card can be much taller than a collapsed one, so "last entry in the
  // callback" doesn't reliably mean "bottommost on screen" — entries
  // arrive in the order their intersection *state changed*, not DOM
  // order. Scanning targets in DOM order and keeping whichever one's top
  // has most recently passed a fixed reference line just below the
  // sticky header gives a deterministic "topmost thing currently in view".
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || focusMode) return;
    const targets = Array.from(
      body.querySelectorAll<HTMLElement>('[id^="plan-section-"], [id^="plan-step-"]'),
    );
    if (targets.length === 0) return;

    let ticking = false;
    function updateCurrent() {
      ticking = false;
      if (!body) return;
      // Scrolled to (or past) the very bottom: the last target should win
      // even if it's short and its own top never reaches the reference
      // line — there's no more content below it to push it up to that
      // line, since it's already flush against the bottom of the view.
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 2;
      if (atBottom) {
        setCurrentLocation(targets[targets.length - 1].id);
        return;
      }
      const referenceY = body.getBoundingClientRect().top + 40;
      let current = targets[0];
      for (const t of targets) {
        if (t.getBoundingClientRect().top <= referenceY) current = t;
      }
      setCurrentLocation(current.id);
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateCurrent);
    }

    updateCurrent();
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [focusMode, steps.length]);

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

  async function handleParsePlan() {
    if (!planResponseText.trim()) return;
    const flow = detectControlFlow(planResponseText);

    if (flow.kind === 'needFiles') {
      const merged = [...new Set([...contextFiles, ...flow.paths])];
      addContextFiles(flow.paths);
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus('Copilotの要求に応じてファイルを追加中...');
      void copyPlanPromptWithFiles(merged).then(() => {
        setJustCopiedPlan(true);
        setStatus(`Copilotの要求により以下のファイルをコンテキストに追加しました: ${flow.paths.join(', ')}`);
      });
      return;
    }

    if (flow.kind === 'grep' && rootHandle) {
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus(`「${flow.pattern}」を検索中...`);
      void runGrepSearch(rootHandle, flow.pattern).then(async (result) => {
        await navigator.clipboard.writeText(buildToolResultPrompt('検索(grep)', flow.pattern, result));
        setJustCopiedPlan(true);
        setStatus('検索結果を踏まえたプロンプトをコピーしました。');
      });
      return;
    }

    if (flow.kind === 'listFiles' && rootHandle) {
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus('ファイル一覧を取得中...');
      void runListFiles(rootHandle, flow.query).then(async (result) => {
        await navigator.clipboard.writeText(buildToolResultPrompt('ファイル一覧', flow.query, result));
        setJustCopiedPlan(true);
        setStatus('ファイル一覧を踏まえたプロンプトをコピーしました。');
      });
      return;
    }

    if (flow.kind === 'runTool' && rootHandle) {
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus(`「${flow.path}」の実行可否を確認中...`);
      const resolution: RunToolResolution = await resolveRunToolRequest(rootHandle, flow.path, runCommands);
      if (!resolution.ok) {
        await navigator.clipboard.writeText(buildToolResultPrompt('実行リクエスト', resolution.path, resolution.message));
        setJustCopiedPlan(true);
        setStatus('実行できなかった旨を踏まえたプロンプトをコピーしました。');
        return;
      }
      setPendingToolRun({ path: resolution.path, command: resolution.command });
      setStatus(null);
      return;
    }

    if (flow.kind === 'runToolNamed') {
      setJustCopiedPlan(false);
      setPlanResponseText('');
      setStatus(`「${flow.name}」の実行可否を確認中...`);
      const resolution: RunToolResolution = resolveNamedToolRequest(flow.name, namedCommands);
      if (!resolution.ok) {
        await navigator.clipboard.writeText(buildToolResultPrompt('実行リクエスト', resolution.path, resolution.message));
        setJustCopiedPlan(true);
        setStatus('実行できなかった旨を踏まえたプロンプトをコピーしました。');
        return;
      }
      setPendingToolRun({ path: resolution.path, command: resolution.command });
      setStatus(null);
      return;
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

  async function handleConfirmToolRun() {
    if (!pendingToolRun) return;
    setRunningToolRun(true);
    useDockStore.getState().setVisible('terminal', true);
    const result = await runAndCapture(pendingToolRun.command, `実行: ${pendingToolRun.path}`);
    setRunningToolRun(false);
    setPendingToolRun(null);
    await navigator.clipboard.writeText(buildRunResultPrompt(result.command, result.exitCode, result.output));
    setJustCopiedPlan(true);
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

  // Clicking the already-focused step's header collapses it (accordion
  // toggle); clicking a different one focuses it and collapses the rest.
  function handleToggleStep(stepId: string) {
    setActiveStepId(activeStepId === stepId ? null : stepId);
  }

  function scrollToId(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Outline click: sets the highlight immediately (don't wait for
  // scroll-spy to catch up — in focus mode there's no scrolling at all,
  // so this is the only thing that updates it) and scrolls to it when not
  // in focus mode, where there's a full list to scroll through.
  function goToLocation(id: string) {
    setCurrentLocation(id);
    if (!focusMode) requestAnimationFrame(() => scrollToId(id));
  }

  // Left-rail outline navigation for a step: expands it (so what you land
  // on is actually usable, not just a collapsed header) and scrolls once
  // that expansion has been painted, rather than scrolling to where the
  // collapsed card used to be.
  function jumpToStep(stepId: string) {
    setActiveStepId(stepId);
    goToLocation(`plan-step-${stepId}`);
  }

  // Turning focus mode on on its own can't just hide everything but
  // currentLocation if that happens to be a step nobody expanded yet
  // (e.g. scroll-spy left it there without a click) — line activeStepId
  // up with it first so the one card left standing isn't a collapsed header.
  function toggleFocusMode() {
    setFocusMode((v) => {
      const next = !v;
      if (next && currentLocation.startsWith('plan-step-')) {
        setActiveStepId(currentLocation.slice('plan-step-'.length));
      }
      return next;
    });
  }

  // Completing the focused step moves focus to the next not-yet-done one,
  // so attention naturally follows the remaining work instead of staying
  // on a step that's already finished. Goes through jumpToStep (not a bare
  // setActiveStepId) so currentLocation moves too — in focus mode that's
  // what actually decides which single step is shown; leaving it behind
  // meant completing a step in focus mode left the (now-collapsed,
  // finished) step on screen instead of advancing to the next one.
  function handleStepStatusChange(stepId: string, status: (typeof steps)[number]['status']) {
    setStepStatus(stepId, status);
    if (status === 'done' && activeStepId === stepId) {
      const next = steps.find((s) => s.id !== stepId && s.status !== 'done');
      if (next) jumpToStep(next.id);
      else setActiveStepId(null);
    }
  }

  if (!loaded) return null;

  const doneCount = steps.filter((s) => s.status === 'done').length;
  const showGoalSection = !focusMode || currentLocation === goalSectionId;
  const showImportSection = !focusMode || currentLocation === importSectionId;
  const visibleSteps = focusMode ? steps.filter((s) => `plan-step-${s.id}` === currentLocation) : steps;

  return (
    <div className="plan-panel" style={visible ? undefined : { display: 'none' }}>
      <div className="plan-outline">
        <button
          className={`plan-outline-toggle ${focusMode ? 'active' : ''}`}
          onClick={toggleFocusMode}
          title={focusMode ? '全体を表示' : '今いる場所だけを表示'}
        >
          {focusMode ? '☰' : '◱'}
        </button>
        <button
          className={`plan-outline-item ${currentLocation === goalSectionId ? 'active' : ''}`}
          onClick={() => goToLocation(goalSectionId)}
          title="① 計画を作成"
        >
          1
        </button>
        <button
          className={`plan-outline-item ${currentLocation === importSectionId ? 'active' : ''}`}
          onClick={() => goToLocation(importSectionId)}
          title="② Copilotの回答を貼り付け"
        >
          2
        </button>
        {steps.map((step, i) => (
          <button
            key={step.id}
            className={`plan-outline-item step ${step.status} ${currentLocation === `plan-step-${step.id}` ? 'active' : ''}`}
            onClick={() => jumpToStep(step.id)}
            title={step.description}
          >
            3-{i + 1}
          </button>
        ))}
      </div>
      <div className="plan-panel-body" ref={bodyRef}>
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

      {showGoalSection && (
      <div className="copilot-section" id={goalSectionId}>
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
      )}

      {showImportSection && (
      <div className="copilot-section" id={importSectionId}>
        <div className="copilot-section-title">② Copilotの回答を貼り付け</div>
        <div className="copilot-hint">
          計画のJSONだけでなく、Copilotが追加ファイルや検索を求めてきた場合の回答も、種類を問わずすべてここに貼り付けてください。内容を見て自動で判別します。
        </div>
        <textarea
          className="copilot-instruction-input"
          placeholder="Copilotの回答をここに貼り付け(前後に説明文があっても構いません)"
          value={planResponseText}
          onChange={(e) => setPlanResponseText(e.target.value)}
        />
        <div className="copilot-actions">
          <button className="primary" disabled={!planResponseText.trim()} onClick={() => void handleParsePlan()}>
            回答を解析
          </button>
        </div>
      </div>
      )}

      {pendingToolRun && (
        <ToolRunConfirmation
          path={pendingToolRun.path}
          command={pendingToolRun.command}
          running={runningToolRun}
          onConfirm={() => void handleConfirmToolRun()}
          onReject={handleRejectToolRun}
        />
      )}

      {status && <div className="copilot-status">{status}</div>}

      {visibleSteps.length > 0 && (
        <div className="copilot-section">
          <div className="copilot-section-title">
            ③ ステップを実行 ({doneCount}/{steps.length} 完了)
          </div>
          <div className="copilot-hint">
            注目しているステップだけが展開されます。ヘッダーをクリックすると切り替えられます。
          </div>
          {steps.map((step, index) => {
            // Index/allSteps stay based on the *full* list (not the
            // possibly-filtered visibleSteps) since buildStepPrompt needs
            // the step's real position in the whole plan regardless of
            // what focus mode is currently hiding.
            if (focusMode && `plan-step-${step.id}` !== currentLocation) return null;
            return (
              <PlanStepCard
                key={step.id}
                step={step}
                index={index}
                allSteps={steps}
                goal={goal}
                rootHandle={rootHandle}
                analysisOnly={analysisOnly}
                isActive={step.id === activeStepId}
                onFocus={() => handleToggleStep(step.id)}
                onStatusChange={(s) => handleStepStatusChange(step.id, s)}
                onFilesChange={(files) => setStepFiles(step.id, files)}
              />
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
