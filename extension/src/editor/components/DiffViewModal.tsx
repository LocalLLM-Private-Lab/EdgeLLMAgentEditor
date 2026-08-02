import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { ensureLanguageTokenization, isCustomThemeReady, TEXTMATE_THEME_ID } from '../monaco/textmateTokenization';
import './DiffViewModal.css';

interface DiffViewModalProps {
  fileName: string;
  original: string;
  modified: string;
  language: string;
  onAccept: () => void;
  onCancel: () => void;
}

export function DiffViewModal({
  fileName,
  original,
  modified,
  language,
  onAccept,
  onCancel,
}: DiffViewModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: monaco.editor.ITextModel | undefined;
    let modifiedModel: monaco.editor.ITextModel | undefined;

    void ensureLanguageTokenization(language).then(() => {
      if (disposed || !containerRef.current) return;
      diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: false,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        theme: isCustomThemeReady() ? TEXTMATE_THEME_ID : 'vs-dark',
      });
      originalModel = monaco.editor.createModel(original, language);
      modifiedModel = monaco.editor.createModel(modified, language);
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    });

    return () => {
      disposed = true;
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [original, modified, language]);

  return (
    <div className="diff-modal-overlay">
      <div className="diff-modal">
        <div className="diff-modal-header">
          <span>{fileName} への適用プレビュー</span>
          <div className="diff-modal-actions">
            <button onClick={onAccept}>適用して保存</button>
            <button onClick={onCancel}>キャンセル</button>
          </div>
        </div>
        <div ref={containerRef} className="diff-modal-body" />
      </div>
    </div>
  );
}
