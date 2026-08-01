import { useCallback, useEffect, useState } from 'react';
import { useDockStore } from '../state/dockStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { useDiffViewStore } from '../state/diffViewStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { readFileBytes } from '../fs/fsaWorkspace';
import { decodeBytes, detectEncodingFromBytes } from '../fs/textEncodings';
import { languageFromFilename } from '../monaco/languageRegistrations';
import { resolveWorkspaceFiles } from '../copilot/resolveWorkspaceFile';
import { runAndCapture, type RunAndCaptureResult } from '../copilot/runAndCapture';
import { MultiDiffViewModal, type MultiDiffItem } from './MultiDiffViewModal';
import './SourceControlPanel.css';

type VcsKind = 'git' | 'svn';

interface ChangeEntry {
  path: string;
  /** Git's two-column porcelain status, or SVN's one-character status. */
  status: string;
  previousPath?: string;
}

interface RepositoryInfo {
  kind: VcsKind;
  branch: string | null;
  branches: string[];
}

interface HistoryEntry {
  id: string;
  date: string;
  author: string;
  message: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readWorkspaceText(handle: FileSystemFileHandle): Promise<string> {
  const bytes = await readFileBytes(handle);
  return decodeBytes(bytes, detectEncodingFromBytes(bytes));
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

function gitStatusLabel(status: string): string {
  if (status === '??') return 'U';
  const staged = status[0] !== ' ';
  const working = status[1] !== ' ';
  if (staged && working) return 'M*';
  if (staged) return status[0] === 'A' ? 'A' : status[0] === 'D' ? 'D' : 'M';
  return status[1] === 'D' ? 'D' : 'M';
}

function parseGitStatus(output: string): ChangeEntry[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length >= 4 && line[2] === ' ')
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(' -> ');
      const previousPath = renameParts.length > 1 ? renameParts[0] : undefined;
      return {
        path: renameParts[renameParts.length - 1].replace(/^"|"$/g, ''),
        status,
        previousPath,
      };
    });
}

function parseSvnStatus(output: string): ChangeEntry[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length >= 9 && line[0] !== ' ' && line[0] !== 'I')
    .map((line) => ({ path: line.slice(8).trim(), status: line[0] }));
}

function statusLabel(repo: RepositoryInfo, change: ChangeEntry): string {
  if (repo.kind === 'git') return gitStatusLabel(change.status);
  return change.status === '?' ? 'U' : change.status;
}

function isGitStaged(change: ChangeEntry): boolean {
  return change.status !== '??' && change.status[0] !== ' ';
}

function gitStageLabel(change: ChangeEntry): string {
  if (change.status === '??') return '未追跡';
  const staged = change.status[0] !== ' ';
  const workingTree = change.status[1] !== ' ';
  if (staged && workingTree) return 'ステージ済み + 未ステージ変更';
  return staged ? 'ステージ済み' : '未ステージ';
}

function parseGitBranches(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseGitHistory(output: string): HistoryEntry[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id = '', date = '', author = '', ...messageParts] = line.split('\t');
      return { id, date, author, message: messageParts.join('\t') };
    });
}

function parseSvnHistory(output: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const document = new DOMParser().parseFromString(output, 'application/xml');
  for (const node of Array.from(document.querySelectorAll('logentry'))) {
    entries.push({
      id: node.getAttribute('revision') ?? '',
      date: node.querySelector('date')?.textContent?.slice(0, 10) ?? '',
      author: node.querySelector('author')?.textContent ?? '',
      message: node.querySelector('msg')?.textContent?.trim() ?? '',
    });
  }
  return entries;
}

export function SourceControlPanel() {
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const workspaceRealPath = useWorkspaceStore((s) => s.workspaceRealPath);
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const setTerminalVisible = useDockStore((s) => s.setVisible);
  const openDiff = useDiffViewStore((s) => s.openDiff);
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<MultiDiffItem[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);

  const run = useCallback(
    async (command: string, label: string): Promise<RunAndCaptureResult> => {
      setTerminalVisible('terminal', false);
      return runAndCapture(command, label, { background: true });
    },
    [setTerminalVisible],
  );

  const refresh = useCallback(async () => {
    if (!rootHandle) return;
    setLoading(true);
    setError(null);
    try {
      const [hasGitMetadata, hasSvnMetadata] = await Promise.all([
        hasWorkspaceEntry(rootHandle, '.git'),
        hasWorkspaceEntry(rootHandle, '.svn'),
      ]);
      const gitProbe = await run('git rev-parse --is-inside-work-tree', 'Gitリポジトリを確認');
      const isGitRepository =
        hasGitMetadata || (gitProbe.exitCode === 0 && gitProbe.output.split(/\r?\n/).some((line) => line.trim() === 'true'));
      if (isGitRepository) {
        const statusResult = await run('git status --porcelain=v1 --untracked-files=all', 'Gitの変更を取得');
        if (statusResult.exitCode !== 0) throw new Error(statusResult.output.trim() || 'git statusに失敗しました。');
        const branchResult = await run('git branch --show-current', 'Gitのブランチを取得');
        const branchListResult = await run("git branch --format='%(refname:short)'", 'Gitのブランチ一覧を取得');
        setRepository({
          kind: 'git',
          branch: branchResult.output.trim() || null,
          branches: parseGitBranches(branchListResult.output),
        });
        setBranches(parseGitBranches(branchListResult.output));
        setChanges(parseGitStatus(statusResult.output));
      } else {
        const svnProbe = await run('svn info', 'SVNリポジトリを確認');
        const isSvnRepository = hasSvnMetadata || svnProbe.exitCode === 0;
        if (!isSvnRepository) {
          setRepository(null);
          setBranches([]);
          setChanges([]);
          setError('GitまたはSVNのリポジトリを検出できませんでした。');
          return;
        }
        const statusResult = await run('svn status', 'SVNの変更を取得');
        if (statusResult.exitCode !== 0) throw new Error(statusResult.output.trim() || 'svn statusに失敗しました。');
        setRepository({ kind: 'svn', branch: null, branches: [] });
        setBranches([]);
        setChanges(parseSvnStatus(statusResult.output));
      }
    } catch (err) {
      setRepository(null);
      setBranches([]);
      setChanges([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rootHandle, run]);

  useEffect(() => {
    setSelectedPaths(new Set());
    setSelectionAnchorPath(null);
    if (rootHandle) void refresh();
    else {
      setRepository(null);
      setBranches([]);
      setChanges([]);
      setHistory([]);
    }
  }, [rootHandle, refresh]);

  function selectChange(path: string, shiftKey: boolean) {
    if (shiftKey && selectionAnchorPath) {
      const anchorIndex = changes.findIndex((change) => change.path === selectionAnchorPath);
      const targetIndex = changes.findIndex((change) => change.path === path);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        setSelectedPaths(new Set(changes.slice(start, end + 1).map((change) => change.path)));
        return;
      }
    }
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setSelectionAnchorPath(path);
  }

  function pathsForAction(): string[] {
    return selectedPaths.size > 0 ? [...selectedPaths] : changes.map((change) => change.path);
  }

  function selectedOnlyPaths(): string[] {
    return [...selectedPaths];
  }

  async function runGitPathAction(action: 'stage' | 'unstage') {
    if (!repository || repository.kind !== 'git') return;
    const paths = pathsForAction();
    if (paths.length === 0) return;
    setWorking(true);
    try {
      const command =
        action === 'stage'
          ? `git add -- ${paths.map(shellQuote).join(' ')}`
          : `git reset HEAD -- ${paths.map(shellQuote).join(' ')}`;
      const result = await run(command, action === 'stage' ? 'Gitにステージ' : 'Gitのステージを解除');
      if (result.exitCode !== 0) setError(result.output.trim() || 'Git操作に失敗しました。');
      else await refresh();
    } finally {
      setWorking(false);
    }
  }

  async function handleCommit() {
    if (!repository || !commitMessage.trim()) return;
    const paths = pathsForAction();
    if (paths.length === 0) return;
    setWorking(true);
    try {
      const command =
        repository.kind === 'git'
          ? `git commit -m ${shellQuote(commitMessage.trim())}`
          : `svn commit --message ${shellQuote(commitMessage.trim())} -- ${paths.map(shellQuote).join(' ')}`;
      const result = await run(command, repository.kind === 'git' ? 'Gitにコミット' : 'SVNにコミット');
      if (result.exitCode !== 0) setError(result.output.trim() || 'コミットに失敗しました。');
      else {
        setCommitMessage('');
        setSelectedPaths(new Set());
        await refresh();
      }
    } finally {
      setWorking(false);
    }
  }

  async function handleSync(action: 'pull' | 'push' | 'update') {
    if (!repository) return;
    if (action === 'pull' && changes.length > 0) {
      if (!window.confirm('未コミットの変更があります。リモートから取得してよいですか？')) return;
    }
    setWorking(true);
    setError(null);
    try {
      const command =
        repository.kind === 'svn'
          ? 'svn update'
          : action === 'pull'
            ? 'git pull --ff-only'
            : 'git push';
      const label = repository.kind === 'svn' ? 'SVNを更新' : action === 'pull' ? 'Gitをpull' : 'Gitをpush';
      const result = await run(command, label);
      if (result.exitCode !== 0) setError(result.output.trim() || `${label}に失敗しました。`);
      else await refresh();
    } finally {
      setWorking(false);
    }
  }

  async function handleCheckout(branch: string) {
    if (!repository || repository.kind !== 'git' || !branch || branch === repository.branch) return;
    if (changes.length > 0 && !window.confirm('未コミットの変更があります。ブランチを切り替えますか？')) return;
    setWorking(true);
    setError(null);
    try {
      const result = await run(`git switch -- ${shellQuote(branch)}`, `ブランチを切り替え: ${branch}`);
      if (result.exitCode !== 0) setError(result.output.trim() || 'ブランチの切り替えに失敗しました。');
      else {
        setSelectedPaths(new Set());
        await refresh();
      }
    } finally {
      setWorking(false);
    }
  }

  async function handleShowHistory() {
    if (!repository) return;
    setWorking(true);
    setError(null);
    try {
      const result =
        repository.kind === 'git'
          ? await run('git log -30 --date=short --pretty=format:%h%x09%ad%x09%an%x09%s', 'Gitの履歴を取得')
          : await run('svn log -l 30 --xml', 'SVNの履歴を取得');
      if (result.exitCode !== 0) {
        setError(result.output.trim() || '履歴の取得に失敗しました。');
        return;
      }
      setHistory(repository.kind === 'git' ? parseGitHistory(result.output) : parseSvnHistory(result.output));
      setShowHistory(true);
    } finally {
      setWorking(false);
    }
  }

  async function handleRevert() {
    if (!repository) return;
    const paths = selectedOnlyPaths();
    if (paths.length === 0) return;
    if (!window.confirm(`${paths.length}件の変更を元に戻しますか？未保存の内容は失われます。`)) return;
    setWorking(true);
    setError(null);
    try {
      if (repository.kind === 'svn') {
        const result = await run(`svn revert -- ${paths.map(shellQuote).join(' ')}`, 'SVNの変更を元に戻す');
        if (result.exitCode !== 0) setError(result.output.trim() || 'SVNのrevertに失敗しました。');
        else {
          setSelectedPaths(new Set());
          await refresh();
        }
      } else {
        const selectedChanges = changes.filter((change) => paths.includes(change.path));
        const tracked = selectedChanges.filter((change) => change.status !== '??' && change.status[0] !== 'A');
        const newFiles = selectedChanges.filter((change) => change.status === '??' || change.status[0] === 'A');
        if (tracked.length > 0) {
          const result = await run(
            `git restore --source=HEAD --staged --worktree -- ${tracked.map((change) => shellQuote(change.path)).join(' ')}`,
            'Gitの変更を元に戻す',
          );
          if (result.exitCode !== 0) {
            setError(result.output.trim() || 'Gitのrevertに失敗しました。');
            return;
          }
        }
        if (newFiles.length > 0) {
          const resetResult = await run(
            `git reset HEAD -- ${newFiles.map((change) => shellQuote(change.path)).join(' ')}`,
            'Gitの追加を取り消す',
          );
          if (resetResult.exitCode === 0) {
            const cleanResult = await run(
              `git clean -f -- ${newFiles.map((change) => shellQuote(change.path)).join(' ')}`,
              'Gitの新規ファイルを削除',
            );
            if (cleanResult.exitCode !== 0) setError(cleanResult.output.trim() || 'Gitの新規ファイル削除に失敗しました。');
          } else setError(resetResult.output.trim() || 'Gitの追加取り消しに失敗しました。');
        }
        setSelectedPaths(new Set());
        await refresh();
      }
    } finally {
      setWorking(false);
    }
  }

  async function buildDiffFiles(paths: string[]): Promise<MultiDiffItem[]> {
    if (!repository || !rootHandle) return [];
      const resolved = await resolveWorkspaceFiles(rootHandle, paths);
      const files: MultiDiffItem[] = [];
      for (const path of paths) {
        const change = changes.find((item) => item.path === path);
        if (!change) continue;
        const openTab = openFiles.find((file) => file.pathSegments.join('/') === path);
        const node = resolved.get(path);
        const modified =
          openTab?.model?.getValue() ??
          (node ? await readWorkspaceText(node.handle as FileSystemFileHandle) : '');
        const isNew = repository.kind === 'git' ? change.status === '??' : change.status === '?';
        let original = '';
        if (!isNew) {
          const oldPath = change.previousPath ?? path;
          const result =
            repository.kind === 'git'
              ? await run(`git --no-pager show --no-ext-diff ${shellQuote(`HEAD:${oldPath}`)}`, `Git差分の元ファイルを取得: ${path}`)
              : await run(`svn cat -r BASE -- ${shellQuote(oldPath)}`, `SVN差分の元ファイルを取得: ${path}`);
          if (result.exitCode === 0) original = result.output;
        }
        files.push({
          id: path,
          fileName: path,
          original,
          modified,
          language: languageFromFilename(path),
          modifiedModel: openTab?.model,
        });
      }
      return files;
  }

  async function handleShowDiff() {
    if (!repository || !rootHandle) return;
    const paths = pathsForAction();
    if (paths.length === 0) return;
    setWorking(true);
    try {
      const files = await buildDiffFiles(paths);
      if (files.length > 0) setDiffFiles(files);
      else setError('差分を取得できるファイルがありません。');
    } finally {
      setWorking(false);
    }
  }

  async function handleOpenDiffInEditor(path: string) {
    if (!repository || !rootHandle) return;
    setWorking(true);
    setError(null);
    try {
      const files = await buildDiffFiles([path]);
      const file = files[0];
      if (!file) {
        setError('差分を取得できるファイルがありません。');
        return;
      }
      const resolved = await resolveWorkspaceFiles(rootHandle, [path]);
      const node = resolved.get(path);
      if (node?.kind === 'file') {
        await useEditorTabsStore.getState().openFile(node, { preview: false });
      }
      const groupId = useEditorTabsStore.getState().focusedGroupId;
      const modifiedFileId = openFiles.find((openFile) => openFile.pathSegments.join('/') === path)?.id;
      openDiff(groupId, {
        title: path,
        originalName: `${repository.kind === 'git' ? 'HEAD' : 'BASE'}: ${path}`,
        modifiedName: path,
        original: file.original,
        modified: file.modified,
        language: file.language,
        modifiedFileId,
      });
    } finally {
      setWorking(false);
    }
  }

  const selectedCount = selectedPaths.size;
  const hasGitStaged = repository?.kind === 'git' && changes.some(isGitStaged);
  const stagedCount = repository?.kind === 'git' ? changes.filter(isGitStaged).length : 0;
  const unstagedCount = repository?.kind === 'git' ? changes.filter((change) => !isGitStaged(change)).length : 0;

  return (
    <div className="source-control-panel">
      <div className="source-control-header">
        <span>ソース管理</span>
        <button onClick={() => void refresh()} disabled={loading || !rootHandle} title="更新" aria-label="更新">
          ↻
        </button>
      </div>

      {!rootHandle ? (
        <div className="source-control-empty">フォルダを開くとGit/SVNの状態を表示できます。</div>
      ) : loading && !repository ? (
        <div className="source-control-empty">リポジトリを確認中...</div>
      ) : error && !repository ? (
        <div className="source-control-error">{error}</div>
      ) : repository ? (
        <>
          <div className="source-control-repository">
            <span className="source-control-vcs-badge">{repository.kind.toUpperCase()}</span>
            <span className="source-control-repository-name">{rootHandle.name}</span>
            {repository.kind === 'git' && branches.length > 0 ? (
              <select
                className="source-control-branch-select"
                value={repository.branch ?? ''}
                onChange={(event) => void handleCheckout(event.target.value)}
                disabled={working}
                aria-label="Gitブランチ"
              >
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    ⑂ {branch}
                  </option>
                ))}
              </select>
            ) : (
              repository.branch && <span className="source-control-branch">⑂ {repository.branch}</span>
            )}
          </div>
          {!workspaceRealPath && (
            <div className="source-control-hint">
              コマンドはターミナルの作業フォルダで実行されます。別のフォルダの場合は実パスを登録してください。
            </div>
          )}
          {error && <div className="source-control-error">{error}</div>}
          <div className="source-control-actions">
            <button onClick={() => void handleShowDiff()} disabled={working || changes.length === 0}>
              選択の差分
            </button>
            {repository.kind === 'git' && (
              <>
                <button onClick={() => void handleSync('pull')} disabled={working}>
                  pull
                </button>
                <button onClick={() => void handleSync('push')} disabled={working}>
                  push
                </button>
                <button onClick={() => void runGitPathAction('stage')} disabled={working || changes.length === 0}>
                  {selectedCount > 0 ? '選択をステージ' : 'すべてステージ'}
                </button>
                <button onClick={() => void runGitPathAction('unstage')} disabled={working || !hasGitStaged}>
                  ステージ解除
                </button>
              </>
            )}
            {repository.kind === 'svn' && (
              <button onClick={() => void handleSync('update')} disabled={working}>
                update
              </button>
            )}
            <button onClick={() => (showHistory ? setShowHistory(false) : void handleShowHistory())} disabled={working}>
              {showHistory ? '履歴を閉じる' : '履歴'}
            </button>
            <button onClick={() => void handleRevert()} disabled={working || selectedCount === 0}>
              選択を元に戻す
            </button>
          </div>
          {showHistory && (
            <div className="source-control-history">
              <div className="source-control-history-title">履歴（最新30件）</div>
              {history.length === 0 ? (
                <div className="source-control-empty">履歴はありません。</div>
              ) : (
                history.map((entry, index) => (
                  <div className="source-control-history-entry" key={`${entry.id}-${index}`}>
                    <div className="source-control-history-meta">
                      <span>{entry.id}</span>
                      <span>{entry.date}</span>
                      <span>{entry.author}</span>
                    </div>
                    <div className="source-control-history-message">{entry.message || '(メッセージなし)'}</div>
                  </div>
                ))
              )}
            </div>
          )}
          <div className="source-control-section-title">
            <span>変更 ({changes.length})</span>
            {repository.kind === 'git' && (
              <span className="source-control-stage-summary">
                <span className="source-control-stage-summary-staged">ステージ済み {stagedCount}</span>
                <span className="source-control-stage-summary-unstaged">未ステージ {unstagedCount}</span>
              </span>
            )}
            <button
              onClick={() => setSelectedPaths(new Set(changes.map((change) => change.path)))}
              disabled={changes.length === 0}
            >
              すべて選択
            </button>
          </div>
          {changes.length === 0 ? (
            <div className="source-control-empty">変更はありません。</div>
          ) : (
            <div className="source-control-changes">
              {changes.map((change) => (
                <button
                  key={`${change.status}:${change.path}`}
                  className={`source-control-change ${selectedPaths.has(change.path) ? 'selected' : ''}`}
                  onClick={(event) => selectChange(change.path, event.shiftKey)}
                  onDoubleClick={() => {
                    setSelectedPaths((current) => new Set(current).add(change.path));
                    setSelectionAnchorPath(change.path);
                    void handleOpenDiffInEditor(change.path);
                  }}
                  title={`${change.path}\nダブルクリックでバージョン差分をエディタに表示`}
                >
                  <span className="source-control-change-path">{change.path}</span>
                  {repository.kind === 'git' && (
                    <span
                      className={`source-control-stage-badge ${isGitStaged(change) ? 'staged' : 'unstaged'}`}
                      title={gitStageLabel(change)}
                    >
                      {gitStageLabel(change)}
                    </span>
                  )}
                  <span className={`source-control-status status-${statusLabel(repository, change).toLowerCase()}`}>
                    {statusLabel(repository, change)}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="source-control-commit">
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="コミットメッセージ"
              rows={3}
            />
            <button
              className="primary"
              onClick={() => void handleCommit()}
              disabled={working || !commitMessage.trim() || changes.length === 0 || (repository.kind === 'git' && !hasGitStaged)}
            >
              {repository.kind === 'git' ? 'ステージ済みをコミット' : '選択をコミット'}
            </button>
            {repository.kind === 'git' && !hasGitStaged && changes.length > 0 && (
              <div className="source-control-hint">Gitは先に変更をステージしてください。</div>
            )}
          </div>
        </>
      ) : null}

      {diffFiles && (
        <MultiDiffViewModal
          title={`${repository?.kind.toUpperCase() ?? 'VCS'}の変更差分`}
          files={diffFiles}
          onClose={() => setDiffFiles(null)}
        />
      )}
    </div>
  );
}
