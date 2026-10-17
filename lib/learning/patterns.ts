// Behavior pattern detection: aggregates learning_insights into actionable
// behavior patterns that modify the system prompt. Patterns are evidence-
// based (e.g., "user corrects dates often → always search for date queries")
// and strengthened/weakened by repeated evidence.

import { getDb, uid } from "@/lib/database/db";
import { getInsights } from "@/lib/learning/insights";

export interface BehaviorPattern {
  id: string;
  pattern: string;
  evidenceCount: number;
  active: boolean;
}

/** Detect and persist behavior patterns from accumulated insights. */
export function detectPatterns(): void {
  const d = getDb();
  const now = new Date().toISOString();

  const styleInsights = getInsights("style", 50);
  const feedbackInsights = getInsights("feedback", 50);
  const topicInsights = getInsights("topic", 50);

  const patterns: Array<{ pattern: string; evidence: number }> = [];

  // Style patterns
  const hinglishCount = styleInsights.filter((i) => i.content.includes("Hinglish")).length;
  if (hinglishCount >= 3) {
    patterns.push({ pattern: "Default to Hinglish tone — user strongly prefers it", evidence: hinglishCount });
  }
  const shortCount = styleInsights.filter((i) => i.content.includes("short casual")).length;
  if (shortCount >= 5) {
    patterns.push({ pattern: "Keep answers concise — user consistently sends short messages", evidence: shortCount });
  }

  // Negative feedback patterns
  const negCount = feedbackInsights.filter((i) => i.content.startsWith("negative")).length;
  if (negCount >= 3) {
    patterns.push({ pattern: "Be more careful with factual claims — user has corrected answers multiple times", evidence: negCount });
  }

  // Topic patterns
  const topicCounts = new Map<string, number>();
  for (const t of topicInsights) {
    topicCounts.set(t.content, (topicCounts.get(t.content) ?? 0) + 1);
  }
  for (const [topic, count] of topicCounts) {
    if (count >= 3) {
      patterns.push({ pattern: `User is interested in ${topic} — bring relevant context when appropriate`, evidence: count });
    }
  }

  // Persist
  for (const p of patterns) {
    const existing = d
      .prepare("SELECT id, evidence_count FROM behavior_patterns WHERE pattern = ?")
      .get(p.pattern) as { id: string; evidence_count: number } | undefined;
    if (existing) {
      d.prepare("UPDATE behavior_patterns SET evidence_count = ?, updated_at = ? WHERE id = ?").run(
        p.evidence, now, existing.id
      );
    } else {
      d.prepare(
        "INSERT INTO behavior_patterns (id, pattern, evidence_count, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
      ).run(uid("bp_"), p.pattern, p.evidence, now, now);
    }
  }
}

/** Get active behavior patterns for the system prompt. */
export function getActivePatterns(): BehaviorPattern[] {
  return (getDb()
    .prepare("SELECT id, pattern, evidence_count, active FROM behavior_patterns WHERE active = 1 ORDER BY evidence_count DESC LIMIT 10")
    .all() as Array<{ id: string; pattern: string; evidence_count: number; active: number }>)
    .map((r) => ({ id: r.id, pattern: r.pattern, evidenceCount: r.evidence_count, active: r.active === 1 }));
}

/** Format patterns into a prompt block. */
export function learningBlock(): string {
  const patterns = getActivePatterns();
  if (patterns.length === 0) return "";
  return (
    "LEARNED BEHAVIORS (accumulated from past conversations — apply automatically):\n" +
    patterns.map((p) => `- ${p.pattern}`).join("\n")
  );
}
