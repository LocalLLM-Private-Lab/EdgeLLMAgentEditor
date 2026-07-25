interface ToolRunConfirmationProps {
  path: string;
  command: string;
  running: boolean;
  onConfirm: () => void;
  onReject: () => void;
}

/** Shared by CopilotPanel/PlanPanel/PlanStepCard — Copilot requested
 * `TOOL_RUN: <path>` and it resolved to a real command (via the user's own
 * runCommandStore mapping, never a command Copilot supplied directly).
 * Unlike TOOL_GREP/TOOL_LIST_FILES (read-only, auto-run), this always has
 * a real side effect, so it never executes without this explicit click. */
export function ToolRunConfirmation({ path, command, running, onConfirm, onReject }: ToolRunConfirmationProps) {
  return (
    <div className="copilot-tool-run-confirm">
      <div className="copilot-hint">
        Copilotが <code>{path}</code> の実行を要求しています(コマンド: <code>{command}</code>)
      </div>
      <div className="copilot-actions">
        <button className="primary" disabled={running} onClick={onConfirm}>
          {running ? '実行中...' : '実行'}
        </button>
        <button disabled={running} onClick={onReject}>
          拒否
        </button>
      </div>
    </div>
  );
}
