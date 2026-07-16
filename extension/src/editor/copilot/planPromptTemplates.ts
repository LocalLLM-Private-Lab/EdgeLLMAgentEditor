import type { PlanStep } from './planParser';

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

export const DEFAULT_PLAN_PROMPT_TEMPLATE = [
  '{repoMapSection}{contextFilesSection}以下の目標を達成するための実行計画を、変更が必要なファイルごとにステップへ分割してください。',
  '',
  '目標: {goal}',
  '',
  '出力は必ず次のJSON形式のコードブロック1つのみで返してください。前後に説明文を含めないでください。',
  'files には、プロジェクト構成に基づく「プロジェクトルートからの相対パス」をスラッシュ区切りで指定してください(例: "extension/src/editor/App.tsx")。ルートフォルダ自身の名前(プロジェクト構成の1行目)はパスに含めないでください。',
  '```json',
  '[{"description": "このステップで行う変更の説明", "files": ["変更対象の相対パス", "..."]}]',
  '```',
  '',
  'ただし、与えられたプロジェクト構成や関連ファイルの内容だけでは適切な計画を立てられないと判断した場合は、JSONを返す代わりに1行だけ `NEED_FILES: path/to/a.ts, path/to/b.ts` の形式で確認したいファイルパスをカンマ区切りで列挙してください。',
].join('\n');

export const DEFAULT_STEP_PROMPT_TEMPLATE = [
  'これはプロジェクト全体の計画の一部です。',
  '',
  '全体の目標: {goal}',
  '',
  '計画:',
  '{planSection}',
  '',
  '今回実行するステップ: {stepDescription}',
  '',
  '関連ファイルの現在の内容:',
  '',
  '{stepFilesSection}上記のステップを実行してください。変更が必要な各ファイルについて、そのファイルパスを直前にバッククォート付きの相対パスで明記した上で(例: `src/foo.ts`)、ファイル全体を単一のコードブロックとして返してください(差分ではなくファイル全体)。複数ファイルを変更する場合は、ファイルごとに「パス明記+コードブロック」を繰り返してください。ファイルの内容自体に、行全体がバッククォート3つ以上だけから成る行(README等のMarkdownファイルに含まれる```のような例示コードブロックの行)がある場合は、その行の各バッククォートの直前にバックスラッシュを1つずつ挿入してエスケープしてください(例: ```bash → \\`\\`\\`bash)。このエスケープはこちらの解析時に自動的に元へ戻すので、ファイル自体の内容は変えないでください。関連ファイルの内容だけでは正確な変更ができないと判断した場合は、コードブロックを生成せず、代わりに1行だけ `NEED_FILES: path/to/a.ts, path/to/b.ts` の形式で不足しているファイルパスをカンマ区切りで列挙してください。今回のステップをきっかけに計画全体の変更が必要だと判断した場合は、コードブロックを生成せず、代わりに1行目に `REVISE_PLAN:` と書いた上で、変更が必要な理由と提案する変更内容を続けて記述してください。',
  '',
].join('\n');

export const DEFAULT_PLAN_REVISION_TEMPLATE = [
  '以下の目標に対する実行計画について、ステップの実行中に計画自体の変更が必要だという指摘がありました。',
  '',
  '全体の目標: {goal}',
  '',
  '現在の計画:',
  '{planSection}',
  '',
  '指摘内容: {note}',
  '',
  '上記を踏まえて計画全体を見直し、更新後の計画を返してください。',
  '出力は必ず次のJSON形式のコードブロック1つのみで返してください。前後に説明文を含めないでください。',
  'files には、プロジェクトルートからの相対パスをスラッシュ区切りで指定してください。',
  '```json',
  '[{"description": "このステップで行う変更の説明", "files": ["変更対象の相対パス", "..."]}]',
  '```',
  '',
].join('\n');

const PLAN_PLACEHOLDER_RE = /\{repoMapSection\}|\{contextFilesSection\}|\{goal\}/g;
const STEP_PLACEHOLDER_RE = /\{goal\}|\{planSection\}|\{stepDescription\}|\{stepFilesSection\}/g;
const REVISION_PLACEHOLDER_RE = /\{goal\}|\{planSection\}|\{note\}/g;

/** Asks Copilot to break a goal into file-scoped steps, returned as a single
 * ```json block so parsePlanResponse can reliably extract it — free-form
 * numbered lists read more naturally but don't carry structured per-step
 * file lists, which the step-execution prompt below depends on. Template
 * is customizable (settings → 計画プロンプトテンプレート), default value
 * reproduces the original hardcoded wording. */
export function buildPlanPrompt(
  goal: string,
  repoMap: string | undefined,
  contextFiles: ContextFileContent[],
  template: string = DEFAULT_PLAN_PROMPT_TEMPLATE,
): string {
  const repoMapSection = repoMap
    ? `プロジェクト構成(参考情報、インデントはディレクトリ階層を表す):\n\`\`\`\n${repoMap}\n\`\`\`\n\n`
    : '';
  const contextFilesSection =
    contextFiles.length > 0
      ? `関連ファイル:\n\n${contextFiles.map(formatFileBlock).join('\n')}\n`
      : '';
  const values: Record<string, string> = {
    '{repoMapSection}': repoMapSection,
    '{contextFilesSection}': contextFilesSection,
    '{goal}': goal,
  };
  return template.replace(PLAN_PLACEHOLDER_RE, (match) => values[match]);
}

/** Re-states the whole plan for orientation, then scopes the actual request
 * to one step + that step's current file contents (fetched fresh, not
 * reused from the planning prompt, in case earlier steps already changed
 * them). Reuses the same "path in backticks right before the fence"
 * convention promptTemplates.ts's single-file flow relies on, so
 * codeBlockParser.ts's existing suggestedPath matching works unmodified
 * even for multi-file responses. Template is customizable, default value
 * reproduces the original hardcoded wording. */
export function buildStepPrompt(
  goal: string,
  steps: PlanStep[],
  activeStepIndex: number,
  stepFiles: ContextFileContent[],
  template: string = DEFAULT_STEP_PROMPT_TEMPLATE,
): string {
  const planSection = steps
    .map((step, i) => `${i === activeStepIndex ? '→' : ' '} ${i + 1}. ${step.description}`)
    .join('\n');
  const stepFilesSection = stepFiles.length > 0 ? `${stepFiles.map(formatFileBlock).join('\n')}\n` : '';
  const values: Record<string, string> = {
    '{goal}': goal,
    '{planSection}': planSection,
    '{stepDescription}': steps[activeStepIndex].description,
    '{stepFilesSection}': stepFilesSection,
  };
  return template.replace(STEP_PLACEHOLDER_RE, (match) => values[match]);
}

/** Built when a step's response comes back as a REVISE_PLAN control line
 * instead of code (see DEFAULT_STEP_PROMPT_TEMPLATE) — restates the goal,
 * the plan as currently known, and the reported reason, then asks for a
 * full replacement plan in the same JSON shape parsePlanResponse expects
 * so the result can be pasted straight into the existing "②計画を取り込む"
 * flow. */
export function buildPlanRevisionPrompt(
  goal: string,
  steps: PlanStep[],
  note: string,
  template: string = DEFAULT_PLAN_REVISION_TEMPLATE,
): string {
  const planSection = steps.map((step, i) => `${i + 1}. ${step.description}`).join('\n');
  const values: Record<string, string> = {
    '{goal}': goal,
    '{planSection}': planSection,
    '{note}': note,
  };
  return template.replace(REVISION_PLACEHOLDER_RE, (match) => values[match]);
}
