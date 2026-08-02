import { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { ensureLanguageTokenization, isCustomThemeReady, TEXTMATE_THEME_ID } from '../monaco/textmateTokenization';
import './MultiDiffViewModal.css';

export interface MultiDiffItem {
  id: string;
  fileName: string;
  original: string;
  modified: string;
  language: string;
  /** Reuse live editor models when this comparison is for an open file. */
  originalModel?: monaco.editor.ITextModel;
  modifiedModel?: monaco.editor.ITextModel;
  /** File-to-file comparisons allow editing both sides. */
  bothEditable?: boolean;
  /** If omitted, the view is read-only and only shows the diff. */
  onApply?: () => Promise<void>;
}

interface MultiDiffViewModalProps {
  title: string;
  files: MultiDiffItem[];
  onClose: () => void;
  onAllApplied?: () => void;
}

/** A single review surface for changes spanning several files. The file list
 * stays visible while Monaco shows the selected file's side-by-side diff, so
 * users can review a multi-file change without opening one modal per file. */
export function MultiDiffViewModal({ title, files, onClose, onAllApplied }: MultiDiffViewModalProps) {
  const [activeId, setActiveId] = useState(files[0]?.id ?? '');
  const [appliedIds, setAppliedIds] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeFile = useMemo(
    () => files.find((file) => file.id === activeId) ?? files[0],
    [activeId, files],
  );

  useEffect(() => {
    if (!activeFile || !containerRef.current) return;
    let disposed = false;
    let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: monaco.editor.ITextModel | undefined;
    let modifiedModel: monaco.editor.ITextModel | undefined;
    let ownsOriginalModel = false;
    let ownsModifiedModel = false;

    void ensureLanguageTokenization(activeFile.language).then(() => {
      if (disposed || !containerRef.current) return;
      diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: false,
        renderSideBySide: true,
        automaticLayout: true,
        theme: isCustomThemeReady() ? TEXTMATE_THEME_ID : 'vs-dark',
        originalEditable: activeFile.bothEditable === true,
        minimap: { enabled: false },
      });
      originalModel = activeFile.originalModel;
      if (!originalModel) {
        originalModel = monaco.editor.createModel(activeFile.original, activeFile.language);
        ownsOriginalModel = true;
      }
      modifiedModel = activeFile.modifiedModel;
      if (!modifiedModel) {
        modifiedModel = monaco.editor.createModel(activeFile.modified, activeFile.language);
        ownsModifiedModel = true;
      }
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    });

    return () => {
      disposed = true;
      diffEditor?.dispose();
      if (ownsOriginalModel) originalModel?.dispose();
      if (ownsModifiedModel) modifiedModel?.dispose();
    };
  }, [activeFile]);

  if (!activeFile) return null;

  const applyableFiles = files.filter((file) => file.onApply && !appliedIds.has(file.id));
  const canApplyCurrent = Boolean(activeFile.onApply && !appliedIds.has(activeFile.id));

  async function applyCurrent() {
    if (!activeFile.onApply || appliedIds.has(activeFile.id) || applying) return;
    setApplying(true);
    try {
      await activeFile.onApply();
      setAppliedIds((current) => new Set(current).add(activeFile.id));
    } finally {
      setApplying(false);
    }
  }

  async function applyAll() {
    if (applyableFiles.length === 0 || applying) return;
    setApplying(true);
    try {
      for (const file of applyableFiles) {
        await file.onApply?.();
        setAppliedIds((current) => new Set(current).add(file.id));
      }
      onAllApplied?.();
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="multi-diff-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="multi-diff-modal">
        <div className="multi-diff-header">
          <div className="multi-diff-title">
            <strong>{title}</strong>
            <span>{files.length}ファイル</span>
          </div>
          <button className="multi-diff-close" onClick={onClose} aria-label="差分ビューを閉じる">
            ×
          </button>
        </div>

        <div className="multi-diff-content">
          <aside className="multi-diff-file-list" aria-label="差分ファイル一覧">
            {files.map((file) => {
              const isApplied = appliedIds.has(file.id);
              return (
                <button
                  key={file.id}
                  className={`multi-diff-file ${file.id === activeFile.id ? 'active' : ''} ${isApplied ? 'applied' : ''}`}
                  onClick={() => setActiveId(file.id)}
                >
                  <span className="multi-diff-file-name" title={file.fileName}>{file.fileName}</span>
                  <span className="multi-diff-file-status">{isApplied ? '✓ 適用済み' : '変更あり'}</span>
                </button>
              );
            })}
          </aside>

          <section className="multi-diff-editor-pane">
            <div className="multi-diff-editor-header">
              <span title={activeFile.fileName}>{activeFile.fileName}</span>
              {appliedIds.has(activeFile.id) && <span className="multi-diff-applied-badge">適用済み</span>}
            </div>
            <div ref={containerRef} className="multi-diff-editor" />
          </section>
        </div>

        <div className="multi-diff-footer">
          <span className="multi-diff-summary">
            {appliedIds.size > 0 ? `${appliedIds.size}/${files.length}件を適用済み` : '変更内容を確認してください'}
          </span>
          <div className="multi-diff-actions">
            {activeFile.onApply && (
              <button onClick={() => void applyCurrent()} disabled={!canApplyCurrent || applying}>
                このファイルを適用
              </button>
            )}
            {applyableFiles.length > 0 && (
              <button className="primary" onClick={() => void applyAll()} disabled={applying}>
                すべて適用
              </button>
            )}
            <button onClick={onClose}>{applyableFiles.length > 0 ? 'キャンセル' : '閉じる'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
