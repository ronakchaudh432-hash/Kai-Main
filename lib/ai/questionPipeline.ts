// Deep question understanding pipeline: every user question goes through
// 4 stages before hitting the LLM:
// 1. DECODE: What is being asked? (entity, attribute, domain, timeframe)
// 2. DECOMPOSE: Break complex questions into sub-questions
// 3. LOOKUP: Check cache → memory → tools (only call APIs if needed)
// 4. CONCLUDE: Merge sub-answers into one structured context block
//
// The pipeline output feeds into the orchestrator's prompt as pre-researched
// context — the LLM then synthesizes a natural answer from verified data.

import { getCachedAnswer } from "@/lib/cache/answerCache";
import { retrieveMemories } from "@/lib/memory/store";

export interface QuestionAnalysis {
  /** Original question text. */
  raw: string;
  /** What type of question is this? */
  questionType: "factual" | "opinion" | "howto" | "comparison" | "personal" | "creative" | "meta";
  /** Key entities mentioned. */
  entities: string[];
  /** Is this a follow-up to a previous question? */
  isFollowUp: boolean;
  /** Sub-questions (for complex queries). */
  subQuestions: string[];
  /** Domain of the question. */
  domain: string;
  /** Does this need current/live data? */
  needsLiveData: boolean;
}

const ENTITY_RE = /(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
const FOLLOW_UP_RE = /^(what about|and |also |how about|tell me more|more on|explain|elaborate)/i;
const COMPARISON_RE = /\b(compare|vs\.?|versus|better|which one|difference between|or)\b/i;
const HOWTO_RE = /\b(how to|how do|how can|steps to|way to|guide|tutorial)\b/i;
const OPINION_RE = /\b(should i|do you think|recommend|suggest|your opinion|what do you think|worth)\b/i;
const CREATIVE_RE = /\b(write|draft|create|compose|story|poem|essay|joke|roast)\b/i;
const META_RE = /\b(who are you|who made you|what can you|your name)\b/i;
const LIVE_RE = /\b(today|current|latest|now|price|stock|weather|score|live|2026|2025|recent|new)\b/i;

const DOMAIN_MAP: Array<{ re: RegExp; domain: string }> = [
  { re: /stock|market|nifty|sensex|share|trading|bitcoin|crypto|gold|forex/i, domain: "finance" },
  { re: /movie|film|box office|bollywood|hollywood|netflix|series|ott/i, domain: "entertainment" },
  { re: /code|programming|python|javascript|typescript|react|api|bug|error/i, domain: "technology" },
  { re: /cricket|football|ipl|match|sport|olympics/i, domain: "sports" },
  { re: /festival|diwali|holi|eid|navratri|ganesh|puja/i, domain: "culture" },
  { re: /health|doctor|medicine|symptom|exercise|diet/i, domain: "health" },
  { re: /travel|flight|hotel|trip|itinerary/i, domain: "travel" },
];

/** Stage 1: Decode the question into structured form. */
export function decodeQuestion(text: string, history: Array<{ role: string; content: string }>): QuestionAnalysis {
  const lower = text.toLowerCase();
  
  // Determine question type
  let questionType: QuestionAnalysis["questionType"] = "factual";
  if (META_RE.test(lower)) questionType = "meta";
  else if (CREATIVE_RE.test(lower)) questionType = "creative";
  else if (OPINION_RE.test(lower)) questionType = "opinion";
  else if (HOWTO_RE.test(lower)) questionType = "howto";
  else if (COMPARISON_RE.test(lower)) questionType = "comparison";
  else if (/\bmy\b|\bi\b.*\blike\b|\bprefer\b|\bfavorite\b/i.test(lower)) questionType = "personal";

  // Extract entities
  const entities: string[] = [];
  let m: RegExpExecArray | null;
  const entityRe = new RegExp(ENTITY_RE.source, 'g');
  while ((m = entityRe.exec(text)) !== null && entities.length < 5) {
    const e = m[1].trim();
    if (e.length > 1 && !/^(What|When|Where|Who|How|Why|The|This|That|Which|And|But|For|Can|Could|Should|Would|Will|Tell|Give|Show|Please|Just|Also)$/.test(e)) {
      entities.push(e);
    }
  }

  // Detect follow-up
  const isFollowUp = FOLLOW_UP_RE.test(text) || (text.length < 40 && history.length > 0 && /^(it|that|this|they|he|she)\b/i.test(text));

  // Decompose into sub-questions
  const subQuestions: string[] = [];
  if (COMPARISON_RE.test(text)) {
    const parts = text.split(/\b(?:vs\.?|versus|or|and|compared to)\b/i).map((s) => s.trim()).filter((s) => s.length > 3);
    if (parts.length >= 2) {
      subQuestions.push(...parts.slice(0, 3));
    }
  } else {
    const multiParts = text.split(/(?:,\s*(?:and\s+)?|;\s*|\s+and\s+then\s+)/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 8);
    if (multiParts.length >= 2) {
      subQuestions.push(...multiParts.slice(0, 3));
    }
  }

  // Detect domain
  let domain = "general";
  for (const { re, domain: d } of DOMAIN_MAP) {
    if (re.test(lower)) { domain = d; break; }
  }

  return {
    raw: text,
    questionType,
    entities,
    isFollowUp,
    subQuestions,
    domain,
    needsLiveData: LIVE_RE.test(lower),
  };
}

export interface PipelineContext {
  /** Pre-researched data from cache/memory (saves API calls). */
  cachedAnswer: string | null;
  /** Relevant memories from past conversations. */
  relevantMemories: string[];
  /** Analysis metadata for the prompt. */
  analysis: QuestionAnalysis;
}

/** Stage 2-3: Look up cache and memory before calling any API. */
export function preLookup(
  text: string,
  history: Array<{ role: string; content: string }>,
  userId = "default"
): PipelineContext {
  const analysis = decodeQuestion(text, history);

  // Check answer cache (Stage 2)
  let cachedAnswer: string | null = null;
  if (analysis.questionType !== "creative" && analysis.questionType !== "meta") {
    const cached = getCachedAnswer(text);
    if (cached) {
      cachedAnswer = cached.answer;
    }
  }

  // Retrieve relevant memories (Stage 3)
  const memories = retrieveMemories(text, userId, 5);
  const relevantMemories = memories.map((m) => `[${m.category}] ${m.content}`);

  return { cachedAnswer, relevantMemories, analysis };
}

/** Format pipeline context into a prompt block for the LLM. */
export function formatPipelineContext(ctx: PipelineContext): string {
  const parts: string[] = [];
  if (ctx.analysis.subQuestions.length > 0) {
    parts.push(`QUESTION DECOMPOSITION: This question has ${ctx.analysis.subQuestions.length} parts: ${ctx.analysis.subQuestions.map((q, i) => `(${i+1}) ${q}`).join(", ")}. Address each part.`);
  }
  if (ctx.analysis.isFollowUp) {
    parts.push("CONTEXT: This is a follow-up question — reference the previous conversation context.");
  }
  if (ctx.analysis.entities.length > 0) {
    parts.push(`KEY ENTITIES: ${ctx.analysis.entities.join(", ")}`);
  }
  return parts.join("\n");
}
