import { useEffect, useState } from 'react';
import { useExtensionsStore } from '../state/extensionsStore';
import { pickAndInstallExtension } from '../extensions/vsixInstall';
import './ExtensionsPanel.css';

/** VS Code Marketplace-style split: this is just the compact list (icon +
 * name + one-line description + publisher, click to select) — everything
 * else (actions, status, README) lives in ExtensionDetailView.tsx, shown
 * in the main content area (App.tsx) for whichever extension is selected. */
export function ExtensionsPanel() {
  const loaded = useExtensionsStore((s) => s.loaded);
  const loadExtensions = useExtensionsStore((s) => s.loadExtensions);
  const extensions = useExtensionsStore((s) => s.extensions);
  const status = useExtensionsStore((s) => s.status);
  const loadConfigValues = useExtensionsStore((s) => s.loadConfigValues);
  const viewingExtensionId = useExtensionsStore((s) => s.viewingExtensionId);
  const viewExtension = useExtensionsStore((s) => s.viewExtension);

  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    void loadExtensions();
    void loadConfigValues();
  }, [loadExtensions, loadConfigValues]);

  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      const entry = await pickAndInstallExtension();
      viewExtension(entry.id);
    } catch (err) {
      // A cancelled file picker also lands here (AbortError) — don't show
      // that as an error, it's just the user backing out.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setInstallError(String(err instanceof Error ? err.message : err));
    } finally {
      setInstalling(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="extensions-panel">
      <div className="extensions-panel-header">拡張機能</div>
      <div className="extensions-hint">
        VS Code拡張機能形式(.vsix、または同じ形のpackage.jsonを含むzip)をインストールできます。
      </div>
      <div className="extensions-actions">
        <button className="primary" disabled={installing} onClick={() => void handleInstall()}>
          {installing ? 'インストール中...' : '+ VSIXからインストール'}
        </button>
      </div>
      {installError && <div className="extensions-status error">{installError}</div>}

      {extensions.length === 0 ? (
        <div className="extensions-hint">インストール済みの拡張機能はありません。</div>
      ) : (
        <div className="extensions-list">
          {extensions.map((ext) => {
            const extStatus = status[ext.id]?.kind ?? 'inactive';
            return (
              <button
                key={ext.id}
                className={`extension-row ${ext.id === viewingExtensionId ? 'active' : ''}`}
                onClick={() => viewExtension(ext.id)}
              >
                {ext.iconDataUrl ? (
                  <img className="extension-row-icon" src={ext.iconDataUrl} alt="" />
                ) : (
                  <span className="extension-row-icon extension-row-icon-fallback">🧩</span>
                )}
                <span className="extension-row-text">
                  <span className="extension-row-name">
                    {ext.displayName}
                    {extStatus === 'active' && <span className="extension-row-dot active" title="有効化中" />}
                    {extStatus === 'error' && <span className="extension-row-dot error" title="エラー" />}
                  </span>
                  {ext.description && <span className="extension-row-description">{ext.description}</span>}
                  {ext.publisher && <span className="extension-row-publisher">{ext.publisher}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
