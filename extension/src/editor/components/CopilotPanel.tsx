import { useState } from 'react';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePromptTemplateStore } from '../state/promptTemplateStore';
import { buildFileEditPrompt } from '../copilot/promptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { extractCodeBlocks, type ExtractedCodeBlock } from '../copilot/codeBlockParser';
import { prepareApplyToOpenTab, type ApplyPreview } from '../copilot/applyToFileFlow';
import { DiffViewModal } from './DiffViewModal';
import './CopilotPanel.css';

export function CopilotPanel() {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const promptTemplate = usePromptTemplateStore((s) => s.template);

  const [status, setStatus] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [includeRepoMap, setIncludeRepoMap] = useState(false);
  const [pastedResponse, setPastedResponse] = useState('');
  const [blocks, setBlocks] = useState<ExtractedCodeBlock[]>([]);
  const [applyTargetByBlock, setApplyTargetByBlock] = useState<Record<string, string>>({});
  const [diffPreview, setDiffPreview] = useState<ApplyPreview | null>(null);

  async function handleCopyPrompt() {
    if (!activeTab) return;
    const repoMap =
      includeRepoMap && rootHandle ? await buildRepoMap(rootHandle) : undefined;
    const prompt = buildFileEditPrompt(
      instruction,
      activeTab.name,
      activeTab.model.getValue(),
      activeTab.language,
      repoMap,
      promptTemplate,
    );
    await navigator.clipboard.writeText(prompt);
    setStatus('プロンプトをクリップボードにコピーしました。Copilotのチャット欄に貼り付けて、内容を確認してから送信してください。');
  }

  function handleParseResponse() {
    if (!pastedResponse.trim()) return;
    setBlocks(extractCodeBlocks(pastedResponse));
    setStatus(null);
  }

  function handlePreviewApply(block: ExtractedCodeBlock) {
    const targetTabId = applyTargetByBlock[block.id] ?? activeFileId;
    if (!targetTabId) {
      setStatus('適用先のタブを選択してください。');
      return;
    }
    const preview = prepareApplyToOpenTab(targetTabId, block);
    if (!preview) {
      setStatus('適用先のファイルが見つかりません。');
      return;
    }
    setDiffPreview(preview);
  }

  return (
    <div className="copilot-panel">
      <div className="copilot-sections-row">
      <div className="copilot-section">
        <div className="copilot-section-title">プロンプト作成</div>
        <div className="copilot-hint">
          Copilotへの送信・送信ボタンの操作は行いません。プロンプトをコピーし、
          ご自身でCopilotのタブに貼り付けて送信してください。
        </div>
        {activeTab ? (
          <>
            <textarea
              className="copilot-instruction-input"
              placeholder={`「${activeTab.name}」への指示を入力`}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
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
              <button onClick={() => void handleCopyPrompt()}>クリップボードにコピー</button>
            </div>
          </>
        ) : (
          <div className="copilot-hint">ファイルを開くとプロンプトを作成できます。</div>
        )}
      </div>

      <div className="copilot-section">
        <div className="copilot-section-title">回答の取り込み</div>
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
          <button onClick={handleParseResponse}>コードブロックを解析</button>
        </div>
      </div>

      <div className="copilot-section">
        <div className="copilot-section-title">解析結果</div>
        {blocks.length === 0 ? (
          <div className="copilot-hint">まだ解析されたコードブロックはありません。</div>
        ) : (
          blocks.map((block) => (
            <div key={block.id} className="copilot-block-card">
              <div className="copilot-block-header">
                <span>{block.language ?? 'plaintext'}</span>
                {block.suggestedPath && <span className="copilot-suggested-path">{block.suggestedPath}</span>}
              </div>
              <pre className="copilot-block-preview">{block.code.slice(0, 300)}</pre>
              <div className="copilot-actions">
                <select
                  value={applyTargetByBlock[block.id] ?? activeFileId ?? ''}
                  onChange={(e) =>
                    setApplyTargetByBlock((prev) => ({ ...prev, [block.id]: e.target.value }))
                  }
                >
                  {openFiles.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button onClick={() => handlePreviewApply(block)}>差分プレビュー</button>
              </div>
            </div>
          ))
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
