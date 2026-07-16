/**
 * Copilot's replies are normally either `path`-labeled code blocks or —
 * per the escape hatches taught in promptTemplates.ts / planPromptTemplates.ts
 * — a control line instead: NEED_FILES when the attached context isn't
 * enough to make an accurate change, TOOL_GREP / TOOL_LIST_FILES when it
 * needs to search or discover files it doesn't know the path of yet,
 * REVISE_PLAN (step flow only) when the step itself reveals the plan needs
 * to change. Checked before code-block extraction so these aren't
 * misparsed as source code.
 */
const NEED_FILES_RE = /^NEED_FILES:\s*(.+)$/m;
const TOOL_GREP_RE = /^TOOL_GREP:\s*(.+)$/m;
const TOOL_LIST_FILES_RE = /^TOOL_LIST_FILES:\s*(.*)$/m;
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

export function detectPlanRevisionRequest(markdown: string): string | null {
  const match = REVISE_PLAN_RE.exec(markdown);
  if (!match) return null;
  const note = match[1].trim();
  return note || null;
}
