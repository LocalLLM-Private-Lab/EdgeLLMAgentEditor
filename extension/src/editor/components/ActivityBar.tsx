import './ActivityBar.css';

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

// VS Code's leftmost icon strip. Only the two items actually needed so far:
// Explorer (toggles the file tree sidebar) pinned to the top, Settings
// (opens the same unified settings window as File > 設定...) pinned to the
// bottom via a flex spacer in between.
export function ActivityBar({ sidebarVisible, onToggleSidebar, onOpenSettings }: ActivityBarProps) {
  return (
    <nav className="activity-bar">
      <button
        className={`activity-bar-button ${sidebarVisible ? 'active' : ''}`}
        onClick={onToggleSidebar}
        title="エクスプローラー"
        aria-label="エクスプローラー"
        aria-pressed={sidebarVisible}
      >
        📁
      </button>
      <div className="activity-bar-spacer" />
      <button className="activity-bar-button" onClick={onOpenSettings} title="設定" aria-label="設定">
        ⚙
      </button>
    </nav>
  );
}
