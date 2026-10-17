// Selective long-term memory: retrieval (ranked, top-k only) + CRUD.
// Never dumps the whole table into a prompt — every query retrieves at most
// a small relevant subset scored by keyword overlap, importance, and recency.

import { getDb, uid, type Memory } from "@/lib/database/db";

export type MemoryCategory =
  | "preference"
  | "instruction"
  | "project"
  | "goal"
  | "workflow"
  | "technical_context"
  | "personal_context"
  | "other";

const STOP = new Set(
  "the,a,an,and,or,but,is,are,was,were,be,been,to,of,in,on,for,with,as,at,by,from,it,this,that,these,those,i,you,he,she,we,they,me,him,her,us,them,my,your,his,our,their,what,when,where,which,who,how,why,do,does,did,can,could,should,would,will,just,very,so,too,also,not,no,yes,if,then,than,there,here,about,into,over,after,before,between,up,down,out,off,again,once,please,tell,give,show,write,make".split(
    ","
  )
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

function scoreMemory(m: Memory, queryKeys: Set<string>, now: number): number {
  const contentKeys = keywords(m.content);
  let overlap = 0;
  for (const k of queryKeys) if (contentKeys.has(k)) overlap++;
  if (overlap === 0) return 0;
  const coverage = overlap / Math.max(1, queryKeys.size);
  const updated = Date.parse(m.updated_at || m.created_at) || now;
  const ageDays = Math.max(0, (now - updated) / 86_400_000);
  const recency = Math.exp(-ageDays / 180); // half-life-ish decay
  return overlap * 2 + coverage * 3 + m.importance * 2 + m.confidence + recency * 0.5;
}

export function retrieveMemories(
  query: string,
  userId = "default",
  limit = 5
): Memory[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY importance DESC LIMIT 200")
    .all(userId) as unknown as Memory[];
  const qk = keywords(query);
  if (qk.size === 0) return [];
  const now = Date.now();
  const ranked = rows
    .map((m) => ({ m, s: scoreMemory(m, qk, now) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  if (ranked.length > 0) {
    const stmt = d.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
    const nowIso = new Date().toISOString();
    for (const r of ranked) {
      try {
        stmt.run(nowIso, r.m.id);
      } catch {
        /* ignore */
      }
    }
  }
  return ranked.map((r) => r.m);
}

export function listMemories(userId = "default", limit = 100): Memory[] {
  return getDb()
    .prepare(
      "SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?"
    )
    .all(userId, limit) as unknown as Memory[];
}

export function saveMemory(entry: {
  content: string;
  category?: string;
  importance?: number;
  confidence?: number;
  userId?: string;
  sourceConversationId?: string | null;
}): Memory {
  const d = getDb();
  const now = new Date().toISOString();
  // Dedupe: same normalized content → touch instead of duplicating
  const norm = entry.content.trim().toLowerCase();
  const existing = (
    d.prepare("SELECT * FROM memories WHERE user_id = ? LIMIT 200").all(entry.userId ?? "default") as unknown as Memory[]
  ).find((m) => m.content.trim().toLowerCase() === norm);
  if (existing) {
    d.prepare("UPDATE memories SET updated_at = ?, importance = ? WHERE id = ?").run(
      now,
      Math.max(existing.importance, entry.importance ?? existing.importance),
      existing.id
    );
    return { ...existing, updated_at: now };
  }
  const m: Memory = {
    id: uid("mem_"),
    user_id: entry.userId ?? "default",
    content: entry.content.trim().slice(0, 2000),
    category: entry.category ?? "other",
    importance: entry.importance ?? 0.6,
    confidence: entry.confidence ?? 0.7,
    created_at: now,
    updated_at: now,
    last_used_at: null,
    source_conversation_id: entry.sourceConversationId ?? null,
  };
  d.prepare(
    "INSERT INTO memories (id, user_id, content, category, importance, confidence, created_at, updated_at, last_used_at, source_conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    m.id, m.user_id, m.content, m.category, m.importance, m.confidence,
    m.created_at, m.updated_at, m.last_used_at, m.source_conversation_id
  );
  return m;
}

export function updateMemory(id: string, patch: { content?: string; category?: string; importance?: number }): boolean {
  const d = getDb();
  const parts: string[] = [];
  const vals: unknown[] = [];
  if (patch.content !== undefined) {
    parts.push("content = ?");
    vals.push(patch.content.slice(0, 2000));
  }
  if (patch.category !== undefined) {
    parts.push("category = ?");
    vals.push(patch.category);
  }
  if (patch.importance !== undefined) {
    parts.push("importance = ?");
    vals.push(patch.importance);
  }
  if (parts.length === 0) return false;
  parts.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  const res = d.prepare(`UPDATE memories SET ${parts.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  return Number((res as { changes?: unknown }).changes ?? 0) > 0;
}

export function deleteMemory(id: string, userId = "default"): boolean {
  const res = getDb().prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").run(id, userId);
  return Number((res as { changes?: unknown }).changes ?? 0) > 0;
}

export function clearMemories(userId = "default"): number {
  const res = getDb().prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  return Number((res as { changes?: unknown }).changes ?? 0);
}

export function getPreferences(userId = "default"): Record<string, string> {
  const rows = getDb()
    .prepare(
      "SELECT content FROM memories WHERE user_id = ? AND category IN ('preference','instruction') ORDER BY importance DESC LIMIT 30"
    )
    .all(userId) as Array<{ content: string }>;
  const prefs: Record<string, string> = {};
  rows.forEach((r, i) => {
    prefs[`saved_${i + 1}`] = r.content;
  });
  // Explicit settings override/add
  try {
    const d = getDb();
    const srows = d.prepare("SELECT key, value FROM user_settings").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const s of srows) {
      if (s.key.startsWith("pref_") && s.value) prefs[s.key] = s.value;
    }
  } catch {
    /* ignore */
  }
  return prefs;
}
