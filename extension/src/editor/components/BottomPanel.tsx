import { TerminalPanel } from './TerminalPanel';
import { CopilotPanel } from './CopilotPanel';
import './BottomPanel.css';

export type BottomPanelTab = 'terminal' | 'copilot';

interface BottomPanelProps {
  activeTab: BottomPanelTab;
  onSelectTab: (tab: BottomPanelTab) => void;
  terminalEnabled: boolean;
  copilotEnabled: boolean;
  height: number;
}

// Both tabs stay mounted (toggled via CSS) rather than unmounted-on-switch
// so terminal sessions and pasted/typed state survive tab switches, even
// while a tab is disabled and hidden from the strip below.
export function BottomPanel({
  activeTab,
  onSelectTab,
  terminalEnabled,
  copilotEnabled,
  height,
}: BottomPanelProps) {
  return (
    <div className="bottom-panel" style={{ height }}>
      {terminalEnabled && copilotEnabled && (
        <div className="bottom-panel-tabs">
          <button
            className={activeTab === 'terminal' ? 'active' : ''}
            onClick={() => onSelectTab('terminal')}
          >
            ターミナル
          </button>
          <button
            className={activeTab === 'copilot' ? 'active' : ''}
            onClick={() => onSelectTab('copilot')}
          >
            Copilot
          </button>
        </div>
      )}
      <div className="bottom-panel-body">
        <div className="bottom-panel-tab-content" style={{ display: activeTab === 'terminal' ? 'block' : 'none' }}>
          <TerminalPanel />
        </div>
        <div className="bottom-panel-tab-content" style={{ display: activeTab === 'copilot' ? 'block' : 'none' }}>
          <CopilotPanel />
        </div>
      </div>
    </div>
  );
}
