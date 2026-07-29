import { useExtensionNotificationsStore, type NotificationLevel } from '../state/extensionNotificationsStore';
import { useExtensionsStore } from '../state/extensionsStore';
import './ExtensionNotifications.css';

const LEVEL_CLASS: Record<NotificationLevel, string> = {
  info: 'ext-notif-info',
  warn: 'ext-notif-warn',
  error: 'ext-notif-error',
};

/** VS Code-style toast stack (bottom-right) for `vscode.window.show*Message`
 * calls from an active extension — see extensionHostClient.ts's
 * initExtensionHostBridge for how these arrive, and vscode-shim.js's
 * `notify` for the extension-host side. Always mounted at the app root
 * (App.tsx) so a notification is visible regardless of which panel/sidebar
 * view happens to be open when it fires. */
export function ExtensionNotifications() {
  const notifications = useExtensionNotificationsStore((s) => s.notifications);
  const dismiss = useExtensionNotificationsStore((s) => s.dismiss);
  const extensions = useExtensionsStore((s) => s.extensions);

  if (notifications.length === 0) return null;

  return (
    <div className="ext-notifications">
      {notifications.map((n) => {
        const displayName = extensions.find((e) => e.id === n.extensionId)?.displayName ?? n.extensionId;
        return (
          <div key={n.id} className={`ext-notification ${LEVEL_CLASS[n.level]}`}>
            <div className="ext-notification-header">
              <span className="ext-notification-source">{displayName}</span>
              <button className="ext-notification-close" onClick={() => dismiss(n.id)} aria-label="閉じる">
                ×
              </button>
            </div>
            <div className="ext-notification-message">{n.message}</div>
          </div>
        );
      })}
    </div>
  );
}
