import { useState } from 'react';
import { usePlanPromptTemplateStore } from '../state/planPromptTemplateStore';
import { DEFAULT_PLAN_PROMPT_TEMPLATE, DEFAULT_STEP_PROMPT_TEMPLATE } from '../copilot/planPromptTemplates';
import '../components/DiffViewModal.css';
import './PromptTemplateSettingsModal.css';

export function PlanPromptTemplateSettingsModal({ onClose }: { onClose: () => void }) {
  const planTemplate = usePlanPromptTemplateStore((s) => s.planTemplate);
  const stepTemplate = usePlanPromptTemplateStore((s) => s.stepTemplate);
  const savePlanTemplate = usePlanPromptTemplateStore((s) => s.savePlanTemplate);
  const saveStepTemplate = usePlanPromptTemplateStore((s) => s.saveStepTemplate);

  const [planDraft, setPlanDraft] = useState(planTemplate);
  const [stepDraft, setStepDraft] = useState(stepTemplate);

  async function handleSave() {
    await Promise.all([savePlanTemplate(planDraft), saveStepTemplate(stepDraft)]);
    onClose();
  }

  return (
    <div className="diff-modal-overlay">
      <div className="prompt-template-modal">
        <div className="diff-modal-header">
          <span>計画プロンプトテンプレート設定</span>
          <div className="diff-modal-actions">
            <button onClick={() => void handleSave()}>保存</button>
            <button onClick={onClose}>キャンセル</button>
          </div>
        </div>
        <div className="prompt-template-body">
          <div className="copilot-section-title">① 計画作成プロンプト</div>
          <p className="prompt-template-hint">
            プレースホルダー: {'{goal}'}(目標) / {'{repoMapSection}'}(repomap、有効時のみ展開) /{' '}
            {'{contextFilesSection}'}(追加したコンテキストファイル、あれば展開)
          </p>
          <div className="copilot-actions">
            <button onClick={() => setPlanDraft(DEFAULT_PLAN_PROMPT_TEMPLATE)}>デフォルトに戻す</button>
          </div>
          <textarea
            className="prompt-template-textarea"
            value={planDraft}
            onChange={(e) => setPlanDraft(e.target.value)}
            spellCheck={false}
          />

          <div className="copilot-section-title">② ステップ実行プロンプト</div>
          <p className="prompt-template-hint">
            プレースホルダー: {'{goal}'}(目標) / {'{planSection}'}(計画全体の一覧) /{' '}
            {'{stepDescription}'}(今回実行するステップの説明) / {'{stepFilesSection}'}
            (該当ステップの関連ファイルの現在の内容)
          </p>
          <div className="copilot-actions">
            <button onClick={() => setStepDraft(DEFAULT_STEP_PROMPT_TEMPLATE)}>デフォルトに戻す</button>
          </div>
          <textarea
            className="prompt-template-textarea"
            value={stepDraft}
            onChange={(e) => setStepDraft(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
