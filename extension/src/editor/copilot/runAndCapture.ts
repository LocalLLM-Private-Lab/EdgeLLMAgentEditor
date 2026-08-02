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

export interface RunAndCaptureOptions {
  /** Close the temporary terminal session as soon as the command exits. */
  background?: boolean;
  /** Working directory for the temporary terminal session. */
  cwd?: string;
  /** Receives the captured output while the command is still running. */
  onOutput?: (output: string) => void;
}

const CONNECT_TIMEOUT_MS = 8000;

/* eslint-disable no-control-regex */
function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1B\](?:[^\x07]|\x07(?!\n))*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B(?:[@-Z\\-_])/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
/* eslint-enable no-control-regex */

function outputAfterCaptureMarker(output: string, marker: string): string {
  const markerIndex = output.lastIndexOf(marker);
  return markerIndex >= 0 ? output.slice(markerIndex + marker.length).replace(/^\r?\n/, '') : '';
}

/** Runs `command` in a brand-new, labeled terminal session (never reusing
 * whatever session is currently active — see terminalStore's
 * `pendingCaptureRun`) and resolves once that session exits, with its
 * accumulated stdout text and real exit code. The session itself is left
 * open afterward so the user can still scroll back through the real
 * terminal output, not just the captured string this returns. */
export async function runAndCapture(
  command: string,
  label: string,
  options: RunAndCaptureOptions = {},
): Promise<RunAndCaptureResult> {
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
    const captureMarker = `__M365CE_CAPTURE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    // A single decoder instance across the whole run, with `stream: true`
    // per chunk and a final flush on exit — stdout arrives as discrete
    // base64 chunks over the WebSocket, and decoding each chunk in
    // isolation would corrupt any multi-byte UTF-8 character (e.g.
    // Japanese error text) that happens to fall across a chunk boundary.
    const decoder = new TextDecoder();
    let output = '';

    const unsubscribe = useTerminalStore.getState().subscribe((msg) => {
      if (!sessionId || !('session_id' in msg) || msg.session_id !== sessionId) return;
      if (msg.type === 'stdout') {
        output += decoder.decode(base64ToBytes(msg.data), { stream: true });
        if (options.onOutput) {
          options.onOutput(stripTerminalControlSequences(outputAfterCaptureMarker(output, captureMarker)));
        }
      } else if (msg.type === 'exited') {
        output += decoder.decode();
        unsubscribe();
        if (options.background) {
          useTerminalStore.getState().send({ type: 'close', session_id: sessionId });
        }
        const capturedOutput = outputAfterCaptureMarker(output, captureMarker) || output;
        options.onOutput?.(stripTerminalControlSequences(capturedOutput));
        resolve({ command, output: stripTerminalControlSequences(capturedOutput), exitCode: msg.exit_code });
      }
    });

    // A capture session's shell (PowerShell — terminal-host's default on
    // Windows) stays interactive after running one command, so it never
    // exits on its own and `Exited` would never fire. Forcing it to exit
    // with the command's own exit code both ends the session and is what
    // actually makes `Exited{exit_code}` carry a real, meaningful value.
    // Windows PowerShell/native commands can otherwise emit using the active
    // OEM code page (often CP932), while the browser decodes PTY chunks as
    // UTF-8. Set both PowerShell and .NET output encodings before Git/SVN or
    // Copilot commands run so Japanese paths, commit messages, and diffs are
    // captured without mojibake. Non-Windows shells keep the original command
    // unchanged.
    const isWindows = /Windows/i.test(navigator.userAgent);
    const commandToRun = isWindows
      ? `$__m365ce_capture_marker='${captureMarker}'; Write-Output $__m365ce_capture_marker; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}; exit $LASTEXITCODE`
      : `printf '%s\\n' '${captureMarker}'; ${command}; exit $?`;
    useTerminalStore.getState().queueCaptureRun(
      commandToRun,
      label,
      (id) => {
        sessionId = id;
      },
      options.background,
      options.cwd,
    );
  });
}
