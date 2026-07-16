/**
 * Copilot's replies are normally either `path`-labeled code blocks or —
 * per the escape hatches taught in promptTemplates.ts / planPromptTemplates.ts
 * — a control line instead: NEED_FILES when the attached context isn't
 * enough to make an accurate change, REVISE_PLAN (step flow only) when the
 * step itself reveals the plan needs to change. Checked before code-block
 * extraction so these aren't misparsed as source code.
 */
const NEED_FILES_RE = /^NEED_FILES:\s*(.+)$/m;
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

export function detectPlanRevisionRequest(markdown: string): string | null {
  const match = REVISE_PLAN_RE.exec(markdown);
  if (!match) return null;
  const note = match[1].trim();
  return note || null;
}
