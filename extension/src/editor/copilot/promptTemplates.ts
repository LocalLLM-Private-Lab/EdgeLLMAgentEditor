export interface ContextFileContent {
  path: string;
  content: string;
  /** True when the path doesn't exist in the workspace yet — say so
   * explicitly rather than silently sending empty content, since "empty
   * file" and "file to be created" read very differently to a reader. */
  isNew?: boolean;
}

// No empty fenced block for isNew files — an empty ``` ``` right after
// "doesn't exist yet" reads as broken/incomplete to a model and was
// observed causing Copilot to re-request the same file via NEED_FILES
// instead of proceeding to create it, looping indefinitely. A plain
// sentence carries the same information without that ambiguity.
function formatFileBlock(file: ContextFileContent): string {
  if (file.isNew) {
    return `\`${file.path}\`: このファイルはワークスペース内にまだ存在しません(新規作成対象)。これ以上このファイルをNEED_FILESで要求せず、空の状態から内容を新規作成してコードブロックで返してください。\n`;
  }
  return `\`${file.path}\`:\n\`\`\`\n${file.content}\n\`\`\`\n`;
}

/**
 * Teaches the five "instead of prose/code, emit exactly one control line"
 * tools — NEED_FILES / TOOL_GREP / TOOL_LIST_FILES / TOOL_RUN /
 * TOOL_RUN_NAMED. Always part of {fileInstructionSection}'s value (see
 * buildFileEditPrompt), regardless of whether files are attached or the
 * request is edit vs. analysis-only: "I need to see another file to
 * explain this" or "let me run this to check the error" are just as valid
 * for a no-files analysis request as for an edit — this used to be bundled
 * with FILE_RETURN_INSTRUCTION below and silently disappeared whenever
 * that wasn't included.
 */
const TOOL_INSTRUCTION =
  '十分な情報がなく正確に回答・対応ができないと判断した場合は、代わりに1行だけ `NEED_FILES: path/to/a.ts, path/to/b.ts` の形式で必要なファイルパスをカンマ区切りで列挙してください。ただし、「ワークスペース内にまだ存在しません(新規作成対象)」と明記されているファイルについては、既にその旨の回答が済んでいるので、同じファイルを再度NEED_FILESで要求しないでください。ファイルパスが分からず、まずプロジェクト内を検索・一覧したい場合は、代わりに1行だけ `TOOL_GREP: 検索パターン(正規表現可)` または `TOOL_LIST_FILES: ファイル名の一部(空なら全件)` の形式でリクエストしてください。結果を踏まえた続きのプロンプトを自動で用意します。ファイルを実際に実行して出力やエラーを確認したい場合は、代わりに1行だけ `TOOL_RUN: path/to/a.py` の形式でそのファイルの実行を依頼してください(あらかじめユーザーが設定した実行コマンドで、ユーザーの承認後に実行され、出力を踏まえた続きのプロンプトを自動で用意します)。テストの実行やgit diffの確認など、特定のファイルに紐づかないプロジェクト単位のコマンドを実行したい場合は、代わりに1行だけ `TOOL_RUN_NAMED: test` のようにユーザーが事前に登録した名前を指定して依頼してください(該当する名前が未設定の場合はその旨が伝えられます)。';

/**
 * v1's apply-to-code flow does whole-file replacement, not line-based
 * patching (chat responses rarely carry reliable line anchors). Asking for
 * the complete file up front makes that the expected behavior rather than
 * a workaround applied after the fact — kept in the default template so a
 * user who customizes it can still see (and choose to remove) that guidance.
 * Reuses the same "path in backticks right before the fence" + nested-fence
 * escaping convention as planPromptTemplates.ts's step prompt, so
 * codeBlockParser.ts's marker-based extraction handles the response
 * whether zero, one, or several files were attached. Only makes sense when
 * there's something to actually return as a code block, so — unlike
 * TOOL_INSTRUCTION above — stays conditional on files being attached and
 * the request not being analysis-only; see buildFileEditPrompt.
 */
const FILE_RETURN_INSTRUCTION =
  '変更が必要な各ファイルについて、そのファイルパスを直前にバッククォート付きの相対パスで明記した上で(例: `src/foo.ts`)、ファイル全体を単一のコードブロックとして返してください(差分ではなくファイル全体)。複数ファイルを変更する場合は、ファイルごとに「パス明記+コードブロック」を繰り返してください。ファイルの内容自体に、行全体がバッククォート3つ以上だけから成る行(README等のMarkdownファイルに含まれる```のような例示コードブロックの行)がある場合は、その行の各バッククォートの直前にバックスラッシュを1つずつ挿入してエスケープしてください(例: ```bash → \\`\\`\\`bash)。このエスケープはこちらの解析時に自動的に元へ戻すので、ファイル自体の内容は変えないでください。';

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

const MAX_RUN_OUTPUT_CHARS = 20000;

/** Truncates from the *front*, keeping the tail — unlike
 * buildToolResultPrompt's grep/list-files results (where the interesting
 * part is usually near the start and later matches are cut), a failing
 * run's actual error is almost always at the very end of its output
 * (a stack trace, the final assertion failure, ...). */
function truncateRunOutput(output: string): string {
  if (output.length <= MAX_RUN_OUTPUT_CHARS) return output;
  return `...(先頭を省略)\n${output.slice(-MAX_RUN_OUTPUT_CHARS)}`;
}

/** Follow-up prompt after running a file (either the user's own "実行して
 * エラーを確認" button or a Copilot-requested TOOL_RUN) — same "short
 * continuation in an ongoing thread" shape as buildToolResultPrompt. */
export function buildRunResultPrompt(command: string, exitCode: number | null, output: string): string {
  const exitCodeText = exitCode === null ? '不明(異常終了またはキャンセル)' : String(exitCode);
  return [
    `以下のコマンドを実行しました(終了コード: ${exitCodeText}):`,
    '```',
    command,
    '```',
    '出力:',
    '```',
    truncateRunOutput(output) || '(出力なし)',
    '```',
    '',
    '上記の結果を踏まえて、続きを行ってください。エラーが発生している場合は原因を分析し、必要な修正案を提示してください。',
  ].join('\n');
}

export const DEFAULT_EDIT_TEMPLATE = [
  '{repoMapSection}{filesSection}指示: {instruction}',
  '',
  '{fileInstructionSection}',
].join('\n');

/** For analysis/explanation requests (code review, "explain this", etc.) —
 * still includes {fileInstructionSection}, since its value is always at
 * least TOOL_INSTRUCTION now (NEED_FILES/TOOL_GREP/TOOL_LIST_FILES/TOOL_RUN
 * are just as useful for "explain this" as for editing); only the
 * whole-file-return part is ever omitted from it. */
export const DEFAULT_EXPLAIN_TEMPLATE = [
  '{repoMapSection}{filesSection}指示: {instruction}',
  '',
  '{fileInstructionSection}',
].join('\n');

const PLACEHOLDER_RE = /\{repoMapSection\}|\{filesSection\}|\{instruction\}|\{fileInstructionSection\}/g;

/** `{fileInstructionSection}` always carries at least TOOL_INSTRUCTION
 * (NEED_FILES/TOOL_GREP/TOOL_LIST_FILES/TOOL_RUN) — useful regardless of
 * whether any file is attached. FILE_RETURN_INSTRUCTION (the "return the
 * whole file as a code block" part) is appended only when there's actually
 * something to return as one: files attached and not an analysis-only
 * request (`analysisOnly` mirrors planPromptTemplates.ts's buildStepPrompt
 * — same reasoning, requests marked analysis-only shouldn't be told to
 * produce code). */
export function buildFileEditPrompt(
  instruction: string,
  files: ContextFileContent[],
  repoMap?: string,
  template: string = DEFAULT_EDIT_TEMPLATE,
  analysisOnly = false,
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
    '{fileInstructionSection}':
      files.length > 0 && !analysisOnly
        ? `${TOOL_INSTRUCTION} ${FILE_RETURN_INSTRUCTION}`
        : TOOL_INSTRUCTION,
  };
  // Single pass over the original template so placeholder-looking text
  // inside a substituted value (e.g. a file that mentions "{instruction}")
  // never gets re-matched and substituted again.
  return template.replace(PLACEHOLDER_RE, (match) => values[match]);
}
