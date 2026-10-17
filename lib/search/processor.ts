// Stage 3 — Result Processor (diagram: Result Processor).
// Normalizes raw provider results: URL canonicalization, junk filtering,
// cross-provider dedup. Pure module.

import type { WebSource } from "@/lib/search/web";

function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.protocol = "https:"; // http/https variants of one page are the same result
    u.hash = "";
    // Drop tracking params that create false-distinct URLs.
    const drop = /^utm_|^(fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|ref|source)$/i;
    for (const k of [...u.searchParams.keys()]) {
      if (drop.test(k)) u.searchParams.delete(k);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname === "/") s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return null;
  }
}

/** Merge result lists from any providers into a clean, deduped list. */
export function dedupeSources(sources: WebSource[]): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const s of sources) {
    if (!s.url || !s.title) continue;
    const key = canonicalUrl(s.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
