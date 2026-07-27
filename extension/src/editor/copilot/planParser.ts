import { v4 as uuid } from 'uuid';

export interface PlanStep {
  id: string;
  description: string;
  /** '/'-joined relative paths, as given by Copilot — best-effort, may not
   * resolve to real workspace files (see PlanStepCard's manual fallback). */
  files: string[];
  status: 'pending' | 'in-progress' | 'done';
}

const JSON_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * Extracts the plan's ```json block (or, failing that, tries the raw text
 * directly — Copilot sometimes drops the fence) and validates its shape.
 * Returns null on any failure so the caller can fall back to a single
 * catch-all step holding the raw text, rather than losing the response.
 */
export function parsePlanResponse(markdown: string): PlanStep[] | null {
  const match = markdown.match(JSON_FENCE_RE);
  const raw = match ? match[1] : markdown.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const steps: PlanStep[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const { description, files } = item as Record<string, unknown>;
    if (typeof description !== 'string' || !description.trim()) return null;
    if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return null;
    steps.push({ id: uuid(), description, files, status: 'pending' });
  }
  return steps;
}

/** Used when parsePlanResponse fails — keeps the response usable (as a
 * single manual step) instead of silently discarding it. */
export function fallbackSingleStep(rawResponse: string): PlanStep[] {
  return [{ id: uuid(), description: rawResponse.trim(), files: [], status: 'pending' }];
}
