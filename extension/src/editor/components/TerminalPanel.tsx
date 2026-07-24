import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { v4 as uuid } from 'uuid';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';
import { useTerminalStore } from '../state/terminalStore';
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

export function TerminalPanel() {
  const settings = useTerminalStore((s) => s.settings);
  const connectionState = useTerminalStore((s) => s.connectionState);
  const saveSettings = useTerminalStore((s) => s.saveSettings);
  const send = useTerminalStore((s) => s.send);
  const subscribe = useTerminalStore((s) => s.subscribe);

  const pendingRunRequest = useTerminalStore((s) => s.pendingRunRequest);
  const consumePendingRunRequest = useTerminalStore((s) => s.consumePendingRunRequest);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<Map<string, Session>>(new Map());
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [portInput, setPortInput] = useState(String(DEFAULT_TERMINAL_HOST_PORT));
  const [tokenInput, setTokenInput] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  // The existing auto-reconnect loop in wsTerminalClient.ts retries every
  // 2s regardless — this just gives the browser-launched terminal-host a
  // moment to come up, and it gets picked up on the next retry with no
  // extra wiring needed here.
  async function handleLaunchHost() {
    setLaunchMessage('起動しています...');
    const result = await launchTerminalHostViaNativeMessaging();
    if (result.status === 'started') {
      setLaunchMessage('起動しました。接続を待っています...');
    } else if (result.status === 'already_running') {
      setLaunchMessage('既に起動しています。接続を待っています...');
    } else if (result.status === 'unavailable') {
      setLaunchMessage(
        '未登録です。terminal-host/install-native-messaging-host.bat を一度実行してください。',
      );
    } else if (result.status === 'timeout') {
      setLaunchMessage(
        '応答がありません。Edgeを完全に再起動(全ウィンドウを閉じる)してから再度お試しください。',
      );
    } else {
      setLaunchMessage(`起動に失敗しました: ${result.message}`);
    }
  }

  // loadSettings()/connect() run once at the App level (App.tsx) so the
  // terminal host is already connected by the time this panel is opened.

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
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  // No cwd is ever sent — terminal-host opens new sessions in its own
  // launch directory by default (see terminal-host/src/pty_session.rs).
  // Run it from inside your project folder and it just works there, with
  // no folder picker or path entry needed on this side.
  function openSession(): string {
    const id = uuid();
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
    });

    setSessionIds((prev) => [...prev, id]);
    setActiveSessionId(id);
    term.focus();
    return id;
  }

  // Consumes a command queued by the header's Run button (App.tsx). Runs
  // it in the active session, opening one first if none exists yet.
  useEffect(() => {
    if (!pendingRunRequest || connectionState !== 'connected') return;
    const cmd = consumePendingRunRequest();
    if (!cmd) return;
    const sessionId = activeSessionId ?? openSession();
    send({
      type: 'stdin',
      session_id: sessionId,
      data: bytesToBase64(new TextEncoder().encode(cmd + '\r')),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRunRequest, connectionState]);

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
      <div className="terminal-panel">
        <div className="terminal-settings-form">
          <p>
            terminal-host (Rust) をプロジェクトフォルダ内から起動し、表示されたポートとトークンを入力してください。
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
    <div className="terminal-panel">
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
            ターミナル
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
