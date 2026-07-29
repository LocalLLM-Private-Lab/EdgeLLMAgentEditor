import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeNode } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { listWorkspaceFiles } from '../copilot/workspaceFileList';
import { fuzzyScore, type Command } from '../commands/appCommands';
import './QuickOpenModal.css';

interface ScoredFile {
  node: FileTreeNode;
  score: number;
}

export function QuickOpenModal({
  commands,
  onClose,
}: {
  /** Same command list AppCommandBar.tsx uses (defined once in App.tsx) —
   * this is just VS Code's `>` convention for reaching the same commands
   * from the Ctrl+P palette instead of the always-visible header bar. */
  commands: Command[];
  onClose: () => void;
}) {
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

  // VS Code convention: a leading ">" switches from "go to file" to
  // "run a command".
  const isCommandMode = query.startsWith('>');

  const fileResults = useMemo(() => {
    if (!allFiles) return [];
    const scored: ScoredFile[] = [];
    for (const node of allFiles) {
      const score = fuzzyScore(query, node.id);
      if (score !== null) scored.push({ node, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((s) => s.node);
  }, [allFiles, query]);

  const commandResults = useMemo(() => {
    if (!isCommandMode) return [];
    const commandQuery = query.slice(1);
    return commands.filter((cmd) => fuzzyScore(commandQuery, cmd.label) !== null);
  }, [isCommandMode, query, commands]);

  const resultCount = isCommandMode ? commandResults.length : fileResults.length;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function openSelected(index: number) {
    if (isCommandMode) {
      const cmd = commandResults[index];
      if (!cmd) return;
      cmd.run();
      onClose();
      return;
    }
    const node = fileResults[index];
    if (!node) return;
    void useEditorTabsStore.getState().openFile(node);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, resultCount - 1));
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
          placeholder={'ファイル名を入力してジャンプ、または ">" でコマンドを実行...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="quick-open-list">
          {isCommandMode ? (
            commandResults.length === 0 ? (
              <div className="quick-open-empty">該当するコマンドがありません</div>
            ) : (
              commandResults.map((cmd, i) => (
                <div
                  key={cmd.id}
                  className={`quick-open-item ${i === selectedIndex ? 'active' : ''}`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => openSelected(i)}
                >
                  {cmd.label}
                </div>
              ))
            )
          ) : allFiles === null ? (
            <div className="quick-open-empty">読み込み中...</div>
          ) : fileResults.length === 0 ? (
            <div className="quick-open-empty">該当するファイルがありません</div>
          ) : (
            fileResults.map((node, i) => (
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
