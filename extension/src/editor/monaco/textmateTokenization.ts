import * as monaco from 'monaco-editor';
import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { shikiToMonaco } from '@shikijs/monaco';

// Real VS Code-equivalent syntax coloring via TextMate grammars (the same
// grammar format/engine VS Code itself uses), layered on top of Monaco's
// language ids alongside — not instead of — the semantic services (ts.worker
// etc. in setupMonacoEnvironment.ts). Grammars are loaded lazily per
// language on first use, not bundled eagerly.
const THEME_ID = 'dark-plus';

const LANG_IMPORTS: Record<string, LanguageInput> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  shell: () => import('@shikijs/langs/shell'),
  powershell: () => import('@shikijs/langs/powershell'),
  xml: () => import('@shikijs/langs/xml'),
  rust: () => import('@shikijs/langs/rust'),
  makefile: () => import('@shikijs/langs/makefile'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  // Python uses the same TextMate/Shiki provider as Rust and TypeScript;
  // keep every Python-family extension on this grammar as well.
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  ruby: () => import('@shikijs/langs/ruby'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  'system-verilog': () => import('@shikijs/langs/system-verilog'),
  verilog: () => import('@shikijs/langs/verilog'),
  tcl: () => import('@shikijs/langs/tcl'),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [() => import('@shikijs/themes/dark-plus')],
      langs: [],
      // JS-engine backend: avoids WebAssembly.instantiate entirely, so no
      // 'wasm-unsafe-eval' CSP addition is needed for MV3. See manifest.config.ts.
      // forgiving: skip any Oniguruma pattern this engine can't transpile
      // instead of throwing — some target grammars (C++, Ruby, SystemVerilog)
      // are large/complex enough to hit unsupported patterns, and a throw
      // here would otherwise abort openFile(), not just degrade coloring.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

const langLoadPromises = new Map<string, Promise<void>>();

async function loadLanguage(langId: string, loader: LanguageInput): Promise<void> {
  const highlighter = await getHighlighter();

  // shikiToMonaco only wires a tokens provider for language ids Monaco
  // already knows about — ids outside Monaco's built-in basic-languages set
  // (e.g. system-verilog) need explicit registration first.
  if (!monaco.languages.getLanguages().some((l) => l.id === langId)) {
    monaco.languages.register({ id: langId });
  }

  await highlighter.loadLanguage(loader);
  // Re-run on every newly loaded language: shikiToMonaco only wires up
  // providers for languages loaded in the highlighter *at call time*, it
  // doesn't hook future loads.
  shikiToMonaco(highlighter, monaco);
}

/** Loads and wires TextMate-based tokenization for `langId`, once. No-op for
 * language ids without a grammar in LANG_IMPORTS (e.g. 'plaintext') — those
 * keep using Monaco's default/Monarch tokenizer. */
export function ensureLanguageTokenization(langId: string): Promise<void> {
  const loader = LANG_IMPORTS[langId];
  if (!loader) return Promise.resolve();

  let pending = langLoadPromises.get(langId);
  if (!pending) {
    pending = loadLanguage(langId, loader);
    langLoadPromises.set(langId, pending);
  }
  return pending;
}

export { THEME_ID as TEXTMATE_THEME_ID };
