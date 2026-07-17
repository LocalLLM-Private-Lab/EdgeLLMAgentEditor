/** Language ids supported by the language-server multiplexer. Makefile and
 * Dockerfile intentionally stay syntax-only for now; unlike the other entries
 * there is no universally available LSP executable to launch on Windows. */
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
] as const;

export type LspLanguageId = (typeof LSP_LANGUAGE_IDS)[number];

const LSP_LANGUAGE_SET = new Set<string>(LSP_LANGUAGE_IDS);

export function isLspLanguage(language: string): language is LspLanguageId {
  return LSP_LANGUAGE_SET.has(language);
}
