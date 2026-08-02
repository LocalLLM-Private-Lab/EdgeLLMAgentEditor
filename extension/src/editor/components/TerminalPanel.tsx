import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { v4 as uuid } from 'uuid';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';
import { useTerminalStore } from '../state/terminalStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { base64ToBytes, bytesToBase64 } from '../terminal/wsTerminalClient';
import type { ServerMessage } from '../terminal/terminalProtocol';
import { DEFAULT_TERMINAL_HOST_PORT } from '../../shared/constants';
import { launchTerminalHostViaNativeMessaging } from '../terminal/nativeLaunch';

interface Session {
  id: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
}

// xterm's FitAddon can measure a container mid-layout (e.g. right as the
// panel first becomes visible) and hand back 0 or NaN. Sending that as a
// PTY size is untested territory server-side, so clamp to a sane floor
// before it ever goes over the wire (terminal-host clamps too, as
// defense-in-depth against any other future caller).
function safeTerminalDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function TerminalPanel({ backgroundCaptureOnly = false }: { backgroundCaptureOnly?: boolean } = {}) {
  const panelClassName = `terminal-panel${backgroundCaptureOnly ? ' terminal-panel-background' : ''}`;
  const settings = useTerminalStore((s) => s.settings);
  const connectionState = useTerminalStore((s) => s.connectionState);
  const saveSettings = useTerminalStore((s) => s.saveSettings);
  const connect = useTerminalStore((s) => s.connect);
  const send = useTerminalStore((s) => s.send);
  const subscribe = useTerminalStore((s) => s.subscribe);

  const pendingRunRequest = useTerminalStore((s) => s.pendingRunRequest);
  const consumePendingRunRequest = useTerminalStore((s) => s.consumePendingRunRequest);
  const pendingCaptureRun = useTerminalStore((s) => s.pendingCaptureRun);
  const consumePendingCaptureRun = useTerminalStore((s) => s.consumePendingCaptureRun);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<Map<string, Session>>(new Map());
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Kept separate from sessionsRef (a plain ref, only used for DOM/xterm
  // plumbing) since the tab strip needs a reactive value to actually
  // re-render when a Copilot-triggered run's session gets a distinct label
  // instead of the generic "ターミナル".
  const [sessionLabels, setSessionLabels] = useState<Record<string, string>>({});

  const [portInput, setPortInput] = useState(String(DEFAULT_TERMINAL_HOST_PORT));
  const [tokenInput, setTokenInput] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  // App.tsx already tries this once automatically on startup
  // (ensureConnected) — this is the manual retry for when that didn't
  // pan out (host not registered yet, was closed since, etc.). Saves the
  // fresh port/token itself and connects immediately rather than just
  // hoping wsTerminalClient's own reconnect loop happens to pick it up.
  async function handleLaunchHost() {
    setLaunchMessage('起動しています...');
    const result = await launchTerminalHostViaNativeMessaging();
    if (result.status === 'started' || result.status === 'already_running') {
      await saveSettings({ port: result.port, token: result.token });
      connect();
      setLaunchMessage(
        result.status === 'started' ? '起動しました。接続しています...' : '既に起動しています。接続しています...',
      );
    } else if (result.status === 'unavailable') {
      // result.message is chrome.runtime.lastError.message — the browser's
      // own reason (host manifest not found, path in the manifest doesn't
      // resolve, extension id not in allowed_origins, ...). Previously
      // discarded in favor of a single generic message, which told users
      // to re-run setup.js even when they already had — hiding exactly the
      // detail needed to tell "never registered" apart from "registered
      // but broken somehow".
      setLaunchMessage(
        `未登録または起動できません: ${result.message || '(詳細不明)'} — 解決しない場合は "node setup/setup.js" を再実行してください。`,
      );
    } else if (result.status === 'timeout') {
      setLaunchMessage(
        '応答がありません。Edgeを完全に再起動(全ウィンドウを閉じる)してから再度お試しください。',
      );
    } else {
      setLaunchMessage(`起動に失敗しました: ${result.message}`);
    }
  }

  // Route incoming server messages to the matching session's xterm instance.
  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === 'stdout') {
        const session = sessionsRef.current.get(msg.session_id);
        session?.term.write(base64ToBytes(msg.data));
      } else if (msg.type === 'exited') {
        const session = sessionsRef.current.get(msg.session_id);
        session?.term.write(`\r\n\x1b[90m[プロセス終了]\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        // eslint-disable-next-line no-console
        console.error('terminal-host error:', msg.message);
        // Previously this only reached devtools console — a session that
        // failed to spawn (e.g. no shell found, ConPTY unavailable) left
        // behind a blank terminal tab with no visible explanation at all.
        // Write it directly into the session's own xterm, since that's the
        // one place the user is already looking when a new terminal "does
        // nothing".
        const session = msg.session_id ? sessionsRef.current.get(msg.session_id) : undefined;
        session?.term.write(`\r\n\x1b[91m[エラー] ターミナルを起動できませんでした: ${msg.message}\x1b[0m\r\n`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  // Sends workspaceRealPath as cwd when known (see below); otherwise cwd
  // is omitted and terminal-host falls back to its own launch directory
  // (see terminal-host/src/pty_session.rs's default_cwd()).
  function openSession(label?: string, sessionCwd?: string): string {
    const id = uuid();
    if (label) setSessionLabels((prev) => ({ ...prev, [id]: label }));
    if (!hostRef.current) return id;
    const container = document.createElement('div');
    container.className = 'terminal-session-container';
    hostRef.current.appendChild(container);

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: '#0c0c0c' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    async function pasteFromClipboard() {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      send({ type: 'stdin', session_id: id, data: bytesToBase64(new TextEncoder().encode(text)) });
    }

    // VS Code's own terminal default on Windows: Ctrl+C copies the current
    // selection if there is one, otherwise it falls through to xterm's
    // normal behavior (sends \x03 / SIGINT to the PTY). Ctrl+V has no
    // default xterm binding at all, so it's added outright.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrlOrCmd = e.ctrlKey || e.metaKey;
      if (ctrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (ctrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'v') {
        void pasteFromClipboard();
        return false;
      }
      return true;
    });

    // Right-click with nothing selected pastes; with a selection present,
    // it copies instead (matches Windows Terminal/most terminal emulators'
    // default). The browser's native menu is never shown here — always
    // preventDefault, since this app supplies its own actions everywhere.
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
      } else {
        void pasteFromClipboard();
      }
    });

    term.onData((data) => {
      send({
        type: 'stdin',
        session_id: id,
        data: bytesToBase64(new TextEncoder().encode(data)),
      });
    });

    sessionsRef.current.set(id, { id, container, term, fit });
    send({
      type: 'open_session',
      session_id: id,
      cols: safeTerminalDimension(term.cols, 80),
      rows: safeTerminalDimension(term.rows, 24),
      shell: undefined,
      // Real OS path of the open workspace, if known (see
      // workspaceRealPath.ts) — lets a new session start there directly
      // instead of wherever terminal-host itself happens to be running
      // from. undefined (not sent) when unknown, so terminal-host falls
      // back to its own launch directory as before.
      cwd: sessionCwd ?? useWorkspaceStore.getState().workspaceRealPath ?? undefined,
    });

    setSessionIds((prev) => [...prev, id]);
    setActiveSessionId(id);
    term.focus();
    return id;
  }

  // Consumes a command queued by the header's Run button (App.tsx). Runs
  // it in the active session, opening one first if none exists yet.
  useEffect(() => {
    if (backgroundCaptureOnly || !pendingRunRequest || connectionState !== 'connected') return;
    const cmd = consumePendingRunRequest();
    if (!cmd) return;
    const sessionId = activeSessionId ?? openSession();
    send({
      type: 'stdin',
      session_id: sessionId,
      data: bytesToBase64(new TextEncoder().encode(cmd + '\r')),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundCaptureOnly, pendingRunRequest, connectionState]);

  // Same one-shot pattern as pendingRunRequest, but for a Copilot-driven
  // "run and capture the output" request (copilot/runAndCapture.ts) —
  // always opens a *new* session rather than reusing whichever one is
  // active, so the caller can correlate this run's stdout/exit code via a
  // session id nothing else is typing into.
  useEffect(() => {
    if (
      !pendingCaptureRun ||
      connectionState !== 'connected' ||
      Boolean(pendingCaptureRun.background) !== backgroundCaptureOnly
    ) return;
    const req = consumePendingCaptureRun();
    if (!req) return;
    const sessionId = openSession(req.label, req.cwd);
    req.onSessionOpened(sessionId);
    send({
      type: 'stdin',
      session_id: sessionId,
      data: bytesToBase64(new TextEncoder().encode(req.command + '\r')),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundCaptureOnly, pendingCaptureRun, connectionState]);

  useEffect(() => {
    if (connectionState === 'connected') setLaunchMessage(null);
  }, [connectionState]);

  function closeSession(id: string) {
    send({ type: 'close', session_id: id });
    const session = sessionsRef.current.get(id);
    session?.term.dispose();
    session?.container.remove();
    sessionsRef.current.delete(id);
    setSessionIds((prev) => prev.filter((s) => s !== id));
    setActiveSessionId((prev) => (prev === id ? (sessionIds.find((s) => s !== id) ?? null) : prev));
    setSessionLabels((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // Show only the active session's container; fit it so PTY size matches.
  useEffect(() => {
    for (const [id, session] of sessionsRef.current) {
      session.container.style.display = id === activeSessionId ? 'block' : 'none';
    }
    if (activeSessionId) {
      const session = sessionsRef.current.get(activeSessionId);
      if (session) {
        session.fit.fit();
        session.term.focus();
        send({
          type: 'resize',
          session_id: activeSessionId,
          cols: safeTerminalDimension(session.term.cols, 80),
          rows: safeTerminalDimension(session.term.rows, 24),
        });
      }
    }
  }, [activeSessionId, send]);

  // Alternative to typing directly into the xterm view — useful for
  // pasting/sending a command without needing to click-focus the terminal
  // first (e.g. right after switching tabs or panels).
  function sendCommandFromInput() {
    if (!activeSessionId || !commandInput) return;
    send({
      type: 'stdin',
      session_id: activeSessionId,
      data: bytesToBase64(new TextEncoder().encode(commandInput + '\r')),
    });
    setCommandInput('');
    sessionsRef.current.get(activeSessionId)?.term.focus();
  }

  if (!settings) {
    return (
      <div className={panelClassName}>
        <div className="terminal-settings-form">
          <p>通常は拡張機能の起動時に自動でterminal-hostが立ち上がって接続します。まだの場合はこちらから起動できます。</p>
          <button onClick={() => void handleLaunchHost()}>ターミナルホストを起動</button>
          {launchMessage && <span className="terminal-launch-message">{launchMessage}</span>}
          <p className="terminal-settings-fallback-hint">
            自動起動が使えない場合("node setup/setup.js"
            未実行など): terminal-host (Rust) をプロジェクトフォルダ内から手動で起動し、表示されたポートとトークンを入力してください。
          </p>
          <label>
            ポート
            <input value={portInput} onChange={(e) => setPortInput(e.target.value)} />
          </label>
          <label>
            トークン
            <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
          </label>
          <button
            onClick={() =>
              void saveSettings({ port: Number(portInput) || DEFAULT_TERMINAL_HOST_PORT, token: tokenInput })
            }
          >
            保存して接続
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={panelClassName}>
      <div className="terminal-panel-toolbar">
        <span className={`terminal-status terminal-status-${connectionState}`}>
          {connectionState}
        </span>
        {connectionState !== 'connected' && (
          <>
            <button onClick={() => void handleLaunchHost()}>ターミナルホストを起動</button>
            {launchMessage && <span className="terminal-launch-message">{launchMessage}</span>}
          </>
        )}
        {sessionIds.map((id) => (
          <div
            key={id}
            className={`terminal-session-tab ${id === activeSessionId ? 'active' : ''}`}
            onClick={() => setActiveSessionId(id)}
          >
            {sessionLabels[id] ?? 'ターミナル'}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeSession(id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button onClick={() => openSession()}>+ 新規</button>
      </div>
      <div ref={hostRef} className="terminal-session-host" />
      <form
        className="terminal-command-form"
        onSubmit={(e) => {
          e.preventDefault();
          sendCommandFromInput();
        }}
      >
        <input
          className="terminal-command-input"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder={
            activeSessionId ? 'コマンドを入力してEnter(ターミナルに直接入力も可能)' : 'ターミナルを新規作成してください'
          }
          disabled={!activeSessionId}
        />
        <button type="submit" disabled={!activeSessionId || !commandInput}>
          送信
        </button>
      </form>
    </div>
  );
}
