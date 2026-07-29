import './BuildConsolePanel.css';

// Placeholder — the ビルド/実行 menu (App.tsx) and this panel are both
// scaffolding only for now; wiring an actual build runner into them is
// deliberately left to whoever implements that feature next. Kept as its
// own dock panel (same pattern as TerminalPanel/CopilotPanel) so that
// wiring only needs to fill this component in, not build the panel
// registration/toggle plumbing from scratch.
export function BuildConsolePanel() {
  return (
    <div className="build-console-panel">
      <div className="build-console-empty">まだビルドは実行されていません。</div>
    </div>
  );
}
