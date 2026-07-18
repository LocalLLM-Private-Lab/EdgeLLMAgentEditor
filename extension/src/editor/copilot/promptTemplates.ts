export interface ContextFileContent {
  path: string;
  content: string;
  /** True when the path doesn't exist in the workspace yet — say so
   * explicitly rather than silently sending empty content, since "empty
   * file" and "file to be created" read very differently to a reader. */
  isNew?: boolean;
}

function formatFileBlock(file: ContextFileContent): string {
  if (file.isNew) {
    return `\`${file.path}\`(まだ存在しない新規ファイルです。空の状態から新しく作成してください):\n\`\`\`\n\`\`\`\n`;
  }
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
  '変更が必要な各ファイルについて、そのファイルパスを直前にバッククォート付きの相対パスで明記した上で(例: `src/foo.ts`)、ファイル全体を単一のコードブロックとして返してください(差分ではなくファイル全体)。複数ファイルを変更する場合は、ファイルごとに「パス明記+コードブロック」を繰り返してください。ファイルの内容自体に、行全体がバッククォート3つ以上だけから成る行(README等のMarkdownファイルに含まれる```のような例示コードブロックの行)がある場合は、その行の各バッククォートの直前にバックスラッシュを1つずつ挿入してエスケープしてください(例: ```bash → \\`\\`\\`bash)。このエスケープはこちらの解析時に自動的に元へ戻すので、ファイル自体の内容は変えないでください。添付されたファイルの内容だけでは正確な変更ができないと判断した場合は、コードブロックを生成せず、代わりに1行だけ `NEED_FILES: path/to/a.ts, path/to/b.ts` の形式で不足しているファイルパスをカンマ区切りで列挙してください。ファイルパスが分からず、まずプロジェクト内を検索・一覧したい場合は、代わりに1行だけ `TOOL_GREP: 検索パターン(正規表現可)` または `TOOL_LIST_FILES: ファイル名の一部(空なら全件)` の形式でリクエストしてください。結果を踏まえた続きのプロンプトを自動で用意します。';

/**
 * Follow-up prompt after a TOOL_GREP / TOOL_LIST_FILES round-trip — a
 * short continuation message (not a full re-send of repoMap/instruction)
 * since these results are meant to read as "here's what you asked for" in
 * an already-ongoing chat thread, not a fresh request.
 */
export function buildToolResultPrompt(toolLabel: string, query: string, resultText: string): string {
  return [
    `${toolLabel}の結果(${query || '(全件)'}):`,
    '```',
    resultText,
    '```',
    '',
    '上記の結果を踏まえて、続きを行ってください。まだ情報が足りなければ、同じ形式で追加のツール呼び出しやNEED_FILESを行ってください。',
  ].join('\n');
}

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
