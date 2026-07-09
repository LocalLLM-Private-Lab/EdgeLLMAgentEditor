import { useState } from 'react';
import type { FileTreeNode } from '../../shared/types';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { listWorkspaceFiles } from '../copilot/workspaceFileList';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import './FileContextPicker.css';

interface FileContextPickerProps {
  selectedPaths: string[];
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
}

const MAX_RESULTS = 50;

/** GitHub Copilot Chat-style context picker: every currently open tab is
 * always shown as a chip — dim/outlined if not yet included, solid (with
 * an explicit ×) once clicked in. A secondary search covers files that
 * aren't open at all. */
export function FileContextPicker({ selectedPaths, onAdd, onRemove }: FileContextPickerProps) {
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState<FileTreeNode[] | null>(null);

  useDismissOnOutsideClick(() => setPickerOpen(false), pickerOpen);

  async function openPicker() {
    setPickerOpen(true);
    setQuery('');
    if (!allFiles && rootHandle) {
      setAllFiles(await listWorkspaceFiles(rootHandle));
    }
  }

  function choose(path: string) {
    onAdd(path);
    setPickerOpen(false);
  }

  const openFilePaths = openFiles.map((f) => f.pathSegments.join('/'));
  // Every open tab gets a chip (dim until clicked in); anything already
  // selected also gets one even if it's not open (e.g. added via search).
  const chipPaths = [...new Set([...openFilePaths, ...selectedPaths])];

  const searchResults = (allFiles ?? [])
    .filter((f) => !chipPaths.includes(f.id))
    .filter((f) => query.trim() === '' || f.id.toLowerCase().includes(query.toLowerCase()))
    .slice(0, MAX_RESULTS);

  return (
    <div className="file-context-picker" onClick={(e) => e.stopPropagation()}>
      <div className="file-context-chips">
        {chipPaths.map((path) => {
          const included = selectedPaths.includes(path);
          return (
            <button
              key={path}
              type="button"
              className={`file-context-chip ${included ? 'included' : 'available'}`}
              onClick={() => (included ? onRemove(path) : onAdd(path))}
              title={included ? 'クリックしてコンテキストから除外' : 'クリックしてコンテキストに追加'}
            >
              {path}
              {included && (
                <span
                  className="file-context-chip-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(path);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="file-context-add-btn"
          onClick={() => (pickerOpen ? setPickerOpen(false) : void openPicker())}
        >
          + 他のファイルを検索
        </button>
      </div>
      {pickerOpen && (
        <div className="file-context-dropdown">
          <input
            autoFocus
            className="file-context-search"
            placeholder="ファイルを検索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allFiles === null ? (
            <div className="file-context-loading">読み込み中...</div>
          ) : searchResults.length === 0 ? (
            <div className="file-context-loading">該当するファイルがありません</div>
          ) : (
            searchResults.map((f) => (
              <button key={f.id} className="file-context-option" onClick={() => choose(f.id)}>
                {f.id}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
