/**
 * v1's apply-to-code flow does whole-file replacement, not line-based
 * patching (chat responses rarely carry reliable line anchors). Asking for
 * the complete file up front makes that the expected behavior rather than
 * a workaround applied after the fact — kept in the default template so a
 * user who customizes it can still see (and choose to remove) that guidance.
 */
export const DEFAULT_PROMPT_TEMPLATE = [
  '{repoMapSection}以下のファイル「{fileName}」を編集してください。',
  '',
  '指示: {instruction}',
  '',
  '必ず変更後のファイル全体を、単一のコードブロックとして返してください(差分ではなくファイル全体)。',
  '',
  '```{language}',
  '{fileContent}',
  '```',
  '',
].join('\n');

const PLACEHOLDER_RE = /\{repoMapSection\}|\{fileName\}|\{instruction\}|\{language\}|\{fileContent\}/g;

export function buildFileEditPrompt(
  instruction: string,
  fileName: string,
  fileContent: string,
  language: string,
  repoMap?: string,
  template: string = DEFAULT_PROMPT_TEMPLATE,
): string {
  const repoMapSection = repoMap
    ? `プロジェクト構成(参考情報):\n\`\`\`\n${repoMap}\n\`\`\`\n\n`
    : '';
  const values: Record<string, string> = {
    '{repoMapSection}': repoMapSection,
    '{fileName}': fileName,
    '{instruction}': instruction,
    '{language}': language,
    '{fileContent}': fileContent,
  };
  // Single pass over the original template so placeholder-looking text
  // inside a substituted value (e.g. a file that mentions "{fileName}")
  // never gets re-matched and substituted again.
  return template.replace(PLACEHOLDER_RE, (match) => values[match]);
}
