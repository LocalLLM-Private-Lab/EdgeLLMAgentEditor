import type { PlanStep } from './planParser';

export interface ContextFileContent {
  path: string;
  content: string;
}

function formatFileBlock(file: ContextFileContent): string {
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
  '{stepFilesSection}上記のステップを実行してください。変更が必要な各ファイルについて、そのファイルパスを直前にバッククォート付きの相対パスで明記した上で(例: `src/foo.ts`)、ファイル全体を単一のコードブロックとして返してください(差分ではなくファイル全体)。複数ファイルを変更する場合は、ファイルごとに「パス明記+コードブロック」を繰り返してください。ファイルの内容自体に```で始まるコードブロックが含まれる場合(README等のMarkdownファイル)は、内側のコードブロックと区別できるよう、外側のコードブロックを四重のバッククォート(````)以上で囲んでください。',
  '',
].join('\n');

const PLAN_PLACEHOLDER_RE = /\{repoMapSection\}|\{contextFilesSection\}|\{goal\}/g;
const STEP_PLACEHOLDER_RE = /\{goal\}|\{planSection\}|\{stepDescription\}|\{stepFilesSection\}/g;

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
