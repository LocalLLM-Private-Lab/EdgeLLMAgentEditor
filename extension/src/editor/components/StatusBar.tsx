import { useWorkspaceStore } from '../state/workspaceStore';
import './StatusBar.css';

export function StatusBar() {
  const status = useWorkspaceStore((s) => s.status);
  const rootHandleName = useWorkspaceStore((s) => s.rootHandle?.name);

  return (
    <footer className="status-bar">
      <span className="status-bar-item">
        {status === 'connected' ? `📁 ${rootHandleName || '(workspace)'}` : 'フォルダが開かれていません'}
      </span>
    </footer>
  );
}
