// Stage 6 — Quality / Trust / Rank (diagram: Quality/Trust/Dedup/Rank).
// Scores sources by authority prior + query-term coverage + freshness signal.
// Pure module.

import type { WebSource } from "@/lib/search/web";

function coverage(text: string, query: string): number {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (terms.length === 0) return 0;
  const low = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (low.includes(t)) hits++;
  return hits / terms.length;
}

function freshness(text: string): number {
  // Cheap signal: mentions the current or adjacent year.
  const year = new Date().getFullYear();
  if (new RegExp(`\\b${year}\\b`).test(text)) return 1;
  if (new RegExp(`\\b(${year - 1}|${year + 1})\\b`).test(text)) return 0.5;
  return 0;
}

/** Return a new array sorted best-first (stable, no mutation). */
export function rankSources(sources: WebSource[], query: string): WebSource[] {
  return sources
    .map((s, i) => {
      const body = `${s.title} ${s.snippet}`;
      const score = s.authority * 0.5 + coverage(body, query) * 0.4 + freshness(body) * 0.1;
      return { s, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.s);
}
