import { useTerminalStore } from '../state/terminalStore';
import { base64ToBytes } from '../terminal/wsTerminalClient';

export interface RunAndCaptureResult {
  command: string;
  output: string;
  /** The process's real exit code, `0` for success. `null` means the run
   * never produced a normal exit — killed, crashed abnormally, the
   * session was closed mid-run, or terminal-host never connected in time
   * — callers should treat it as "unknown/cancelled", not silently as
   * success or as a specific failure code. */
  exitCode: number | null;
}

const CONNECT_TIMEOUT_MS = 8000;

/** Runs `command` in a brand-new, labeled terminal session (never reusing
 * whatever session is currently active — see terminalStore's
 * `pendingCaptureRun`) and resolves once that session exits, with its
 * accumulated stdout text and real exit code. The session itself is left
 * open afterward so the user can still scroll back through the real
 * terminal output, not just the captured string this returns. */
export async function runAndCapture(command: string, label: string): Promise<RunAndCaptureResult> {
  const store = useTerminalStore.getState();
  if (store.connectionState !== 'connected') {
    await Promise.race([
      store.ensureConnected(),
      new Promise((resolve) => setTimeout(resolve, CONNECT_TIMEOUT_MS)),
    ]);
    if (useTerminalStore.getState().connectionState !== 'connected') {
      return { command, output: '', exitCode: null };
    }
  }

  return new Promise((resolve) => {
    let sessionId: string | null = null;
    // A single decoder instance across the whole run, with `stream: true`
    // per chunk and a final flush on exit — stdout arrives as discrete
    // base64 chunks over the WebSocket, and decoding each chunk in
    // isolation would corrupt any multi-byte UTF-8 character (e.g.
    // Japanese error text) that happens to fall across a chunk boundary.
    const decoder = new TextDecoder();
    let output = '';

    const unsubscribe = useTerminalStore.getState().subscribe((msg) => {
      if (!sessionId || msg.session_id !== sessionId) return;
      if (msg.type === 'stdout') {
        output += decoder.decode(base64ToBytes(msg.data), { stream: true });
      } else if (msg.type === 'exited') {
        output += decoder.decode();
        unsubscribe();
        resolve({ command, output, exitCode: msg.exit_code });
      }
    });

    // A capture session's shell (PowerShell — terminal-host's default on
    // Windows) stays interactive after running one command, so it never
    // exits on its own and `Exited` would never fire. Forcing it to exit
    // with the command's own exit code both ends the session and is what
    // actually makes `Exited{exit_code}` carry a real, meaningful value.
    useTerminalStore.getState().queueCaptureRun(`${command}; exit $LASTEXITCODE`, label, (id) => {
      sessionId = id;
    });
  });
}
