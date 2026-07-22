import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config.ts';

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: [
      // Exact-match only (^...$) — a plain string key would also rewrite
      // subpaths like 'monaco-editor/esm/...' or 'monaco-vim/dist/...',
      // which must keep resolving normally.
      {
        // monaco-vim's package.json lists the "browser" export condition
        // before "import", so bundler resolution picks its UMD build over
        // the clean ESM one. That UMD file's `typeof define === 'function'
        // && define.amd` guard gets mistranslated during CJS/UMD interop,
        // producing a bare `define(...)` call that throws
        // `ReferenceError: define is not defined` at runtime and aborts the
        // whole chunk. Force resolution straight to the ESM build to avoid
        // the UMD path entirely.
        find: /^monaco-vim$/,
        replacement: fileURLToPath(new URL('./node_modules/monaco-vim/dist/index.mjs', import.meta.url)),
      },
      {
        // monaco-emacs's compiled CJS output (lib/**) does `require('monaco-editor')`.
        // monaco-editor's package.json resolves "require" to the old AMD/minified
        // build (min/vs/editor/editor.main.js, containing an unguarded `define(...)`
        // call meant for an actual AMD loader), rather than the ESM build our own
        // code imports. That AMD file throws the same `define is not defined` at
        // evaluation time. Force every resolution of the bare 'monaco-editor'
        // specifier — import or require — to the ESM build.
        find: /^monaco-editor$/,
        replacement: fileURLToPath(
          new URL('./node_modules/monaco-editor/esm/vs/editor/editor.main.js', import.meta.url),
        ),
      },
    ],
  },
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
