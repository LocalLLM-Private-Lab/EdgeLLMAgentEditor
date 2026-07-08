import { useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useRunCommandStore, type RunCommandMap } from '../state/runCommandStore';
import '../components/DiffViewModal.css';
import './RunCommandSettingsModal.css';

interface Row {
  id: string;
  ext: string;
  command: string;
}

export function RunCommandSettingsModal({ onClose }: { onClose: () => void }) {
  const commands = useRunCommandStore((s) => s.commands);
  const saveCommands = useRunCommandStore((s) => s.saveCommands);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const initial = Object.entries(commands).map(([ext, command]) => ({ id: uuid(), ext, command }));
    setRows(initial.length > 0 ? initial : [{ id: uuid(), ext: '', command: '' }]);
  }, [commands]);

  function addRow() {
    setRows((prev) => [...prev, { id: uuid(), ext: '', command: '' }]);
  }
  function updateRow(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleSave() {
    const map: RunCommandMap = {};
    for (const row of rows) {
      const ext = row.ext.trim().replace(/^\./, '').toLowerCase();
      if (ext && row.command.trim()) map[ext] = row.command.trim();
    }
    await saveCommands(map);
    onClose();
  }

  return (
    <div className="diff-modal-overlay">
      <div className="run-settings-modal">
        <div className="diff-modal-header">
          <span>拡張子ごとの実行コマンド設定</span>
          <div className="diff-modal-actions">
            <button onClick={() => void handleSave()}>保存</button>
            <button onClick={onClose}>キャンセル</button>
          </div>
        </div>
        <div className="run-settings-body">
          <p className="run-settings-hint">
            {'{file}'} は開いているファイルの、ワークスペースルートからの相対パスに置き換わります(terminal-hostの起動ディレクトリ=ワークスペースルートである前提)。
            例: 拡張子「py」/ コマンド「python {'{file}'}」。
            未設定の拡張子は実行ボタンが表示されません(デフォルトは実行なし)。
          </p>
          {rows.map((row) => (
            <div key={row.id} className="run-settings-row">
              <input
                className="run-settings-ext-input"
                placeholder="拡張子 (例: py)"
                value={row.ext}
                onChange={(e) => updateRow(row.id, { ext: e.target.value })}
              />
              <input
                className="run-settings-command-input"
                placeholder="コマンド (例: python {file})"
                value={row.command}
                onChange={(e) => updateRow(row.id, { command: e.target.value })}
              />
              <button onClick={() => removeRow(row.id)}>削除</button>
            </div>
          ))}
          <button onClick={addRow}>+ 追加</button>
        </div>
      </div>
    </div>
  );
}
