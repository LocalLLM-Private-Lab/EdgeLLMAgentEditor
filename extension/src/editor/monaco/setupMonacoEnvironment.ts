import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import * as monaco from 'monaco-editor';

type TypeScriptDefaults = {
  setDiagnosticsOptions(options: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void;
};

const typeScriptLanguage = monaco.languages.typescript as unknown as {
  typescriptDefaults: TypeScriptDefaults;
  javascriptDefaults: TypeScriptDefaults;
};

// MV3 forbids loading remote/eval'd code, so Monaco's default CDN/AMD
// loader.js approach is unusable — every worker must be bundled locally
// and instantiated as a same-origin extension resource.
let didSetup = false;

export function setupMonacoEnvironment(): void {
  if (didSetup) return;
  didSetup = true;

  // Monaco's in-browser TypeScript worker cannot access the user's
  // tsconfig.json or filesystem-backed module graph. Its fallback compiler
  // options therefore reports false module-resolution errors even when the
  // TypeScript LSP can resolve the import and provide definition locations.
  // Keep diagnostics authoritative in the LSP, which receives the real
  // workspace root and project configuration.
  typeScriptLanguage.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  typeScriptLanguage.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}
