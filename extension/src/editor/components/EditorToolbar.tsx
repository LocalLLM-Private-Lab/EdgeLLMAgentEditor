import { useCallback, useState } from 'react';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useDockStore } from '../state/dockStore';
import { readFileBytes } from '../fs/fsaWorkspace';
import { decodeBytes } from '../fs/textEncodings';
import { detectEncodingFromBytes } from '../fs/textEncodings';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { languageFromFilename } from '../monaco/languageRegistrations';
import { runAndCapture, type RunAndCaptureResult } from '../copilot/runAndCapture';
import { MultiDiffViewModal, type MultiDiffItem } from './MultiDiffViewModal';
import './EditorToolbar.css';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function hasWorkspaceEntry(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await root.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      await root.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

async function readWorkspaceText(handle: FileSystemFileHandle): Promise<string> {
  const bytes = await readFileBytes(handle);
  return decodeBytes(bytes, detectEncodingFromBytes(bytes));
}

function cleanCommandPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// Global (not per-group) navigation/save controls — back/forward walks a
// single window-wide history spanning every group, same as VS Code; save
// always acts on whichever group currently has focus (editorTabsStore's
// activeFileId mirrors that). Each group's own tab strip lives in
// EditorGroupPane instead of here.
export function EditorToolbar() {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const navIndex = useEditorTabsStore((s) => s.navIndex);
  const navHistoryLength = useEditorTabsStore((s) => s.navHistory.length);
  const goBack = useEditorTabsStore((s) => s.goBack);
  const goForward = useEditorTabsStore((s) => s.goForward);
  const saveFile = useEditorTabsStore((s) => s.saveFile);
  const saveAllFiles = useEditorTabsStore((s) => s.saveAllFiles);
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const setTerminalVisible = useDockStore((s) => s.setVisible);
  const [multiDiffPreview, setMultiDiffPreview] = useState<MultiDiffItem[] | null>(null);

  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const hasDirty = openFiles.some((f) => f.isDirty);
  const diffCandidates = openFiles.filter(
    (file) => file.kind === 'text' && file.fileHandle && file.model,
  );

  const run = useCallback(
    async (command: string, label: string): Promise<RunAndCaptureResult> => {
      setTerminalVisible('terminal', false);
      return runAndCapture(command, label, { background: true });
    },
    [setTerminalVisible],
  );

  async function readVersionControlDiffs(): Promise<MultiDiffItem[]> {
    if (!rootHandle || diffCandidates.length === 0) return [];
    const paths = diffCandidates.map((file) => file.pathSegments.join('/'));
    const pathArgs = paths.map(shellQuote).join(' ');
    const resolved = await resolveWorkspaceFiles(rootHandle, paths);
    const gitMetadata = await hasWorkspaceEntry(rootHandle, '.git');
    const svnMetadata = await hasWorkspaceEntry(rootHandle, '.svn');
    const gitProbe = gitMetadata ? null : await run('git rev-parse --is-inside-work-tree', 'Gitを確認');
    const isGit = gitMetadata || (gitProbe?.exitCode === 0 && gitProbe.output.split(/\r?\n/).some((line) => line.trim() === 'true'));
    const isSvn = !isGit && (svnMetadata || (await run('svn info', 'SVNを確認')).exitCode === 0);
    if (!isGit && !isSvn) return [];

    let changedPaths: string[];
    let untrackedPaths = new Set<string>();
    if (isGit) {
      const trackedResult = await run(`git diff --name-only HEAD -- ${pathArgs}`, 'Gitの差分ファイルを取得');
      const untrackedResult = await run(
        `git ls-files --others --exclude-standard -- ${pathArgs}`,
        'Gitの未追跡ファイルを取得',
      );
      changedPaths = cleanCommandPaths(trackedResult.output);
      untrackedPaths = new Set(cleanCommandPaths(untrackedResult.output));
      changedPaths = [...new Set([...changedPaths, ...untrackedPaths])];
    } else {
      const statusResult = await run(`svn status -- ${pathArgs}`, 'SVNの差分ファイルを取得');
      changedPaths = statusResult.output
        .split(/\r?\n/)
        .filter((line) => line.length >= 9 && line[0] !== ' ' && line[0] !== 'I')
        .map((line) => line.slice(8).trim());
    }

    const files: MultiDiffItem[] = [];
    for (const path of changedPaths) {
      const openFile = diffCandidates.find((file) => file.pathSegments.join('/') === path);
      if (!openFile) continue;
      const node = resolved.get(path);
      const modified =
        openFile.model?.getValue() ?? (node ? await readWorkspaceText(node.handle as FileSystemFileHandle) : '');
      let original = '';
      const isNew = isGit ? untrackedPaths.has(path) : path.startsWith('?');
      if (!isNew) {
        const result = isGit
          ? await run(`git --no-pager show --no-ext-diff ${shellQuote(`HEAD:${path}`)}`, `Gitの基準ファイルを取得: ${path}`)
          : await run(`svn cat -r BASE -- ${shellQuote(path)}`, `SVNの基準ファイルを取得: ${path}`);
        if (result.exitCode === 0) original = result.output;
      }
      files.push({
        id: path,
        fileName: path,
        original,
        modified,
        language: languageFromFilename(path),
      });
    }
    return files;
  }

  async function handleOpenMultiDiff() {
    // With two or more open workspace files, this command means a direct
    // file-to-file comparison. It must not depend on dirty state or VCS
    // status: a saved file can differ from another saved file just as well.
    if (diffCandidates.length >= 2) {
      const reference = diffCandidates.find((file) => file.id === activeFileId) ?? diffCandidates[0];
      const comparisons = diffCandidates
        .filter((file) => file.id !== reference.id)
        .map((file) => ({
          id: `${reference.id}:${file.id}`,
          fileName: `${reference.pathSegments.join('/')} ↔ ${file.pathSegments.join('/')}`,
          original: reference.model!.getValue(),
          modified: file.model!.getValue(),
          language: file.language,
          originalModel: reference.model,
          modifiedModel: file.model,
          bothEditable: true,
        } satisfies MultiDiffItem));
      setMultiDiffPreview(comparisons);
      return;
    }

    const dirtyFiles = diffCandidates;
    const previews: Array<MultiDiffItem | null> = await Promise.all(
      dirtyFiles.map(async (file) => {
        const original = decodeBytes(await readFileBytes(file.fileHandle!), file.encoding);
        const modified = file.model!.getValue();
        if (original === modified) return null;
        return {
          id: file.id,
          fileName: file.pathSegments.join('/'),
          original,
          modified,
          language: file.language,
          modifiedModel: file.model,
          onApply: () => saveFile(file.id),
        } satisfies MultiDiffItem;
      }),
    );
    const changedFiles = previews.filter((file): file is MultiDiffItem => file !== null);
    if (changedFiles.length > 0) {
      setMultiDiffPreview(changedFiles);
      return;
    }
    const versionControlFiles = await readVersionControlDiffs();
    if (versionControlFiles.length > 0) {
      setMultiDiffPreview(versionControlFiles);
      return;
    }
    window.alert('現在開いているファイルに、未保存またはGit/SVN上の差分はありません。');
  }

  return (
    <div className="editor-toolbar">
      <button
        className="editor-toolbar-button"
        disabled={navIndex <= 0}
        onClick={() => goBack()}
        title="戻る"
        aria-label="戻る"
      >
        ←
      </button>
      <button
        className="editor-toolbar-button"
        disabled={navIndex >= navHistoryLength - 1}
        onClick={() => goForward()}
        title="進む"
        aria-label="進む"
      >
        →
      </button>
      <button
        className="editor-toolbar-button"
        disabled={!activeTab || !activeTab.isDirty}
        onClick={() => activeFileId && void saveFile(activeFileId)}
        title="保存"
        aria-label="保存"
      >
        💾
      </button>
      <button
        className="editor-toolbar-button"
        disabled={!hasDirty}
        onClick={() => void saveAllFiles()}
        title="すべて保存"
        aria-label="すべて保存"
      >
        💾*
      </button>
      <button
        className="editor-toolbar-button editor-toolbar-diff-button"
        disabled={diffCandidates.length === 0}
        onClick={() => void handleOpenMultiDiff()}
        title="開いているファイルの差分"
        aria-label="開いているファイルの差分"
      >
        ◐ 差分
      </button>
      {multiDiffPreview && (
        <MultiDiffViewModal
          title="開いているファイルの差分"
          files={multiDiffPreview}
          onClose={() => setMultiDiffPreview(null)}
        />
      )}
    </div>
  );
}
