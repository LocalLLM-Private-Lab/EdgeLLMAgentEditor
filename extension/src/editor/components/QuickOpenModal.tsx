import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeNode } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { listWorkspaceFiles } from '../copilot/workspaceFileList';
import './QuickOpenModal.css';

interface ScoredFile {
  node: FileTreeNode;
  score: number;
}

/** Subsequence fuzzy match (every query char must appear in order,
 * case-insensitive) — not a full VS Code-grade matcher, but the same basic
 * idea: contiguous runs score higher, shorter paths are a slight
 * tiebreaker, so "app.tsx" beats a long unrelated path for query "app". */
function fuzzyScore(query: string, candidate: string): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      score += lastMatchIndex === ci - 1 ? 3 : 1;
      lastMatchIndex = ci;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score - c.length * 0.01;
}

export function QuickOpenModal({ onClose }: { onClose: () => void }) {
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const [allFiles, setAllFiles] = useState<FileTreeNode[] | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (rootHandle) void listWorkspaceFiles(rootHandle).then(setAllFiles);
  }, [rootHandle]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!allFiles) return [];
    const scored: ScoredFile[] = [];
    for (const node of allFiles) {
      const score = fuzzyScore(query, node.id);
      if (score !== null) scored.push({ node, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((s) => s.node);
  }, [allFiles, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function openSelected(index: number) {
    const node = results[index];
    if (!node) return;
    void useEditorTabsStore.getState().openFile(node);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openSelected(selectedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-overlay" onClick={onClose}>
      <div className="quick-open-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open-input"
          placeholder="ファイル名を入力してジャンプ..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="quick-open-list">
          {allFiles === null ? (
            <div className="quick-open-empty">読み込み中...</div>
          ) : results.length === 0 ? (
            <div className="quick-open-empty">該当するファイルがありません</div>
          ) : (
            results.map((node, i) => (
              <div
                key={node.id}
                className={`quick-open-item ${i === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => openSelected(i)}
              >
                {node.id}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
