import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config.ts';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    // CRXJS's dev-mode HMR websocket needs a fixed, predictable port.
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      // editor/index.html isn't referenced by any manifest field (it's
      // opened programmatically via chrome.tabs.create), so it needs an
      // explicit Rollup entry point for CRXJS to bundle it.
      input: {
        editor: 'src/editor/index.html',
      },
    },
  },
});
