/** Language ids supported by the language-server multiplexer. Makefile and
 * Dockerfile stay syntax-only because neither has a broadly interoperable
 * language server. The host automatically resolves or installs the server for
 * the entries below when the corresponding file is opened. */
export const LSP_LANGUAGE_IDS = [
  'rust',
  'c',
  'cpp',
  'python',
  'ruby',
  'html',
  'css',
  'javascript',
  'typescript',
  'verilog',
  'system-verilog',
] as const;

export type LspLanguageId = (typeof LSP_LANGUAGE_IDS)[number];

const LSP_LANGUAGE_SET = new Set<string>(LSP_LANGUAGE_IDS);

export function isLspLanguage(language: string): language is LspLanguageId {
  return LSP_LANGUAGE_SET.has(language);
}
