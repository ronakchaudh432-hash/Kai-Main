// Selective memory extraction: learns from everything, retains only what has
// genuine future value. Fast heuristic path runs synchronously; an optional
// LLM pass refines in the background (best-effort, never blocks responses).

import { saveMemory } from "@/lib/memory/store";

export interface ExtractedMemory {
  content: string;
  category: string;
  importance: number;
  confidence: number;
}

const SENSITIVE_RE =
  /(password|passwd|secret key|api[_-]?key|credit card|card number|cvv|ssn|social security|bank account|otp|private key|seed phrase)/i;

const EXPLICIT_RE =
  /^(please\s+)?(remember|don't forget|do not forget|keep in mind|note? that|make a note)\b[:\s,]*([\s\S]{4,400})$/i;

const PREFERENCE_PATTERNS: Array<{ re: RegExp; category: string; importance: number }> = [
  { re: /\bmy favorite\b([\s\S]{2,200})/i, category: "preference", importance: 0.8 },
  { re: /\bmy favourite\b([\s\S]{2,200})/i, category: "preference", importance: 0.8 },
  { re: /\bi prefer\b([\s\S]{2,200})/i, category: "preference", importance: 0.8 },
  { re: /\bi (like|love)\b([\s\S]{2,200})/i, category: "preference", importance: 0.6 },
  { re: /\bi (dislike|hate)\b([\s\S]{2,200})/i, category: "preference", importance: 0.6 },
  { re: /\bwhenever i\b([\s\S]{2,200})/i, category: "instruction", importance: 0.9 },
  { re: /\balways\b([\s\S]{2,200})/i, category: "instruction", importance: 0.85 },
  { re: /\bmy name is\b([\s\S]{2,120})/i, category: "personal_context", importance: 0.9 },
  { re: /\bi am a\b([\s\S]{2,200})/i, category: "personal_context", importance: 0.7 },
  { re: /\bi work (as|at|on)\b([\s\S]{2,200})/i, category: "personal_context", importance: 0.7 },
  { re: /\bi'?m building\b([\s\S]{2,200})/i, category: "project", importance: 0.8 },
  { re: /\bmy (project|channel|website|app|startup|goal)\b([\s\S]{2,200})/i, category: "project", importance: 0.75 },
  { re: /\bmy goal is\b([\s\S]{2,200})/i, category: "goal", importance: 0.8 },
  { re: /\bi use\b([\s\S]{2,200})/i, category: "technical_context", importance: 0.55 },
];

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[.?!]+$/, "").trim();
}

/** Synchronous heuristic extraction. Returns [] for anything not worth keeping. */
export function extractHeuristic(userText: string): ExtractedMemory[] {
  const text = userText.trim();
  if (text.length < 8 || SENSITIVE_RE.test(text)) return [];
  // Explicit "remember this" — highest priority, but still filtered
  const explicit = text.match(EXPLICIT_RE);
  if (explicit?.[3]) {
    const content = clean(explicit[3]).replace(/^(that|this)\s+/i, "");
    if (content.length < 4 || SENSITIVE_RE.test(content)) return [];
    if (/^(that|this|it)$/i.test(content)) return [];
    return [{ content, category: "instruction", importance: 0.9, confidence: 0.95 }];
  }
  // "Forget that ..." → handled by caller as deletion signal, not storage
  if (/^(forget|delete|remove).*(that|this|memory|memories)/i.test(text)) return [];

  const out: ExtractedMemory[] = [];
  for (const p of PREFERENCE_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const content = clean(m[0]);
      if (content.length > 6 && content.length < 300 && !SENSITIVE_RE.test(content)) {
        out.push({
          content,
          category: p.category,
          importance: p.importance,
          confidence: 0.75,
        });
      }
    }
    if (out.length >= 2) break;
  }
  return out;
}

export function isForgetRequest(text: string): boolean {
  return /^(forget|delete|remove|clear).*(that|this|memory|memories|everything|all)/i.test(text.trim());
}

/** Persist heuristic extractions. Returns count saved. */
export function persistHeuristicMemories(
  userText: string,
  conversationId: string | null
): number {
  try {
    const found = extractHeuristic(userText);
    for (const f of found) {
      saveMemory({ ...f, sourceConversationId: conversationId });
    }
    return found.length;
  } catch {
    return 0;
  }
}
