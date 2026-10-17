// Live web research layer — staged pipeline (mirrors the documented
// architecture: plan → providers → process → fetch → extract → rank →
// verify). Works with zero keys via DuckDuckGo; upgrades to Tavily when
// configured, or a self-hosted SearXNG instance via SEARXNG_URL.
// Never fabricates: on total failure it returns ok:false and the caller says so.

import { config } from "@/lib/config";
import { planSearch } from "@/lib/search/planner";
import { querySearxng } from "@/lib/search/searxng";
import { dedupeSources } from "@/lib/search/processor";
import { fetchTopPages } from "@/lib/search/fetcher";
import { htmlToText, relevantWindows } from "@/lib/search/extractor";
import { rankSources } from "@/lib/search/rank";
import { checkConflicts, shouldEscalate } from "@/lib/search/verify";
import { researchCacheKey, ttlForQuery, TtlCache } from "@/lib/search/cache";
import { logTool } from "@/lib/database/db";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  authority: number; // 0..1 prior for source reputation
  fetched?: boolean; // page content was actually downloaded this turn
  engine?: string; // upstream engine (SearXNG) when known
  position?: number; // rank position from the provider
  retrievedAt?: string; // ISO timestamp of retrieval
}

export interface ResearchResult {
  ok: boolean;
  query: string;
  answer: string; // short synthesized extract (may be "")
  sources: WebSource[];
  /** Machine-computed verification note (agreement/conflict across sources). */
  detail?: string;
  error?: string;
}

const AUTHORITY_HOSTS: Array<[RegExp, number]> = [
  [/\.gov(\.|$)/, 0.95],
  [/\.edu(\.|$)/, 0.9],
  [/wikipedia\.org$/, 0.85],
  [/arxiv\.org$/, 0.9],
  [/github\.com$/, 0.8],
  [/(reuters|apnews|bbc|nature|science\.org|nih\.gov)\./, 0.9],
  [/docs\./, 0.8],
];

function authorityOf(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [re, score] of AUTHORITY_HOSTS) {
      if (re.test(host)) return score;
    }
    return 0.5;
  } catch {
    return 0.4;
  }
}

async function viaTavily(query: string): Promise<ResearchResult | null> {
  const key = config.tavilyKey;
  if (!key) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      max_results: 6,
      include_answer: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const sources: WebSource[] = (json.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "source",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 500),
    authority: authorityOf(r.url ?? ""),
  }));
  return { ok: true, query, answer: (json.answer ?? "").slice(0, 1500), sources };
}

async function viaDuckDuckGo(query: string): Promise<ResearchResult> {
  // 1) Instant-answer API (free, no key)
  let instant = "";
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "CAI-assistant/1.0" } }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        AbstractText?: string;
        Answer?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      instant = (json.AbstractText || json.Answer || "").slice(0, 1200);
      if (instant) {
        const sources: WebSource[] = (json.RelatedTopics ?? [])
          .filter((t) => t.FirstURL && t.Text)
          .slice(0, 4)
          .map((t) => ({
            title: (t.Text ?? "").slice(0, 120),
            url: t.FirstURL ?? "",
            snippet: (t.Text ?? "").slice(0, 400),
            authority: authorityOf(t.FirstURL ?? ""),
          }));
        if (sources.length > 0) return { ok: true, query, answer: instant, sources };
      }
    }
  } catch {
    // fall through to HTML search
  }
  // 2) HTML endpoint scrape (best-effort)
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CAI-assistant/1.0" },
    });
    if (!res.ok) throw new Error(`search http ${res.status}`);
    const html = await res.text();
    const sources: WebSource[] = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,800}?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    // Simpler robust pass: grab result links + snippets separately
    const linkRe = /result__a[^>]*href="([^"]+)"/g;
    const urls: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null && urls.length < 8) {
      try {
        const raw = m[1].replace(/&amp;/g, "&");
        const u = new URL(raw, "https://duckduckgo.com");
        const target = u.searchParams.get("uddg");
        urls.push(target ? decodeURIComponent(target) : raw);
      } catch {
        /* skip */
      }
    }
    const snipRe = /result__snippet[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    while ((m = snipRe.exec(html)) !== null && snippets.length < 8) {
      snippets.push(
        m[1].replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").slice(0, 400).trim()
      );
    }
    void re;
    const seen = new Set<string>();
    urls.forEach((url, i) => {
      if (seen.has(url) || !/^https?:\/\//.test(url)) return;
      seen.add(url);
      let title = url;
      try {
        title = new URL(url).hostname + new URL(url).pathname.slice(0, 60);
      } catch {
        /* keep url */
      }
      sources.push({
        title,
        url,
        snippet: snippets[i] ?? "",
        authority: authorityOf(url),
        position: i + 1,
      });
    });
    if (sources.length === 0 && !instant) {
      return { ok: false, query, answer: "", sources: [], error: "no results parsed" };
    }
    sources.sort((a, b) => b.authority - a.authority);
    return { ok: true, query, answer: instant, sources: sources.slice(0, 6) };
  } catch (e) {
    return {
      ok: false,
      query,
      answer: "",
      sources: [],
      error: e instanceof Error ? e.message : "search failed",
    };
  }
}

/** Wikipedia opensearch fallback — free, keyless, highly reliable. Merged in
 *  when the primary search comes back thin so entity questions still get grounding. */
async function viaWikipedia(query: string): Promise<WebSource[]> {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`,
      { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "CAI-assistant/1.0" } }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as [string, string[], string[], string[]];
    const [, titles, descriptions, urls] = json;
    return titles.slice(0, 3).map((t, i) => ({
      title: `${t} — Wikipedia`,
      url: urls[i] ?? "",
      snippet: (descriptions[i] ?? "").slice(0, 400),
      authority: 0.85,
    })).filter((s) => s.url);
  } catch {
    return [];
  }
}

/** Module-level result cache (successes only, TTL by freshness). */
const researchCache = new TtlCache<ResearchResult>();

/** Stage 2 — run providers for a bounded query list, merging results. */
async function gatherQueries(
  queries: string[],
  searxngUrl: string,
  acc: { answer: string }
): Promise<WebSource[]> {
  const sources: WebSource[] = [];
  for (const pq of queries) {
    if (searxngUrl) {
      try {
        const sx = await querySearxng(searxngUrl, pq);
        if (sx.length > 0) sources.push(...sx);
      } catch {
        // fall through to built-in providers
      }
    }
    if (sources.length === 0) {
      try {
        const premium = await viaTavily(pq);
        if (premium && premium.sources.length > 0) {
          if (!acc.answer && premium.answer) acc.answer = premium.answer;
          sources.push(...premium.sources);
        }
      } catch {
        // fall through to free tier
      }
    }
    if (sources.length === 0) {
      const free = await viaDuckDuckGo(pq);
      if (!acc.answer && free.answer) acc.answer = free.answer;
      sources.push(...free.sources);
      if (sources.length < 3) {
        const wiki = await viaWikipedia(pq);
        sources.push(...wiki);
      }
    }
    if (sources.length >= 6) break;
  }
  return sources;
}

/** Bounded escalation round (Sec 34): on conflict or thin evidence, run
 *  follow-up queries once, then merge. Never more than one extra round. */
function escalationQueries(q: string, finance: boolean): string[] {
  if (finance) {
    const m = q.match(/^(.+?)\s+(box office|collection|profit|budget|gross|net|earning)/i);
    const entity = (m ? m[1] : q).replace(/^(what is|what'?s|tell me|find|total)\s+/i, "").trim();
    return [`${entity || q} budget`, `${entity || q} trade report collection`].slice(0, 2);
  }
  return [`${q} latest update`];
}

export async function research(
  query: string,
  opts: { deep?: boolean; subTasks?: string[]; finance?: boolean } = {}
): Promise<ResearchResult> {
  const q = query.slice(0, 400);
  const depth = opts.deep ? "deep" : opts.finance ? "finance" : "quick";
  // Cache: successes only, TTL varies by freshness. Failures are never cached.
  const key = researchCacheKey(q, depth);
  const cached = researchCache.get(key);
  if (cached) {
    logTool("web_search", q, true, 0);
    return cached;
  }
  // Stage 1 — plan
  const plan = planSearch(q, { deep: opts.deep, subTasks: opts.subTasks, finance: opts.finance });

  // Stage 2 — providers. Order preserved from the previously working setup:
  // optional self-hosted SearXNG first, then Tavily, then free DDG + Wikipedia.
  // Deep/finance plans fan out to extra planned queries (bounded).
  const acc = { answer: "" };
  const searxngUrl = config.searxngUrl;
  let sources = await gatherQueries(plan.queries, searxngUrl, acc);

  // Stage 3 — process (dedupe across providers/queries)
  const stamp = new Date().toISOString();
  sources = dedupeSources(sources);
  for (const s of sources) s.retrievedAt = stamp;
  if (sources.length === 0) {
    return { ok: false, query: q, answer: "", sources: [], error: "no results from any provider" };
  }

  // Stages 4+5 — fetch top pages + extract relevant content (bounded, best-effort).
  // Failures keep the search snippet — enrichment never blocks the answer.
  try {
    const pages = await fetchTopPages(
      sources.slice(0, plan.maxPages).map((s) => s.url),
      plan.maxPages
    );
    for (const s of sources) {
      const html = pages.get(s.url);
      if (!html) continue;
      const content = relevantWindows(htmlToText(html), q);
      if (content.length > 120) {
        s.snippet = `${s.snippet}\nPage content: ${content}`.slice(0, 2000);
        s.fetched = true;
      }
    }
  } catch {
    // enrichment is optional
  }

  // Stage 6 — rank, keep top 6
  sources = rankSources(sources, q).slice(0, 6);

  // Stage 7 — verify (conflict/agreement note computed from tool output)
  let detail = plan.verify
    ? checkConflicts(sources.map((s) => ({ url: s.url, text: `${s.title} ${s.snippet}` })))
    : "";

  // Stage 8 — bounded escalation: conflict or thin evidence triggers exactly
  // one follow-up round, then merge + re-rank + re-verify.
  if (shouldEscalate(sources, detail, 1)) {
    try {
      const extra = await gatherQueries(escalationQueries(q, !!opts.finance), searxngUrl, acc);
      if (extra.length > 0) {
        const seen = new Set(sources.map((s) => s.url.toLowerCase()));
        for (const s of extra) {
          if (!seen.has(s.url.toLowerCase())) {
            seen.add(s.url.toLowerCase());
            s.retrievedAt = new Date().toISOString();
            sources.push(s);
          }
        }
        sources = rankSources(sources, q).slice(0, 8);
        const again = checkConflicts(sources.map((s) => ({ url: s.url, text: `${s.title} ${s.snippet}` })));
        if (again) detail = again;
      }
    } catch {
      // escalation is best-effort; original results stand
    }
  }

  const result: ResearchResult = { ok: true, query: q, answer: acc.answer, sources, detail: detail || undefined };
  researchCache.set(key, result, ttlForQuery(q, config.webCacheTtlMs));
  return result;
}

export function formatForPrompt(r: ResearchResult): string {
  if (!r.ok) return `Live web lookup for "${r.query}" failed (${r.error ?? "unavailable"}). Fall back to training knowledge WITH an explicit date stamp plus context (last-known figures, ranges, trends) — do NOT refuse outright and do NOT tell the user to look it up themselves.`;
  // Evidence package: sources get S1..Sn IDs. The model may cite ONLY these
  // IDs — never raw URLs it invents, never sources outside this list.
  const lines = [
    `EVIDENCE (retrieved live just now for "${r.query}"). Answer from this evidence. Cite supporting sources with their [S1]..[Sn] IDs.`,
  ];
  if (r.answer) lines.push(`Summary: ${r.answer}`);
  r.sources.slice(0, 5).forEach((s, i) => {
    lines.push(`[S${i + 1}] ${s.title} — ${s.url}\n${s.snippet}`);
  });
  if (r.detail) lines.push(r.detail);
  return lines.join("\n");
}

export function formatCitations(r: ResearchResult): string {
  if (!r.ok || r.sources.length === 0) return "";
  return r.sources
    .slice(0, 4)
    .map((s, i) => `[${i + 1}](${s.url})`)
    .join(" ");
}
