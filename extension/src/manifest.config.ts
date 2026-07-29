import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineManifest } from '@crxjs/vite-plugin';

// Pinned so the extension ID stays stable across dev reloads — the Rust
// terminal-host validates the WebSocket Origin header against this ID.
// Regenerate via `node .dev-keys/generate-dev-key.cjs` if this file is missing.
const devManifestKeyPath = fileURLToPath(
  new URL('../.dev-keys/manifest-key.txt', import.meta.url),
);
const devManifestKey = readFileSync(devManifestKeyPath, 'utf-8').trim();

export default defineManifest({
  manifest_version: 3,
  name: 'M365 Copilot Code Editor',
  version: '0.1.0',
  description:
    'VSCode-like local editor with terminal and manual Microsoft 365 Copilot assist.',
  key: devManifestKey,
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'Open Code Editor',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['storage', 'tabs', 'nativeMessaging'],
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
    // Chrome's default sandbox CSP (inline scripts + eval allowed) covers
    // a webview extension's own inline code, but not resources it loads
    // from an external <script src>/<link>/<img> — which is exactly what
    // `vscode.Webview.asWebviewUri` produces (a real
    // `http://127.0.0.1:<port>/ext-resource/...` URL served by
    // terminal-host, see ws_server.rs's serve_ext_resource route). Extend
    // the relevant *-src directives to allow it; everything else stays at
    // Chrome's own sandbox default.
    sandbox:
      "sandbox allow-scripts allow-forms allow-popups allow-modals; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:*; " +
      "style-src 'self' 'unsafe-inline' http://127.0.0.1:*; " +
      "img-src 'self' data: http://127.0.0.1:*; " +
      "font-src 'self' data: http://127.0.0.1:*; " +
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; " +
      "child-src 'self';",
  },
  // A regular extension page's CSP flatly disallows eval/inline scripts/blob
  // imports (MV3, non-negotiable) — a webview-contributing VS Code
  // extension's HTML routinely uses both. Sandboxed pages are the
  // platform-sanctioned escape hatch: they get Chrome's relaxed default
  // sandbox CSP (inline scripts + eval allowed) in exchange for losing all
  // chrome.* extension API access, which is exactly the isolation a
  // third-party extension's webview content should have anyway. See
  // src/editor/webview-sandbox/.
  sandbox: {
    pages: ['src/editor/webview-sandbox/index.html'],
  },
});
