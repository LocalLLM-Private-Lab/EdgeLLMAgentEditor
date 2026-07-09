import { useState } from 'react';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { usePromptTemplateStore } from '../state/promptTemplateStore';
import { buildFileEditPrompt } from '../copilot/promptTemplates';
import { buildRepoMap } from '../copilot/repoMap';
import { extractCodeBlocks, type ExtractedCodeBlock } from '../copilot/codeBlockParser';
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
import './CopilotPanel.css';

type CopilotSubTab = 'quick' | 'plan';

export function CopilotPanel() {
  const [subTab, setSubTab] = useState<CopilotSubTab>('quick');

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

  async function handleCopyPrompt() {
    if (!rootHandle) return;
    const repoMap = includeRepoMap ? await buildRepoMap(rootHandle) : undefined;
    const resolved = await resolveWorkspaceFiles(rootHandle, contextFiles);
    const files = await Promise.all(
      [...resolved.entries()].map(async ([path, node]) => {
        // Prefer the live editor buffer over disk in case it's unsaved.
        const openTab = openFiles.find((f) => f.pathSegments.join('/') === path);
        const content = openTab ? openTab.model.getValue() : await readFileText(node.handle as FileSystemFileHandle);
        return { path, content };
      }),
    );
    const prompt = buildFileEditPrompt(instruction, files, repoMap, promptTemplate);
    await navigator.clipboard.writeText(prompt);
    setStatus('プロンプトをクリップボードにコピーしました。Copilotのチャット欄に貼り付けて、内容を確認してから送信してください。');
  }

  // Each block defaults to its own detected suggestedPath — critical for a
  // multi-file response (several `path`:\n```\n...``` blocks), where every
  // block needs a DIFFERENT target. Only when a block has no detected path
  // at all does it fall back to the active file, since that's the one
  // sensible guess for a genuinely single-file response.
  function handleParseResponse() {
    if (!pastedResponse.trim()) return;
    const parsed = extractCodeBlocks(pastedResponse);
    setBlocks(parsed);
    const activePath = activeTab?.pathSegments.join('/') ?? '';
    const defaults: Record<string, string> = {};
    for (const block of parsed) defaults[block.id] = block.suggestedPath ?? activePath;
    setApplyTargetByBlock(defaults);
    setStatus(null);
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
    <div className="copilot-panel">
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
      {subTab === 'plan' ? (
        <PlanPanel />
      ) : (
        <>
      <div className="copilot-sections-row">
      <div className="copilot-section">
        <div className="copilot-section-title">プロンプト作成</div>
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
              <button disabled={!instruction.trim()} onClick={() => void handleCopyPrompt()}>
                クリップボードにコピー
              </button>
            </div>
          </>
        ) : (
          <div className="copilot-hint">フォルダを開くとプロンプトを作成できます。</div>
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
          <>
          {blocks.length > 0 && (
            <div className="copilot-actions">
              <button onClick={() => void handleApplyAll()}>すべて適用</button>
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
        </>
      )}
    </div>
  );
}
