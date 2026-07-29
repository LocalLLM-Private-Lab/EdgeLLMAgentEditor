/** App-wide commands reachable from both the persistent command bar in the
 * header (AppCommandBar.tsx) and the Ctrl+P command palette's ">" mode
 * (QuickOpenModal.tsx) — defined once in App.tsx and passed to both so
 * they can never drift out of sync. */
export interface Command {
  id: string;
  label: string;
  run: () => void;
}

/** Subsequence fuzzy match (every query char must appear in order,
 * case-insensitive) — contiguous runs score higher, shorter candidates are
 * a slight tiebreaker. Shared by file search (QuickOpenModal) and command
 * search (QuickOpenModal's ">" mode, AppCommandBar). */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      score += lastMatchIndex === ci - 1 ? 3 : 1;
      lastMatchIndex = ci;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score - c.length * 0.01;
}
