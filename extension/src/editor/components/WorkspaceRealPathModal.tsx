import { useState } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import './WorkspaceRealPathModal.css';

/** The sub-window opened from WorkspacePathBanner's ribbon or the command
 * palette (QuickOpenModal's `>` mode). File System Access API has no way to
 * expose a handle's real OS path (deliberate browser restriction — see
 * docs/protocol.md), so the user types/pastes it here; it's then written
 * into *this* open workspace's own .m365ce/config via
 * workspaceStore.ts's setWorkspaceRealPath, never a separately-picked
 * folder that could drift from what's actually open. */
export function WorkspaceRealPathModal({ onClose }: { onClose: () => void }) {
  const workspaceRealPath = useWorkspaceStore((s) => s.workspaceRealPath);
  const setWorkspaceRealPath = useWorkspaceStore((s) => s.setWorkspaceRealPath);
  const [value, setValue] = useState(workspaceRealPath ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await setWorkspaceRealPath(value);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="workspace-path-modal-overlay" onClick={onClose}>
      <div className="workspace-path-modal" onClick={(e) => e.stopPropagation()}>
        <h2>ワークスペースの実パスを登録</h2>
        <p>
          ブラウザはこのフォルダの実OS上の絶対パスを知る手段を持っていません。ターミナルとLSPをこのフォルダで起動できるように、実際の絶対パスを一度だけ入力してください(次回このフォルダを開いたときは自動的に読み込まれます)。
        </p>
        <input
          autoFocus
          className="workspace-path-modal-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例: C:\Users\me\my-project"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
            else if (e.key === 'Escape') onClose();
          }}
        />
        <div className="workspace-path-modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button onClick={() => void handleSave()} disabled={saving || !value.trim()}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
