import { useState } from 'react';
import { usePromptTemplateStore } from '../state/promptTemplateStore';
import { DEFAULT_PROMPT_TEMPLATE } from '../copilot/promptTemplates';
import '../components/DiffViewModal.css';
import './PromptTemplateSettingsModal.css';

export function PromptTemplateSettingsModal({ onClose }: { onClose: () => void }) {
  const template = usePromptTemplateStore((s) => s.template);
  const saveTemplate = usePromptTemplateStore((s) => s.saveTemplate);
  const [draft, setDraft] = useState(template);

  async function handleSave() {
    await saveTemplate(draft);
    onClose();
  }

  return (
    <div className="diff-modal-overlay">
      <div className="prompt-template-modal">
        <div className="diff-modal-header">
          <span>プロンプトテンプレート設定</span>
          <div className="diff-modal-actions">
            <button onClick={() => setDraft(DEFAULT_PROMPT_TEMPLATE)}>デフォルトに戻す</button>
            <button onClick={() => void handleSave()}>保存</button>
            <button onClick={onClose}>キャンセル</button>
          </div>
        </div>
        <div className="prompt-template-body">
          <p className="prompt-template-hint">
            利用できるプレースホルダー: {'{fileName}'}(ファイル名) / {'{instruction}'}(指示欄の内容) /{' '}
            {'{language}'}(言語ID) / {'{fileContent}'}(ファイル内容) / {'{repoMapSection}'}
            (「リポジトリ構成を含める」を有効にした場合のみ、見出し+コードブロック込みで展開。無効時は空文字)
          </p>
          <textarea
            className="prompt-template-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
