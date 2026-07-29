import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import './WorkspacePathBanner.css';

/** Shown right under the menu bar whenever a workspace is open but its real
 * OS path is still unknown (see workspaceStore.ts's workspaceRealPath) —
 * until it's registered, new terminals and language servers default to
 * their own launch directory instead of the project actually open here.
 * Not terminal- or LSP-specific, so it lives at the app level rather than
 * inside either panel. The same registration is also reachable from the
 * command palette / AppCommandBar (both funnel into the same
 * WorkspaceRealPathModal via `onOpenModal`). Dismissible with its own ×
 * (just a "not now" for this workspace-open session — deliberately not
 * persisted, since silently suppressing the reminder forever would defeat
 * its purpose; it reappears on next reopen and resets whenever a
 * *different* folder is opened). */
export function WorkspacePathBanner({ onOpenModal }: { onOpenModal: () => void }) {
  const status = useWorkspaceStore((s) => s.status);
  const workspaceRealPath = useWorkspaceStore((s) => s.workspaceRealPath);
  const rootHandle = useWorkspaceStore((s) => s.rootHandle);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [rootHandle]);

  if (status !== 'connected' || workspaceRealPath || dismissed) return null;

  return (
    <div className="workspace-path-banner">
      このフォルダの実際のパスを登録すると、ターミナルとLSPがここで起動するようになります。
      <button onClick={onOpenModal}>実パスを登録...</button>
      <button className="workspace-path-banner-dismiss" onClick={() => setDismissed(true)} title="閉じる">
        ✕
      </button>
    </div>
  );
}
