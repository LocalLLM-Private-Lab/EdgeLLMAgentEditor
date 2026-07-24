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
  },
});
