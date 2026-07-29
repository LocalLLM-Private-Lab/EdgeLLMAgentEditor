import { useState } from 'react';
import { useExtensionsStore, type ExtensionActivationStatus } from '../state/extensionsStore';
import type { CommandContribution, ViewContainerContribution, ViewContribution } from '../extensions/vsixInstall';
import { activateExtension, deactivateExtension } from '../extensions/extensionHostClient';
import { uninstallExtension } from '../extensions/vsixInstall';
import { MarkdownContent } from './MarkdownContent';
import './ExtensionsPanel.css';
import './ExtensionDetailView.css';

type DetailTab = 'details' | 'features';
type FeatureSectionId = 'runtimeStatus' | 'activationEvents' | 'commands' | 'settings' | 'viewContainers' | 'views';

const FEATURE_SECTIONS: { id: FeatureSectionId; label: string }[] = [
  { id: 'runtimeStatus', label: 'Runtime Status' },
  { id: 'activationEvents', label: 'Activation Events' },
  { id: 'commands', label: 'Commands' },
  { id: 'settings', label: 'Settings' },
  { id: 'viewContainers', label: 'View Containers' },
  { id: 'views', label: 'Views' },
];

function RuntimeStatusSection({ extStatus }: { extStatus: ExtensionActivationStatus }) {
  const label =
    extStatus.kind === 'active'
      ? '有効(アクティブ)'
      : extStatus.kind === 'activating'
        ? '起動中...'
        : extStatus.kind === 'error'
          ? 'エラー'
          : '無効(非アクティブ)';
  return (
    <div className="extension-feature-runtime-status">
      <div className="extension-feature-kv">
        <span className="extension-feature-kv-key">状態</span>
        <span>{label}</span>
      </div>
      {extStatus.kind === 'active' && (
        <div className="extension-feature-kv">
          <span className="extension-feature-kv-key">実際に登録されたコマンド</span>
          <span>{extStatus.commands.length > 0 ? extStatus.commands.join(', ') : '(なし)'}</span>
        </div>
      )}
      {extStatus.kind === 'error' && (
        <div className="extension-feature-kv">
          <span className="extension-feature-kv-key">エラー内容</span>
          <span>{extStatus.message}</span>
        </div>
      )}
    </div>
  );
}

function ActivationEventsSection({ events }: { events: string[] }) {
  if (events.length === 0) return <p className="extensions-hint">宣言されたactivationEventsはありません。</p>;
  return (
    <ul className="extension-feature-list">
      {events.map((event) => (
        <li key={event}>
          <code>{event}</code>
        </li>
      ))}
    </ul>
  );
}

function CommandsSection({ commands }: { commands: CommandContribution[] }) {
  if (commands.length === 0) return <p className="extensions-hint">宣言されたコマンドはありません。</p>;
  return (
    <table className="extension-feature-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>タイトル</th>
          <th>カテゴリ</th>
        </tr>
      </thead>
      <tbody>
        {commands.map((cmd) => (
          <tr key={cmd.command}>
            <td>
              <code>{cmd.command}</code>
            </td>
            <td>{cmd.title}</td>
            <td>{cmd.category ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsSection({ configSchema }: { configSchema: { key: string; type?: string | string[]; default?: unknown; description?: string; markdownDescription?: string }[] }) {
  if (configSchema.length === 0) return <p className="extensions-hint">宣言された設定はありません。</p>;
  return (
    <table className="extension-feature-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>型</th>
          <th>既定値</th>
          <th>説明</th>
        </tr>
      </thead>
      <tbody>
        {configSchema.map((prop) => (
          <tr key={prop.key}>
            <td>
              <code>{prop.key}</code>
            </td>
            <td>{Array.isArray(prop.type) ? prop.type.join(' | ') : (prop.type ?? '')}</td>
            <td>{prop.default !== undefined ? JSON.stringify(prop.default) : ''}</td>
            <td>{prop.description ?? prop.markdownDescription ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ViewContainersSection({ containers }: { containers: ViewContainerContribution[] }) {
  if (containers.length === 0) return <p className="extensions-hint">宣言されたView Containerはありません。</p>;
  return (
    <table className="extension-feature-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>タイトル</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c) => (
          <tr key={c.id}>
            <td>
              <code>{c.id}</code>
            </td>
            <td>{c.title}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ViewsSection({ views }: { views: Record<string, ViewContribution[]> }) {
  const containerIds = Object.keys(views);
  if (containerIds.length === 0) return <p className="extensions-hint">宣言されたViewはありません。</p>;
  return (
    <>
      {containerIds.map((containerId) => (
        <div key={containerId} className="extension-feature-views-group">
          <h3>{containerId}</h3>
          <table className="extension-feature-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>名前</th>
              </tr>
            </thead>
            <tbody>
              {views[containerId].map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.id}</code>
                  </td>
                  <td>{v.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/** VS Code Marketplace-style detail page for one installed extension —
 * rendered by EditorGroupPane.tsx as the body of a real tab in that
 * group's own tab strip (alongside source-file tabs), filling
 * `.editor-group-body` the same way MonacoEditorPane does. No close
 * button of its own — the tab strip's own × (see EditorGroupPane.tsx)
 * covers that, same as a file tab never has an in-content close button
 * either. Opened by clicking a row in ExtensionsPanel.tsx (the
 * now-simplified sidebar list) or by an extension's own
 * `workbench.action.openSettings` call (indirectly, via App.tsx's
 * openSettingsRequest effect switching the sidebar to the Extensions view
 * — the settings modal itself is separate, see SettingsModal.tsx).
 *
 * Same DETAILS/FEATURES split as VS Code's own Marketplace page: DETAILS
 * is the description + README; FEATURES is a declarative dump of what the
 * manifest contributes (Runtime Status, Activation Events, Commands,
 * Settings, View Containers, Views), read straight off the extracted
 * manifest fields (vsixInstall.ts's extractMetadata) — informational only,
 * same as VS Code's own version isn't where you edit any of it either
 * (Settings here lists *declared* schema; actual editing is the existing
 * ⚙ 設定 button/SettingsModal). */
export function ExtensionDetailView() {
  const viewingExtensionId = useExtensionsStore((s) => s.viewingExtensionId);
  const extensions = useExtensionsStore((s) => s.extensions);
  const status = useExtensionsStore((s) => s.status);
  const requestOpenSettings = useExtensionsStore((s) => s.requestOpenSettings);
  const setAutoActivate = useExtensionsStore((s) => s.setAutoActivate);
  const [tab, setTab] = useState<DetailTab>('details');
  const [featureSection, setFeatureSection] = useState<FeatureSectionId>('runtimeStatus');

  if (!viewingExtensionId) return null;
  const ext = extensions.find((e) => e.id === viewingExtensionId);
  if (!ext) return null;

  const extStatus = status[ext.id] ?? { kind: 'inactive' as const };

  return (
    <div className="extension-detail-view">
      {/* Pinned region: header/status/DETAILS-FEATURES switcher never
          scroll out of view, even with a long README — only the tab body
          below scrolls. Previously this whole thing was one scrolling
          block, so scrolling into a long README hid the FEATURES button
          entirely with no way back to it short of scrolling back up. */}
      <div className="extension-detail-pinned">
        <div className="extension-detail-header">
          {ext.iconDataUrl ? (
            <img className="extension-detail-icon" src={ext.iconDataUrl} alt="" />
          ) : (
            <span className="extension-detail-icon extension-detail-icon-fallback">🧩</span>
          )}
          <div className="extension-detail-title">
            <h1>{ext.displayName}</h1>
            <div className="extension-detail-meta">
              {ext.publisher && <span>{ext.publisher}</span>}
              <span>v{ext.version}</span>
              <span className="extension-detail-id">{ext.id}</span>
            </div>
            <div className="extensions-actions">
              {extStatus.kind === 'active' ? (
                <button onClick={() => deactivateExtension(ext.id)}>無効化</button>
              ) : (
                <button
                  className="primary"
                  disabled={extStatus.kind === 'activating'}
                  onClick={() => void activateExtension(ext.id)}
                >
                  {extStatus.kind === 'activating' ? '有効化中...' : '有効化'}
                </button>
              )}
              {ext.configSchema.length > 0 && <button onClick={() => requestOpenSettings(ext.id)}>⚙ 設定</button>}
              <button onClick={() => void uninstallExtension(ext.id)}>アンインストール</button>
            </div>
            <label className="extension-detail-auto-activate">
              <input
                type="checkbox"
                checked={ext.autoActivate ?? false}
                onChange={(e) => void setAutoActivate(ext.id, e.target.checked)}
              />
              起動時に自動的に有効化する
            </label>
          </div>
        </div>

        {extStatus.kind === 'active' && (
          <div className="extensions-status success">
            有効化しました。登録されたコマンド: {extStatus.commands.length > 0 ? extStatus.commands.join(', ') : '(なし)'}
            <br />
            画面があれば右側のドックにパネルとして表示されます(ターミナル/Copilotと同じくドラッグで自由に移動できます)。
          </div>
        )}
        {extStatus.kind === 'error' && <div className="extensions-status error">{extStatus.message}</div>}

        <div className="extension-detail-tabs">
          <button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>
            DETAILS
          </button>
          <button className={tab === 'features' ? 'active' : ''} onClick={() => setTab('features')}>
            FEATURES
          </button>
        </div>
      </div>

      <div className="extension-detail-scroll-body">
        {tab === 'details' ? (
          <div className="extension-detail-tab-content">
            {ext.description && <p className="extension-detail-description">{ext.description}</p>}
            <hr className="extension-detail-divider" />
            {ext.readme ? <MarkdownContent text={ext.readme} /> : <p className="extensions-hint">READMEはありません。</p>}
          </div>
        ) : (
          <div className="extension-detail-features">
            <div className="extension-detail-features-nav">
              {FEATURE_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  className={featureSection === s.id ? 'active' : ''}
                  onClick={() => setFeatureSection(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="extension-detail-features-content">
              {featureSection === 'runtimeStatus' && <RuntimeStatusSection extStatus={extStatus} />}
              {featureSection === 'activationEvents' && <ActivationEventsSection events={ext.activationEvents} />}
              {featureSection === 'commands' && <CommandsSection commands={ext.commandContributions} />}
              {featureSection === 'settings' && <SettingsSection configSchema={ext.configSchema} />}
              {featureSection === 'viewContainers' && <ViewContainersSection containers={ext.viewContainers} />}
              {featureSection === 'views' && <ViewsSection views={ext.views} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
