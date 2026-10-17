// Self-learning: extracts insights from every conversation turn so CAI
// gets smarter over time. Insights cover communication style, topic
// interests, feedback signals, and knowledge areas. Pure extraction
// functions + SQLite persistence. Runs asynchronously after each turn.

import { getDb, uid } from "@/lib/database/db";

export type InsightType = "style" | "topic" | "feedback" | "knowledge" | "preference";

export interface Insight {
  type: InsightType;
  content: string;
  confidence: number;
}

const POSITIVE_RE = /\b(thanks|thank you|perfect|great|nice|awesome|exactly|correct|good|love it|well done|amazing|shukriya|dhanyavaad|bahut accha|mast)\b/i;
const NEGATIVE_RE = /\b(wrong|incorrect|not right|bad|terrible|useless|galat|sahi nahi|theek nahi|nope|no that'?s wrong)\b/i;
const HINGLISH_RE = /\b(kya|kaise|kaisa|tum|aap|main|mein|hai|nahi|bhai|yaar|matlab|kaam|batao|bata|accha)\b/i;

/** Extract insights from a single user message + assistant response. */
export function extractInsights(userText: string, assistantText: string): Insight[] {
  const out: Insight[] = [];
  const lower = userText.toLowerCase();

  // Style detection
  if (HINGLISH_RE.test(userText)) {
    out.push({ type: "style", content: "user prefers Hinglish communication", confidence: 0.7 });
  }
  if (userText.length < 30 && !/[.!]$/.test(userText.trim())) {
    out.push({ type: "style", content: "user prefers short casual messages", confidence: 0.5 });
  }

  // Feedback signals
  if (POSITIVE_RE.test(lower)) {
    out.push({ type: "feedback", content: `positive feedback on: ${assistantText.slice(0, 80)}`, confidence: 0.8 });
  }
  if (NEGATIVE_RE.test(lower)) {
    out.push({ type: "feedback", content: `negative feedback on: ${assistantText.slice(0, 80)}`, confidence: 0.85 });
  }

  // Topic interest
  const topicPatterns: Array<{ re: RegExp; topic: string }> = [
    { re: /stock|market|nifty|sensex|share|trading/i, topic: "financial markets" },
    { re: /movie|film|box office|collection|bollywood|hollywood/i, topic: "movies & entertainment" },
    { re: /code|programming|python|javascript|react|api/i, topic: "programming & tech" },
    { re: /cricket|football|ipl|match|sport/i, topic: "sports" },
    { re: /ai|model|gpt|gemini|llm/i, topic: "artificial intelligence" },
    { re: /startup|business|funding|company/i, topic: "business & startups" },
  ];
  for (const { re, topic } of topicPatterns) {
    if (re.test(lower)) {
      out.push({ type: "topic", content: topic, confidence: 0.65 });
    }
  }

  return out.slice(0, 4); // max 4 insights per turn
}

/** Persist insights to SQLite. Deduplicates by content. */
export function saveInsights(insights: Insight[], conversationId: string): void {
  if (insights.length === 0) return;
  const d = getDb();
  const now = new Date().toISOString();
  for (const ins of insights) {
    // Dedupe: don't store the same insight twice
    const existing = d
      .prepare("SELECT id FROM learning_insights WHERE insight_type = ? AND content = ? LIMIT 1")
      .get(ins.type, ins.content) as { id: string } | undefined;
    if (existing) continue;
    d.prepare(
      "INSERT INTO learning_insights (id, conversation_id, insight_type, content, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uid("li_"), conversationId, ins.type, ins.content, ins.confidence, now);
  }
}

/** Get recent insights of a given type. */
export function getInsights(type: InsightType, limit = 20): Array<{ content: string; confidence: number }> {
  return getDb()
    .prepare("SELECT content, confidence FROM learning_insights WHERE insight_type = ? ORDER BY created_at DESC LIMIT ?")
    .all(type, limit) as Array<{ content: string; confidence: number }>;
}

/** Get all insight types with counts for the learning summary. */
export function getInsightsSummary(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT insight_type, COUNT(*) as c FROM learning_insights GROUP BY insight_type")
    .all() as Array<{ insight_type: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.insight_type] = r.c;
  return out;
}
