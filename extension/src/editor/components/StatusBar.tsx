import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useKeybindingStore } from '../state/keybindingStore';
import { useEditorTabsStore } from '../state/editorTabsStore';
import { setKeybindingStatusNode } from '../monaco/keybindingStatusRegistry';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { ALL_ENCODINGS, ENCODING_LABELS, type TextEncodingId } from '../fs/textEncodings';
import { useLspStore } from '../lsp/lspStore';
import { pickLspWorkspaceFolder } from '../lsp/lspNativeLaunch';
import './MenuBar.css';
import './StatusBar.css';

function LspBadge({ activeLanguage }: { activeLanguage: string | null }) {
  const [open, setOpen] = useState(false);
  const status = useLspStore((s) => s.status);
  const fetchProgress = useLspStore((s) => s.fetchProgress);
  const installLanguage = useLspStore((s) => s.installLanguage);
  const installMessage = useLspStore((s) => s.installMessage);
  const indexing = useLspStore((s) => s.indexing);
  const indexingLanguage = useLspStore((s) => s.indexingLanguage);
  const indexingMessage = useLspStore((s) => s.indexingMessage);
  const indexingProgress = useLspStore((s) => s.indexingProgress);
  const errorMessage = useLspStore((s) => s.errorMessage);
  const rootUri = useLspStore((s) => s.rootUri);
  const serverVersion = useLspStore((s) => s.serverVersion);
  const readyLanguage = useLspStore((s) => s.readyLanguage);
  const workspaceRootOverride = useLspStore((s) => s.workspaceRootOverride);
  const setWorkspaceRootOverride = useLspStore((s) => s.setWorkspaceRootOverride);
  const [rootInput, setRootInput] = useState(workspaceRootOverride ?? '');
  const [picking, setPicking] = useState(false);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick(closeMenu, open);

  const handlePickFolder = useCallback(async () => {
    setPicking(true);
    setPickMessage(null);
    const result = await pickLspWorkspaceFolder();
    setPicking(false);
    if (result.status === 'picked') {
      setRootInput(result.path);
      void setWorkspaceRootOverride(result.path);
    } else if (result.status === 'unavailable') {
      setPickMessage(
        `lsp-host is not registered. Run lsp-host/install-native-messaging-host.bat once. (${result.message})`,
      );
    } else if (result.status === 'timeout') {
      setPickMessage('No response.');
    } else if (result.status === 'error') {
      setPickMessage(result.message);
    }
    // 'cancelled': the user just closed the dialog without picking — not an error.
  }, [setWorkspaceRootOverride]);

  useEffect(() => {
    setRootInput(workspaceRootOverride ?? '');
  }, [workspaceRootOverride]);

  if (status === 'idle') return null;

  const icon =
    status === 'ready' ? 'codicon-check' : status === 'error' ? 'codicon-warning' : 'codicon-sync';
  const label =
    status === 'ready'
      ? indexing
        ? 'LSP Indexing...'
        : `LSP${(activeLanguage ?? readyLanguage) ? ` (${activeLanguage ?? readyLanguage})` : ''}`
      : status === 'error'
        ? 'LSP Error'
        : status === 'fetching'
          ? fetchProgress?.total
            ? `Fetching ${Math.round((fetchProgress.downloaded / fetchProgress.total) * 100)}%`
            : 'Fetching...'
          : status === 'installing'
            ? `${installLanguage ?? 'LSP'} Installing...`
            : 'LSP Starting...';

  return (
    <div className="status-bar-item-wrapper">
      <button
        className={`status-bar-badge status-bar-badge-point-left${status === 'error' ? ' status-bar-badge-lsp-error' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((cur) => !cur);
        }}
      >
        <span className={`codicon ${icon}${(status !== 'ready' && status !== 'error') || indexing ? ' status-bar-lsp-spin' : ''}`} />
        {label}
      </button>
      {open && (
        <div className="status-bar-dropdown" onClick={(e) => e.stopPropagation()}>
          <div className="status-bar-dropdown-heading">Language Server</div>
          <div className="status-bar-dropdown-detail">Status: {status}</div>
          {serverVersion && <div className="status-bar-dropdown-detail">Version: {serverVersion}</div>}
          {rootUri && <div className="status-bar-dropdown-detail">root: {rootUri}</div>}
          {installMessage && <div className="status-bar-dropdown-detail">{installMessage}</div>}
          {indexing && (
            <div className="status-bar-dropdown-detail">
              Indexing{indexingLanguage ? ` (${indexingLanguage})` : ''}: {indexingMessage ?? 'Analyzing workspace...'}
              {indexingProgress !== null ? ` (${Math.round(indexingProgress)}%)` : ''}
            </div>
          )}
          {errorMessage && <div className="status-bar-dropdown-detail status-bar-dropdown-detail-error">{errorMessage}</div>}
          <div className="status-bar-dropdown-heading">Workspace Root</div>
          <div className="status-bar-dropdown-detail status-bar-lsp-root-hint">
            The browser cannot resolve folder paths. If the lsp-host-selected folder is not your project, specify the project root here.
          </div>
          <div className="status-bar-lsp-root-form">
            <button type="button" onClick={() => void handlePickFolder()} disabled={picking}>
              {picking ? 'Selecting...' : 'Choose Folder...'}
            </button>
          </div>
          {pickMessage && (
            <div className="status-bar-dropdown-detail status-bar-dropdown-detail-error">{pickMessage}</div>
          )}
          <form
            className="status-bar-lsp-root-form"
            onSubmit={(e) => {
              e.preventDefault();
              void setWorkspaceRootOverride(rootInput.trim() || null);
            }}
          >
            <input
              className="status-bar-lsp-root-input"
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="e.g. C:\Users\me\my-project"
            />
            <button type="submit">Apply</button>
          </form>
        </div>
      )}
    </div>
  );
}

function EncodingBadge({ tabId, encoding }: { tabId: string; encoding: TextEncodingId }) {
  const [open, setOpen] = useState(false);
  const setFileEncoding = useEditorTabsStore((s) => s.setFileEncoding);
  const closeMenu = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick(closeMenu, open);

  return (
    <div className="status-bar-item-wrapper">
      <button
        className="status-bar-badge status-bar-badge-point-left"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((cur) => !cur);
        }}
      >
        <span className="codicon codicon-globe" />
        {ENCODING_LABELS[encoding]}
      </button>
      {open && (
        <div className="status-bar-dropdown" onClick={(e) => e.stopPropagation()}>
          <div className="status-bar-dropdown-heading">エンコーディングを指定して開き直す</div>
          {ALL_ENCODINGS.map((id) => (
            <button
              key={`reopen-${id}`}
              className="menu-dropdown-item"
              onClick={() => {
                void setFileEncoding(tabId, id, 'reopen');
                setOpen(false);
              }}
            >
              <span className="menu-dropdown-item-check">{id === encoding ? '✓' : ''}</span>
              {ENCODING_LABELS[id]}
            </button>
          ))}
          <div className="status-bar-dropdown-heading">このエンコーディングで保存</div>
          {ALL_ENCODINGS.map((id) => (
            <button
              key={`resave-${id}`}
              className="menu-dropdown-item"
              onClick={() => {
                void setFileEncoding(tabId, id, 'resave');
                setOpen(false);
              }}
            >
              <span className="menu-dropdown-item-check">{id === encoding ? '✓' : ''}</span>
              {ENCODING_LABELS[id]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EolBadge({ tabId, eol }: { tabId: string; eol: 'LF' | 'CRLF' }) {
  const setFileEol = useEditorTabsStore((s) => s.setFileEol);
  return (
    <button
      className="status-bar-badge status-bar-badge-adjoined"
      title="クリックで改行コードを切り替え"
      onClick={() => setFileEol(tabId, eol === 'LF' ? 'CRLF' : 'LF')}
    >
      <span className="codicon codicon-newline" />
      {eol}
    </button>
  );
}

export function StatusBar() {
  const status = useWorkspaceStore((s) => s.status);
  const rootHandleName = useWorkspaceStore((s) => s.rootHandle?.name);
  const mode = useKeybindingStore((s) => s.mode);
  const vimSubMode = useKeybindingStore((s) => s.vimSubMode);
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const keybindingLabel = mode === 'vim' ? '[Vim]' : mode === 'emacs' ? '[Emacs]' : '[Default]';

  const keybindingStatusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setKeybindingStatusNode(keybindingStatusRef.current);
    return () => setKeybindingStatusNode(null);
  }, []);

  return (
    <footer className="status-bar" data-vim-mode={vimSubMode ?? undefined}>
      <div className="status-bar-left">
        <div
          className="status-bar-badge status-bar-badge-point-right status-bar-keybinding"
        >
          <span className="status-bar-keybinding-label">{keybindingLabel}</span>
          <div ref={keybindingStatusRef} className="status-bar-keybinding-node" />
        </div>
        <span className="status-bar-segment status-bar-segment-static">
          <span className="codicon codicon-folder" />
          {status === 'connected' ? rootHandleName || '(workspace)' : 'フォルダが開かれていません'}
        </span>
      </div>
      <div className="status-bar-right">
        <LspBadge activeLanguage={activeTab?.language ?? null} />
        {activeTab && <EncodingBadge tabId={activeTab.id} encoding={activeTab.encoding} />}
        {activeTab && <EolBadge tabId={activeTab.id} eol={activeTab.eol} />}
      </div>
    </footer>
  );
}
