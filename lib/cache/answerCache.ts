// Answer cache: SQLite-backed cache for full AI responses. When the same
// (or very similar) question is asked again, serve the cached answer
// instantly — zero API cost, sub-millisecond latency. Failures and
// corrections are never cached. Time-sensitive queries expire fast.

import { getDb, uid } from "@/lib/database/db";

const STOP = new Set(
  "the,a,an,and,or,but,is,are,was,were,be,been,to,of,in,on,for,with,as,at,by,from,it,this,that,these,those,i,you,he,she,we,they,me,him,her,us,them,my,your,his,our,their,what,when,where,which,who,how,why,do,does,did,can,could,should,would,will,just,very,so,too,also,not,no,yes,if,then,than,there,here,about,into,over,after,before,between,up,down,out,off,again,once,please,tell,give,show,write,make,me,know,want".split(",")
);

/** Normalize a question into a canonical form for cache matching. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .sort()
    .join(" ")
    .trim()
    .slice(0, 300);
}

/** Simple string hash for fast index lookups. */
export function hashQuestion(normalized: string): string {
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) - h + normalized.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

const LIVE_RE =
  /stock|price|nifty|sensex|bitcoin|crypto|weather|score|live|breaking|today|right now/i;

function categoryTtl(category: string, raw: string): number {
  if (LIVE_RE.test(raw)) return 60 * 60_000; // 1 hour for live data
  if (category === "research" || category === "current_info") return 6 * 60 * 60_000; // 6 hours
  return 24 * 60 * 60_000; // 24 hours for general
}

export interface CachedAnswer {
  id: string;
  answer: string;
  sources: Array<{ title: string; url: string }> | null;
  model: string;
  hitCount: number;
}

/** Look up a cached answer for the given question. Returns null on miss. */
export function getCachedAnswer(question: string): CachedAnswer | null {
  const norm = normalizeQuestion(question);
  if (norm.length < 4) return null; // too short to meaningfully cache
  const hash = hashQuestion(norm);
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM answer_cache WHERE question_hash = ? ORDER BY hit_count DESC LIMIT 1")
    .get(hash) as {
      id: string;
      question_normalized: string;
      answer: string;
      sources: string | null;
      model: string;
      created_at: string;
      ttl_ms: number;
      hit_count: number;
    } | undefined;
  if (!row) return null;
  // Check TTL
  const age = Date.now() - Date.parse(row.created_at);
  if (age > row.ttl_ms) {
    d.prepare("DELETE FROM answer_cache WHERE id = ?").run(row.id);
    return null;
  }
  // Check normalized similarity (sorted words must match)
  if (row.question_normalized !== norm) return null;
  // Update hit count
  d.prepare("UPDATE answer_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );
  let sources: Array<{ title: string; url: string }> | null = null;
  try {
    if (row.sources) sources = JSON.parse(row.sources);
  } catch { /* ignore */ }
  return { id: row.id, answer: row.answer, sources, model: row.model, hitCount: row.hit_count + 1 };
}

/** Save an answer to the cache. */
export function cacheAnswer(opts: {
  question: string;
  answer: string;
  sources?: Array<{ title: string; url: string }> | null;
  model: string;
  category: string;
}): void {
  const norm = normalizeQuestion(opts.question);
  if (norm.length < 4 || opts.answer.length < 10) return;
  const hash = hashQuestion(norm);
  const d = getDb();
  // Upsert: if same hash+norm exists, update the answer
  const existing = d
    .prepare("SELECT id FROM answer_cache WHERE question_hash = ? AND question_normalized = ?")
    .get(hash, norm) as { id: string } | undefined;
  const now = new Date().toISOString();
  const ttl = categoryTtl(opts.category, opts.question);
  if (existing) {
    d.prepare(
      "UPDATE answer_cache SET answer = ?, sources = ?, model = ?, created_at = ?, ttl_ms = ? WHERE id = ?"
    ).run(
      opts.answer, opts.sources ? JSON.stringify(opts.sources) : null,
      opts.model, now, ttl, existing.id
    );
  } else {
    // Evict oldest if cache is full (keep max 500)
    const count = (d.prepare("SELECT COUNT(*) as c FROM answer_cache").get() as { c: number }).c;
    if (count >= 500) {
      d.prepare(
        "DELETE FROM answer_cache WHERE id IN (SELECT id FROM answer_cache ORDER BY last_hit_at ASC, created_at ASC LIMIT 50)"
      ).run();
    }
    d.prepare(
      "INSERT INTO answer_cache (id, question_normalized, question_hash, answer, sources, model, category, created_at, ttl_ms, hit_count, last_hit_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)"
    ).run(
      uid("ac_"), norm, hash, opts.answer,
      opts.sources ? JSON.stringify(opts.sources) : null,
      opts.model, opts.category, now, ttl
    );
  }
}

/** Clear the entire answer cache. */
export function clearAnswerCache(): number {
  const res = getDb().prepare("DELETE FROM answer_cache").run();
  return Number((res as { changes?: unknown }).changes ?? 0);
}
