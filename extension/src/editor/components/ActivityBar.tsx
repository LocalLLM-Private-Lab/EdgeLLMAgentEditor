import './ActivityBar.css';

export type SidebarView = 'explorer' | 'source-control' | 'extensions';

interface ActivityBarProps {
  /** null = sidebar closed. Otherwise which view is showing — drives which
   * icon renders as active, VS Code-style (the icons switch the sidebar's
   * content, they don't each own an independent visibility toggle). */
  activeView: SidebarView | null;
  onSelectView: (view: SidebarView) => void;
  onOpenSettings: () => void;
}

// VS Code's leftmost icon strip. Explorer (file tree) and Extensions share
// the same sidebar slot, switched by clicking either icon; Settings opens
// the same unified settings window as File > 設定..., pinned to the bottom
// via a flex spacer.
export function ActivityBar({ activeView, onSelectView, onOpenSettings }: ActivityBarProps) {
  return (
    <nav className="activity-bar">
      <button
        className={`activity-bar-button ${activeView === 'explorer' ? 'active' : ''}`}
        onClick={() => onSelectView('explorer')}
        title="エクスプローラー"
        aria-label="エクスプローラー"
        aria-pressed={activeView === 'explorer'}
      >
        📁
      </button>
      <button
        className={`activity-bar-button ${activeView === 'source-control' ? 'active' : ''}`}
        onClick={() => onSelectView('source-control')}
        title="ソース管理"
        aria-label="ソース管理"
        aria-pressed={activeView === 'source-control'}
      >
        ⎇
      </button>
      <button
        className={`activity-bar-button ${activeView === 'extensions' ? 'active' : ''}`}
        onClick={() => onSelectView('extensions')}
        title="拡張機能"
        aria-label="拡張機能"
        aria-pressed={activeView === 'extensions'}
      >
        🧩
      </button>
      <div className="activity-bar-spacer" />
      <button className="activity-bar-button" onClick={onOpenSettings} title="設定" aria-label="設定">
        ⚙
      </button>
    </nav>
  );
}
