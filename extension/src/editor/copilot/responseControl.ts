/**
 * Copilot's replies are normally either `path`-labeled code blocks or —
 * per the escape hatches taught in promptTemplates.ts / planPromptTemplates.ts
 * — a control line instead: NEED_FILES when the attached context isn't
 * enough to make an accurate change, TOOL_GREP / TOOL_LIST_FILES when it
 * needs to search or discover files it doesn't know the path of yet,
 * TOOL_RUN when it wants a file actually executed (path only — never a raw
 * command, see runToolResolver.ts), TOOL_RUN_NAMED when it wants a
 * project-level command run instead (a name from the user's own
 * namedCommandStore config, same "never a raw command" rule), REVISE_PLAN
 * (step flow only) when the step itself reveals the plan needs to change.
 * Checked before code-block extraction so these aren't misparsed as source
 * code.
 */
const NEED_FILES_RE = /^NEED_FILES:\s*(.+)$/m;
const TOOL_GREP_RE = /^TOOL_GREP:\s*(.+)$/m;
const TOOL_LIST_FILES_RE = /^TOOL_LIST_FILES:\s*(.*)$/m;
const TOOL_RUN_RE = /^TOOL_RUN:\s*(.+)$/m;
const TOOL_RUN_NAMED_RE = /^TOOL_RUN_NAMED:\s*(.+)$/m;
const REVISE_PLAN_RE = /^REVISE_PLAN:\s*([\s\S]*)$/m;

export function detectNeedFilesRequest(markdown: string): string[] | null {
  const match = NEED_FILES_RE.exec(markdown);
  if (!match) return null;
  const paths = match[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return paths.length > 0 ? paths : null;
}

export function detectGrepRequest(markdown: string): string | null {
  const match = TOOL_GREP_RE.exec(markdown);
  if (!match) return null;
  const pattern = match[1].trim();
  return pattern || null;
}

/** Query may legitimately be empty ("list everything"), unlike the other
 * detectors — that's still a valid request, not "no match". */
export function detectListFilesRequest(markdown: string): string | null {
  const match = TOOL_LIST_FILES_RE.exec(markdown);
  return match ? match[1].trim() : null;
}

export function detectRunRequest(markdown: string): string | null {
  const match = TOOL_RUN_RE.exec(markdown);
  if (!match) return null;
  const path = match[1].trim();
  return path || null;
}

export function detectNamedRunRequest(markdown: string): string | null {
  const match = TOOL_RUN_NAMED_RE.exec(markdown);
  if (!match) return null;
  const name = match[1].trim();
  return name || null;
}

export function detectPlanRevisionRequest(markdown: string): string | null {
  const match = REVISE_PLAN_RE.exec(markdown);
  if (!match) return null;
  const note = match[1].trim();
  return note || null;
}

export type ControlFlowResult =
  | { kind: 'needFiles'; paths: string[] }
  | { kind: 'grep'; pattern: string }
  | { kind: 'listFiles'; query: string }
  | { kind: 'runTool'; path: string }
  | { kind: 'runToolNamed'; name: string }
  | { kind: 'revisePlan'; note: string }
  | { kind: 'none' };

/** Single source of truth for detector precedence — the 3 call sites
 * (CopilotPanel/PlanPanel/PlanStepCard) all check these in the same order;
 * this just makes "did every site remember the new detector" a non-issue
 * instead of 3 independently-maintained if-cascades. Each site still owns
 * its own side effects (which setter to call, which prompt builder to use)
 * — those differ enough per site (local state vs. store action vs. props
 * callback) that folding them into this function too isn't worth the
 * abstraction-fit risk. */
export function detectControlFlow(
  markdown: string,
  opts: { supportsRevisePlan: boolean } = { supportsRevisePlan: false },
): ControlFlowResult {
  const needFiles = detectNeedFilesRequest(markdown);
  if (needFiles) return { kind: 'needFiles', paths: needFiles };

  const grepPattern = detectGrepRequest(markdown);
  if (grepPattern) return { kind: 'grep', pattern: grepPattern };

  const listQuery = detectListFilesRequest(markdown);
  if (listQuery !== null) return { kind: 'listFiles', query: listQuery };

  const runPath = detectRunRequest(markdown);
  if (runPath) return { kind: 'runTool', path: runPath };

  const runName = detectNamedRunRequest(markdown);
  if (runName) return { kind: 'runToolNamed', name: runName };

  if (opts.supportsRevisePlan) {
    const note = detectPlanRevisionRequest(markdown);
    if (note) return { kind: 'revisePlan', note };
  }

  return { kind: 'none' };
}
