export interface ContextFileContent {
  path: string;
  content: string;
}

function formatFileBlock(file: ContextFileContent): string {
  return `\`${file.path}\`:\n\`\`\`\n${file.content}\n\`\`\`\n`;
}

/**
 * v1's apply-to-code flow does whole-file replacement, not line-based
 * patching (chat responses rarely carry reliable line anchors). Asking for
 * the complete file up front makes that the expected behavior rather than
 * a workaround applied after the fact — kept in the default template so a
 * user who customizes it can still see (and choose to remove) that guidance.
 * Reuses the same "path in backticks right before the fence" + nested-fence
 * escaping convention as planPromptTemplates.ts's step prompt, so
 * codeBlockParser.ts's marker-based extraction handles the response
 * whether zero, one, or several files were attached.
 */
const FILE_INSTRUCTION =
  '変更が必要な各ファイルについて、そのファイルパスを直前にバッククォート付きの相対パスで明記した上で(例: `src/foo.ts`)、ファイル全体を単一のコードブロックとして返してください(差分ではなくファイル全体)。複数ファイルを変更する場合は、ファイルごとに「パス明記+コードブロック」を繰り返してください。ファイルの内容自体に```で始まるコードブロックが含まれる場合(README等のMarkdownファイル)は、内側のコードブロックと区別できるよう、外側のコードブロックを四重のバッククォート(````)以上で囲んでください。';

export const DEFAULT_EDIT_TEMPLATE = [
  '{repoMapSection}{filesSection}指示: {instruction}',
  '',
  '{fileInstructionSection}',
].join('\n');

/** For analysis/explanation requests (code review, "explain this", etc.) —
 * deliberately has no {fileInstructionSection}, since "return the whole
 * file as a code block" doesn't make sense when nothing is being edited. */
export const DEFAULT_EXPLAIN_TEMPLATE = ['{repoMapSection}{filesSection}指示: {instruction}', ''].join(
  '\n',
);

const PLACEHOLDER_RE = /\{repoMapSection\}|\{filesSection\}|\{instruction\}|\{fileInstructionSection\}/g;

/** `files` may be empty — e.g. a repomap-only architecture question with no
 * specific file attached — in which case fileInstructionSection is omitted
 * too, since "return the whole file" makes no sense with nothing attached. */
export function buildFileEditPrompt(
  instruction: string,
  files: ContextFileContent[],
  repoMap?: string,
  template: string = DEFAULT_EDIT_TEMPLATE,
): string {
  const repoMapSection = repoMap
    ? `プロジェクト構成(参考情報):\n\`\`\`\n${repoMap}\n\`\`\`\n\n`
    : '';
  const filesSection =
    files.length > 0 ? `関連ファイル:\n\n${files.map(formatFileBlock).join('\n')}\n` : '';
  const values: Record<string, string> = {
    '{repoMapSection}': repoMapSection,
    '{filesSection}': filesSection,
    '{instruction}': instruction,
    '{fileInstructionSection}': files.length > 0 ? FILE_INSTRUCTION : '',
  };
  // Single pass over the original template so placeholder-looking text
  // inside a substituted value (e.g. a file that mentions "{instruction}")
  // never gets re-matched and substituted again.
  return template.replace(PLACEHOLDER_RE, (match) => values[match]);
}
