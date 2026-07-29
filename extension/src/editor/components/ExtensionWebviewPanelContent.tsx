import { useEffect, useRef } from 'react';
import { useTerminalStore } from '../state/terminalStore';
import { useExtensionsStore } from '../state/extensionsStore';
import { buildWebviewTheme } from '../extensions/webviewTheme';
import './ExtensionWebviewPanelContent.css';

interface ExtensionWebviewPanelContentProps {
  extensionId: string;
  viewId: string;
}

/** Renders a single webview an extension has registered
 * (`vscode.window.registerWebviewViewProvider` / `createWebviewPanel` — see
 * vscode-shim.js), as a sandboxed iframe (see webview-sandbox/), and
 * bridges postMessage traffic both ways through terminal-host's existing
 * WebSocket connection. One instance = one dock panel (see DockPanel.tsx's
 * `ext:<extensionId>:<viewId>` panel id convention, minted in
 * extensionsStore.setWebviewHtml) — each webview an extension registers is
 * independently dockable/draggable, exactly like Terminal/Copilot/
 * BuildConsole.
 *
 * Initial HTML comes from extensionsStore's `webviewHtml` (populated by an
 * always-on listener from app startup — see extensionHostClient.ts's
 * initExtensionHostBridge) rather than a subscription owned by this
 * component: an extension commonly sets `webview.html` synchronously
 * inside `resolveWebviewView`, which runs *during* activate() — before
 * this panel is even registered/mounted. A live subscription here only
 * needs to handle updates *after* mount. */
export function ExtensionWebviewPanelContent({ extensionId, viewId }: ExtensionWebviewPanelContentProps) {
  const html = useExtensionsStore((s) => s.webviewHtml[`${extensionId}:${viewId}`]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    return useTerminalStore.getState().subscribe((msg) => {
      if (msg.type === 'ext_host_webview_html') {
        if (msg.extension_id !== extensionId || msg.view_id !== viewId) return;
        // extensionsStore's listener already recorded this — just push it
        // into the already-mounted iframe directly (a newly-created one
        // instead picks up the current value via its own onLoad handler).
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'set-html', html: msg.html, ...buildWebviewTheme() },
          '*',
        );
      } else if (msg.type === 'ext_host_webview_message') {
        if (msg.extension_id !== extensionId || msg.view_id !== viewId) return;
        iframeRef.current?.contentWindow?.postMessage({ type: 'to-webview', message: msg.message }, '*');
      }
    });
  }, [extensionId, viewId]);

  // Relays webview-content -> extension messages, bridged up through the
  // sandbox page (see webview-sandbox/sandbox.ts) as `{type:'from-webview'}`.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; message?: unknown };
      if (data?.type === 'from-webview') {
        useTerminalStore.getState().send({
          type: 'ext_host_webview_message',
          extension_id: extensionId,
          view_id: viewId,
          message: data.message,
        });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [extensionId, viewId]);

  // Live theme updates (OS light/dark flip) while the panel stays mounted —
  // pushed as a CSS-only patch (see sandbox.ts's `set-theme`), not a full
  // HTML reload, so the webview's own runtime state isn't disturbed.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function handleChange() {
      iframeRef.current?.contentWindow?.postMessage({ type: 'set-theme', ...buildWebviewTheme() }, '*');
    }
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="webview-host">
      <iframe
        ref={iframeRef}
        className="webview-host-iframe"
        src={chrome.runtime.getURL('src/editor/webview-sandbox/index.html')}
        onLoad={() => {
          if (html) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'set-html', html, ...buildWebviewTheme() }, '*');
          }
        }}
      />
    </div>
  );
}
