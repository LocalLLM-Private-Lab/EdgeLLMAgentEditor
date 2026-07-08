import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
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
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      theme: 'vs-dark',
    });
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    return () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
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
