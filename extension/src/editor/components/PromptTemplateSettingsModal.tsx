import { useState } from 'react';
import {
  usePromptTemplateStore,
  newPromptTemplateEntry,
  type PromptTemplateEntry,
} from '../state/promptTemplateStore';
import '../components/DiffViewModal.css';
import './PromptTemplateSettingsModal.css';

export function PromptTemplateSettingsModal({ onClose }: { onClose: () => void }) {
  const templates = usePromptTemplateStore((s) => s.templates);
  const saveTemplates = usePromptTemplateStore((s) => s.saveTemplates);

  const [draft, setDraft] = useState<PromptTemplateEntry[]>(templates);
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? '');

  const selected = draft.find((t) => t.id === selectedId);

  function updateSelected(patch: Partial<PromptTemplateEntry>) {
    setDraft((prev) => prev.map((t) => (t.id === selectedId ? { ...t, ...patch } : t)));
  }

  function addTemplate() {
    const entry = newPromptTemplateEntry();
    setDraft((prev) => [...prev, entry]);
    setSelectedId(entry.id);
  }

  function deleteTemplate(id: string) {
    const next = draft.filter((t) => t.id !== id);
    setDraft(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? '');
  }

  async function handleSave() {
    if (draft.length === 0) return;
    await saveTemplates(draft);
    onClose();
  }

  return (
    <div className="diff-modal-overlay">
      <div className="prompt-template-modal">
        <div className="diff-modal-header">
          <span>プロンプトテンプレート設定</span>
          <div className="diff-modal-actions">
            <button disabled={draft.length === 0} onClick={() => void handleSave()}>
              保存
            </button>
            <button onClick={onClose}>キャンセル</button>
          </div>
        </div>
        <div className="prompt-template-split">
          <div className="prompt-template-list">
            {draft.map((t) => (
              <div
                key={t.id}
                className={`prompt-template-list-item ${t.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="prompt-template-list-name">{t.name || '(名称未設定)'}</span>
                <button
                  className="prompt-template-list-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTemplate(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="prompt-template-add-btn" onClick={addTemplate}>
              + 新規テンプレート
            </button>
          </div>
          <div className="prompt-template-editor">
            {selected ? (
              <>
                <input
                  className="prompt-template-name-input"
                  value={selected.name}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                  placeholder="テンプレート名(例: コード解析・説明)"
                />
                <p className="prompt-template-hint">
                  利用できるプレースホルダー: {'{instruction}'}(指示欄の内容) / {'{filesSection}'}
                  (選択したコンテキストファイルの中身。0件なら空文字) / {'{fileInstructionSection}'}
                  (「変更後のファイル全体をコードブロックで返す」指示。ファイルが1件以上ある場合のみ展開 —
                  解析・説明用途では省略してよい) / {'{repoMapSection}'}
                  (「リポジトリ構成を含める」を有効にした場合のみ展開)
                </p>
                <textarea
                  className="prompt-template-textarea"
                  value={selected.template}
                  onChange={(e) => updateSelected({ template: e.target.value })}
                  spellCheck={false}
                />
              </>
            ) : (
              <div className="prompt-template-hint">テンプレートがありません。「+ 新規テンプレート」から追加してください。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
