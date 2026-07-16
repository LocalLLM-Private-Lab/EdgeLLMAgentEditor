import { useState } from 'react';
import type { PlanStep } from '../copilot/planParser';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { buildStepPrompt, buildPlanRevisionPrompt } from '../copilot/planPromptTemplates';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { readFileText } from '../fs/fsaWorkspace';
import { extractCodeBlocks, type ExtractedCodeBlock } from '../copilot/codeBlockParser';
import { detectNeedFilesRequest, detectPlanRevisionRequest } from '../copilot/responseControl';
import {
  prepareApplyToTreeNode,
  prepareApplyForNewFile,
  type ApplyPreview,
} from '../copilot/applyToFileFlow';
import { FileContextPicker } from './FileContextPicker';
import { DiffViewModal } from './DiffViewModal';
import './CopilotPanel.css';
import './PlanStepCard.css';

const STATUS_LABEL: Record<PlanStep['status'], string> = {
  pending: '未着手',
  'in-progress': '進行中',
  done: '完了',
};

const STATUS_ICON: Record<PlanStep['status'], string> = {
  pending: '○',
  'in-progress': '◐',
  done: '✓',
};

interface PlanStepCardProps {
  step: PlanStep;
  index: number;
  allSteps: PlanStep[];
  goal: string;
  rootHandle: FileSystemDirectoryHandle | null;
  isActive: boolean;
  onFocus: () => void;
  onStatusChange: (status: PlanStep['status']) => void;
  onFilesChange: (files: string[]) => void;
}

export function PlanStepCard({
  step,
  index,
  allSteps,
  goal,
  rootHandle,
  isActive,
  onFocus,
  onStatusChange,
  onFilesChange,
}: PlanStepCardProps) {
  const stepTemplate = usePlanPromptTemplateStore((s) => s.stepTemplate);
  // Accordion: only the focused step stays expanded, everything else
  // collapses — driven entirely by isActive, not local state, so switching
  // focus elsewhere always collapses this card.
  const collapsed = !isActive;
  const [copying, setCopying] = useState(false);
  const [responseText, setResponseText] = useState('');
  const [blocks, setBlocks] = useState<ExtractedCodeBlock[]>([]);
  const [blockTargets, setBlockTargets] = useState<Record<string, string>>({});
  const [blockActionStatus, setBlockActionStatus] = useState<Record<string, 'applied' | 'rejected'>>({});
  const [diffPreview, setDiffPreview] = useState<{ blockId: string; preview: ApplyPreview } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [justCopiedStep, setJustCopiedStep] = useState(false);
  const [planRevisionNote, setPlanRevisionNote] = useState<string | null>(null);
  const [copyingRevision, setCopyingRevision] = useState(false);
  const [justCopiedRevision, setJustCopiedRevision] = useState(false);

  /** Auto-completion: once every parsed block has been either applied or
   * explicitly rejected, there's nothing left to decide on for this step,
   * so it's done — no need to remember to click "完了にする" separately. */
  function markBlockHandled(blockId: string, action: 'applied' | 'rejected') {
    setBlockActionStatus((prev) => {
      const next = { ...prev, [blockId]: action };
      if (blocks.length > 0 && blocks.every((b) => next[b.id])) {
        onStatusChange('done');
      }
      return next;
    });
  }

  // Takes an explicit file list rather than reading step.files from state —
  // handleParseResponse needs to copy a prompt built from a just-merged
  // list in the same tick a NEED_FILES reply is detected, before the state
  // update from that merge (via onFilesChange) has actually landed.
  async function copyStepPromptWithFiles(files: string[]) {
    if (!rootHandle) return;
    const resolved = await resolveWorkspaceFiles(rootHandle, files);
    const stepFiles = await Promise.all(
      [...resolved.entries()].map(async ([path, node]) => ({
        path,
        content: await readFileText(node.handle as FileSystemFileHandle),
      })),
    );
    // A declared step file that isn't real yet is the normal case for "add
    // a new file" steps — say so explicitly instead of silently dropping it,
    // otherwise Copilot never learns it's supposed to create that file.
    const newFiles = files
      .filter((path) => !resolved.has(path))
      .map((path) => ({ path, content: '', isNew: true }));
    const prompt = buildStepPrompt(goal, allSteps, index, [...stepFiles, ...newFiles], stepTemplate);
    await navigator.clipboard.writeText(prompt);
  }

  async function handleCopyStepPrompt() {
    setCopying(true);
    try {
      await copyStepPromptWithFiles(step.files);
      onStatusChange('in-progress');
      setJustCopiedStep(true);
      setStatusMessage(null);
    } finally {
      setCopying(false);
    }
  }

  function handleParseResponse() {
    if (!responseText.trim()) return;
    const needFiles = detectNeedFilesRequest(responseText);
    if (needFiles) {
      const merged = [...new Set([...step.files, ...needFiles])];
      onFilesChange(merged);
      setPlanRevisionNote(null);
      setJustCopiedRevision(false);
      setBlocks([]);
      setResponseText('');
      setJustCopiedStep(false);
      setStatusMessage('Copilotの要求に応じてファイルを追加中...');
      void copyStepPromptWithFiles(merged).then(() => {
        setJustCopiedStep(true);
        setStatusMessage(`Copilotの要求により以下のファイルを対象ファイルに追加しました: ${needFiles.join(', ')}`);
      });
      return;
    }
    const revisionNote = detectPlanRevisionRequest(responseText);
    if (revisionNote) {
      setPlanRevisionNote(revisionNote);
      setJustCopiedRevision(false);
      setBlocks([]);
      setJustCopiedStep(false);
      setStatusMessage(null);
      return;
    }
    setPlanRevisionNote(null);
    setJustCopiedStep(false);
    const parsed = extractCodeBlocks(responseText);
    setBlocks(parsed);
    const defaults: Record<string, string> = {};
    const claimed = new Set<string>();
    for (const block of parsed) {
      // Prefer Copilot's own path guess even if it's outside the step's
      // declared file list — it may be proposing a new file to create.
      if (block.suggestedPath) {
        defaults[block.id] = block.suggestedPath;
        claimed.add(block.suggestedPath);
        continue;
      }
      // No detected path for this block — fall back to the next
      // not-yet-claimed file from the step's list, rather than every
      // undetected block collapsing onto the same files[0] default.
      const fallback = step.files.find((f) => !claimed.has(f)) ?? '';
      defaults[block.id] = fallback;
      if (fallback) claimed.add(fallback);
    }
    setBlockTargets(defaults);
    setBlockActionStatus({});
    setStatusMessage(null);
  }

  /** Copies a prompt asking Copilot to return a full replacement plan given
   * the reason it reported via REVISE_PLAN — the result is pasted into the
   * existing "②計画を取り込む" box in PlanPanel, same as the initial plan. */
  async function handleCopyRevisionPrompt() {
    if (!planRevisionNote) return;
    setCopyingRevision(true);
    try {
      const prompt = buildPlanRevisionPrompt(goal, allSteps, planRevisionNote);
      await navigator.clipboard.writeText(prompt);
      setJustCopiedRevision(true);
      setStatusMessage(null);
    } finally {
      setCopyingRevision(false);
    }
  }

  /** Every selectable target for a block: the step's declared files, plus
   * that block's own suggestedPath if Copilot proposed something else
   * (e.g. a new file not in the original plan). */
  function targetOptionsFor(block: ExtractedCodeBlock): string[] {
    const extra = block.suggestedPath && !step.files.includes(block.suggestedPath) ? [block.suggestedPath] : [];
    return [...step.files, ...extra];
  }

  async function handlePreviewApply(block: ExtractedCodeBlock) {
    if (!rootHandle) return;
    const targetPath = blockTargets[block.id];
    if (!targetPath) {
      setStatusMessage('適用先のファイルを選択してください。');
      return;
    }
    const resolved = await resolveWorkspaceFiles(rootHandle, [targetPath]);
    const node = resolved.get(targetPath);
    if (!node) {
      // Doesn't exist in the workspace yet — treat as a new file to create.
      // Nothing is written to disk until the preview is accepted.
      setStatusMessage(`「${targetPath}」は新規ファイルとして作成されます。`);
      setDiffPreview({ blockId: block.id, preview: prepareApplyForNewFile(rootHandle, targetPath, block) });
      return;
    }
    const preview = await prepareApplyToTreeNode(node, block);
    if (!preview) {
      setStatusMessage('適用先のファイルを開けませんでした。');
      return;
    }
    setDiffPreview({ blockId: block.id, preview });
  }

  function handleRejectBlock(blockId: string) {
    markBlockHandled(blockId, 'rejected');
  }

  /** Applies every parsed block straight through (existing or new files
   * alike) without a per-block diff modal — for when the response is
   * trusted enough that reviewing each file individually isn't needed. */
  async function handleApplyAll() {
    if (!rootHandle) return;
    let applied = 0;
    for (const block of blocks) {
      const targetPath = blockTargets[block.id];
      if (!targetPath) continue;
      const resolved = await resolveWorkspaceFiles(rootHandle, [targetPath]);
      const node = resolved.get(targetPath);
      const preview = node
        ? await prepareApplyToTreeNode(node, block)
        : prepareApplyForNewFile(rootHandle, targetPath, block);
      if (!preview) continue;
      await preview.apply();
      markBlockHandled(block.id, 'applied');
      applied++;
    }
    setStatusMessage(`${applied}/${blocks.length}件のコードブロックを適用しました。`);
  }

  return (
    <div className={`plan-step-card ${isActive ? 'active' : ''}`}>
      <div className="plan-step-header" onClick={onFocus}>
        <span className="plan-step-collapse-icon">{collapsed ? '▶' : '▼'}</span>
        <span className={`plan-step-status plan-step-status-${step.status}`}>
          <span className="plan-step-status-icon">{STATUS_ICON[step.status]}</span>
          {STATUS_LABEL[step.status]}
        </span>
        <span className="plan-step-index">{index + 1}.</span>
        <span className="plan-step-description">{step.description}</span>
      </div>

      {!collapsed && (
        <>
          <div className="copilot-hint">対象ファイル(必要に応じて追加・削除できます):</div>
          <FileContextPicker
            selectedPaths={step.files}
            onAdd={(path) => onFilesChange([...step.files, path])}
            onRemove={(path) => onFilesChange(step.files.filter((p) => p !== path))}
          />

          <div className="copilot-actions">
            <button disabled={copying} onClick={() => void handleCopyStepPrompt()}>
              ① 実行プロンプトをコピー
            </button>
            {step.status !== 'done' && (
              <button onClick={() => onStatusChange('done')}>完了にする</button>
            )}
            {step.status === 'done' && (
              <button onClick={() => onStatusChange('pending')}>未着手に戻す</button>
            )}
          </div>
          {justCopiedStep && (
            <div className="copilot-flow-hint">
              ↓ Copilotのチャットに貼り付けて送信し、返ってきた回答を下の②に貼り付けてください
            </div>
          )}

          <div className="copilot-hint">② Copilotの回答をここに貼り付け:</div>
          <textarea
            className="copilot-instruction-input"
            placeholder="このステップへのCopilotの回答をここに貼り付け"
            value={responseText}
            onChange={(e) => setResponseText(e.target.value)}
          />
          <div className="copilot-actions">
            <button disabled={!responseText.trim()} onClick={handleParseResponse}>
              コードブロックを解析
            </button>
          </div>

          {planRevisionNote && (
            <div className="copilot-plan-revision">
              <div className="copilot-hint">Copilotが計画の変更を提案しています:</div>
              <div className="copilot-plan-revision-note">{planRevisionNote}</div>
              <div className="copilot-actions">
                <button disabled={copyingRevision} onClick={() => void handleCopyRevisionPrompt()}>
                  計画修正プロンプトをコピー
                </button>
              </div>
              {justCopiedRevision && (
                <div className="copilot-flow-hint">
                  ↓ Copilotのチャットに貼り付けて送信し、返ってきたJSONを上の「②計画を取り込む」に貼り付けてください
                </div>
              )}
            </div>
          )}

          {blocks.length > 0 && (
            <div className="copilot-actions">
              <button onClick={() => void handleApplyAll()}>すべて適用</button>
            </div>
          )}
          {blocks.map((block) => {
            const handled = blockActionStatus[block.id];
            return (
              <div key={block.id} className={`copilot-block-card ${handled ? 'handled' : ''}`}>
                <div className="copilot-block-header">
                  <span>{block.language ?? 'plaintext'}</span>
                  {block.suggestedPath && (
                    <span className="copilot-suggested-path">{block.suggestedPath}</span>
                  )}
                  {handled && (
                    <span className={`copilot-block-handled-badge ${handled}`}>
                      {handled === 'applied' ? '✓ 適用済み' : '✕ 却下'}
                    </span>
                  )}
                </div>
                <pre className="copilot-block-preview">{block.code.slice(0, 300)}</pre>
                <div className="copilot-actions">
                  <select
                    value={targetOptionsFor(block).includes(blockTargets[block.id]) ? blockTargets[block.id] : ''}
                    onChange={(e) => setBlockTargets((prev) => ({ ...prev, [block.id]: e.target.value }))}
                  >
                    <option value="" disabled>
                      候補から選択
                    </option>
                    {targetOptionsFor(block).map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="copilot-target-path-input"
                    placeholder="または相対パスを直接入力(新規ファイルも可)"
                    value={blockTargets[block.id] ?? ''}
                    onChange={(e) => setBlockTargets((prev) => ({ ...prev, [block.id]: e.target.value }))}
                  />
                  <button onClick={() => void handlePreviewApply(block)}>③ 差分を確認して適用</button>
                  <button onClick={() => handleRejectBlock(block.id)}>却下</button>
                </div>
              </div>
            );
          })}

          {statusMessage && <div className="copilot-status">{statusMessage}</div>}
        </>
      )}

      {diffPreview && (
        <DiffViewModal
          fileName={diffPreview.preview.fileName}
          original={diffPreview.preview.original}
          modified={diffPreview.preview.modified}
          language={diffPreview.preview.language}
          onAccept={() => {
            const { blockId, preview } = diffPreview;
            void preview.apply().then(() => {
              markBlockHandled(blockId, 'applied');
              setDiffPreview(null);
            });
          }}
          onCancel={() => setDiffPreview(null)}
        />
      )}
    </div>
  );
}
