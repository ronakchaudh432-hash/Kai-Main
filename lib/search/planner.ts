// Stage 1 — Search Planner (diagram: Search Planner + Research depth).
// Turns one user question into a bounded query plan: which queries to run,
// how many pages to open, whether to run conflict verification.
// Pure module — no I/O, easily unit-tested.

export interface SearchPlan {
  queries: string[];
  maxPages: number;
  verify: boolean;
}

export function planSearch(
  query: string,
  opts: { deep?: boolean; subTasks?: string[]; finance?: boolean } = {}
): SearchPlan {
  const q = query.trim().slice(0, 400);
  const seen = new Set<string>();
  const queries: string[] = [];
  const push = (s: string) => {
    const t = s.trim().slice(0, 400);
    const k = t.toLowerCase();
    if (t.length > 2 && !seen.has(k)) {
      seen.add(k);
      queries.push(t);
    }
  };
  push(q);
  if (opts.deep) {
    // Deep mode fans out to sub-task queries (bounded — never a crawl).
    for (const s of opts.subTasks ?? []) {
      if (queries.length >= 3) break;
      // Skip fragments that only make sense with full context.
      if (s.length > 12) push(s);
    }
    // Ensure a verification-flavored query exists for contested facts.
    if (queries.length < 3) push(`${q} latest`);
    return { queries: queries.slice(0, 3), maxPages: 5, verify: true };
  }
  if (opts.finance) {
    // Entity + money-side variants: identity check, collection side,
    // cost side. Bounded to 3 total including the original.
    const m = q.match(/^(.+?)\s+(box office|collection|profit|budget|gross|net|earning)/i);
    const entity = (m ? m[1] : q).replace(/^(what is|what'?s|tell me|find|total)\s+/i, "").trim();
    if (entity.length > 2) {
      push(`${entity} box office collection`);
      if (queries.length < 3) push(`${entity} budget`);
    }
    return { queries: queries.slice(0, 3), maxPages: 5, verify: true };
  }
  return { queries, maxPages: 3, verify: true };
}
