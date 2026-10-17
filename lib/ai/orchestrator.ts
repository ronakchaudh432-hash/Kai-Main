// AI orchestrator: the full server-side pipeline.
//
// Frontend → /api/chat → orchestrate() → Intent → Memory retrieval →
// Context builder → Tool router → Groq provider (multi-key pool) →
// Response stream → background memory extraction + title + summary.

import type { ChatMessage } from "@/lib/ai/provider";
import { streamWithFailover } from "@/lib/ai/providers";
import { classifyIntent, isCorrection, looksLikeFinance, type Intent } from "@/lib/ai/intent";
import { groqKeyPool } from "@/lib/ai/keyPool";
import {
  behaviorBlock,
  buildSystemPrompt,
  financeBlock,
  getParts,
  identityBlock,
  memoriesBlock,
  preferencesBlock,
} from "@/lib/ai/prompts";
import {
  addMessage,
  getRecentMessages,
  getSummary,
  setSummary,
  getConversation,
  renameConversation,
  logUsage,
  getSetting,
  logTool,
} from "@/lib/database/db";
import { getPreferences, retrieveMemories } from "@/lib/memory/store";
import { isForgetRequest, persistHeuristicMemories } from "@/lib/memory/extract";
import { answerIdentityQuestion } from "@/lib/ai/identity";
import { renderCitations, sanitizeCitations } from "@/lib/search/citations";
import {
  extractStockQuery,
  fetchMarketstackQuotes,
  fetchQuotes,
  formatQuotes,
  type Quote,
} from "@/lib/tools/stocks";
import { research, formatForPrompt } from "@/lib/search/web";
import { calculate, extractExpression, looksLikeMath } from "@/lib/tools/calculator";
import { config } from "@/lib/config";

export type ResearchStatus =
  | "not_needed"
  | "verified"
  | "partially_verified"
  | "conflicting"
  | "insufficient"
  | "failed";

export type StreamEvent =
  | { type: "state"; state: string }
  | { type: "token"; token: string }
  | {
      type: "done";
      full: string;
      memorySaved: boolean;
      /** Actually-retrieved sources for frontend display (never fabricated). */
      sources?: Array<{ title: string; url: string }>;
      /** False when research ran but live verification failed. */
      researchOk?: boolean;
      /** Structured research outcome vocabulary (Step 42). */
      researchStatus?: ResearchStatus;
    }
  | { type: "error"; message: string };

export interface OrchestratorCallbacks {
  emit: (e: StreamEvent) => void;
  signal?: AbortSignal;
}

function historyToText(
  messages: Array<{ role: string; content: string }>
): string {
  return messages
    .slice(-12)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
}

function titleFromExchange(user: string, assistant: string): string {
  const base = `${user} ${assistant}`.replace(/\s+/g, " ").trim();
  const words = base.split(" ").filter(Boolean).slice(0, 6).join(" ");
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.slice(0, 60) || "New chat";
}

/** Server-side "today" anchor (Asia/Kolkata default). The model must never
 *  reason about current dates from training time. */
function currentDateAnchor(): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });
    return `Current date: ${fmt.format(new Date())} (Asia/Kolkata, server time). Anchor ALL "today / current / this year / upcoming" reasoning to this date — never to training-time dates.\n`;
  } catch {
    return `Current date: ${new Date().toISOString().slice(0, 10)} (UTC, server time). Anchor ALL current-date reasoning to this date.\n`;
  }
}

/** True when every configured key is cooling down or disabled (burst storm)
 *  — deserves a friendly "give me a moment", not a raw provider error. */
function isPoolExhausted(): boolean {
  try {
    const s = groqKeyPool.statuses();
    return s.length > 0 && s.every((k) => k.health !== "healthy");
  } catch {
    return false;
  }
}

export interface ResearchOutcome {
  /** Prompt-ready research block ("" when no search was needed). */
  text: string;
  /** A real tool call executed this turn (the 6B search-before-answer gate). */
  performed: boolean;
  /** The call returned usable sources. */
  ok: boolean;
  /** Source URLs actually returned — the ONLY names the model may cite. */
  sourceUrls: string[];
  /** Title + URL pairs for frontend display (retrieved only, never invented). */
  sourceList: Array<{ title: string; url: string }>;
  /** Machine-detected cross-source conflict in this turn's evidence. */
  conflicting: boolean;
}

async function maybeResearch(
  intent: Intent,
  userText: string,
  history: Array<{ role: string; content: string }>,
  correctionCount: number,
  emit: (e: StreamEvent) => void
): Promise<ResearchOutcome> {
  const none: ResearchOutcome = { text: "", performed: false, ok: false, sourceUrls: [], sourceList: [], conflicting: false };
  if (!intent.needsWeb || !config.webSearchEnabled) return none;
  emit({ type: "state", state: "searching" });
  // On correction ("wrong"), re-search the ORIGINAL question fresh — never
  // re-answer from the previous turn. Find the last substantive user message.
  let query = userText.slice(0, 300);
  if (isCorrection(userText)) {
    const prior = [...history]
      .reverse()
      .find(
        (m) =>
          m.role === "user" &&
          !isCorrection(m.content) &&
          m.content.trim().length > 3
      );
    if (prior) query = `verify with multiple sources: ${prior.content.slice(0, 250)}`;
  } else if (intent.subTasks.length > 0) {
    query = userText.slice(0, 200);
  }
  try {
    const r = await research(query, {
      deep: intent.category === "research",
      subTasks: intent.subTasks,
      finance: looksLikeFinance(query),
    });
    const sourceUrls = r.sources.map((s) => s.url).filter(Boolean);
    let text = formatForPrompt(r);
    if (correctionCount > 0) {
      text +=
        `\n\nCORRECTION CONTEXT: the user says the previous answer was WRONG (correction #${correctionCount + 1} on this question). ` +
        `Do NOT restate or lightly rephrase the previous answer. Re-verify the claim against the sources above — for any date or figure, at least 2 independent sources must agree. ` +
        `If sources conflict, state the range with each source named. If the sources cannot confirm it, say so honestly — guessing again is forbidden.` +
        (correctionCount >= 2
          ? ` CIRCUIT BREAKER ACTIVE: this is correction #${correctionCount + 1}. You are FORBIDDEN from stating another unverified date/figure. Either cite 2+ agreeing sources from above, or reply that you cannot confirm this reliably right now.`
          : "");
    }
    if (sourceUrls.length > 0) {
      text +=
        `\n\nGROUNDED SOURCES — citation integrity rule: you may name or cite ONLY these exact sources (they are what the tool actually returned this turn). Naming any other site, publication, panchang, or database as your source is forbidden, even if it sounds plausible:\n` +
        sourceUrls.slice(0, 6).map((u) => `- ${u}`).join("\n");
    }
    const sourceList = r.sources
      .slice(0, 5)
      .filter((s) => s.url)
      .map((s) => ({ title: s.title || s.url, url: s.url }));
    const conflicting = (r.detail ?? "").includes("CONFLICT");
    return { text, performed: true, ok: r.ok && sourceUrls.length > 0, sourceUrls, sourceList, conflicting };
  } catch {
    return {
      text: `Live web lookup failed unexpectedly for "${query}". You have NO verified data. No confident dates/figures, no celebratory tone, no emojis on the claim. Give date-stamped training knowledge with context, or say verification failed.`,
      performed: true,
      ok: false,
      sourceUrls: [],
      sourceList: [],
      conflicting: false,
    };
  }
}

export async function orchestrate(
  conversationId: string,
  userText: string,
  cb: OrchestratorCallbacks
): Promise<void> {
  const started = Date.now();
  const { emit, signal } = cb;
  let toolsUsed = "";
  let retries = 0;

  try {
    emit({ type: "state", state: "thinking" });

    const conv = getConversation(conversationId);
    if (!conv) {
      emit({ type: "error", message: "Conversation not found." });
      return;
    }

    // Persist the user turn first (so reloads never lose it)
    addMessage(conversationId, "user", userText);

    const intent = classifyIntent(userText);
    const memoryEnabled = getSetting("memory_enabled", "1") === "1";

    // ---- Fast path: pure math → direct calculation, no model call
    if (intent.category === "mathematics" && looksLikeMath(userText)) {
      emit({ type: "state", state: "processing" });
      try {
        const expr = extractExpression(userText);
        const value = calculate(expr);
        const pretty = Number.isInteger(value)
          ? value.toLocaleString("en-US")
          : String(Math.round(value * 1e10) / 1e10);
        const full = `${expr.trim()} = ${pretty}`;
        addMessage(conversationId, "assistant", full, { direct: "calculator" });
        emit({ type: "token", token: full });
        emit({ type: "done", full, memorySaved: false });
        logUsage({ keyId: "local", model: "calculator", success: true, latencyMs: Date.now() - started, retryCount: 0, toolUsage: "calculator" });
        return;
      } catch {
        // fall through to the model with tool context
      }
    }

    // ---- Forget-request path (memory control stays with the user)
    if (memoryEnabled && isForgetRequest(userText)) {
      const { clearMemories } = await import("@/lib/memory/store");
      const n = clearMemories("default");
      const full = n > 0
        ? `Done — I've cleared ${n} stored ${n === 1 ? "memory" : "memories"}. I won't use them going forward.`
        : "There's nothing stored to clear — my memory is already empty.";
      addMessage(conversationId, "assistant", full, { direct: "memory-clear" });
      emit({ type: "token", token: full });
      emit({ type: "done", full, memorySaved: false });
      return;
    }

    // ---- Persist explicit/heuristic memories immediately: they're derived
    // from the user message alone, so a downstream AI failure must never
    // lose a "remember this".
    let memorySaved = false;
    try {
      if (memoryEnabled && (intent.needsMemory || intent.category === "memory_request")) {
        memorySaved = persistHeuristicMemories(userText, conversationId) > 0;
      }
    } catch {
      memorySaved = false;
    }

    // ---- Identity fast-path: creator/owner questions are answered
    // deterministically from config (never model guesswork or memory), so
    // "who made you" always returns the owner — even with no AI backend.
    const identityAnswer = answerIdentityQuestion(
      userText,
      config.assistantName,
      config.ownerName,
      config.groqModel
    );
    if (identityAnswer) {
      addMessage(conversationId, "assistant", identityAnswer, { direct: "identity" });
      emit({ type: "token", token: identityAnswer });
      try {
        if (conv.title === "New chat") {
          renameConversation(conversationId, titleFromExchange(userText, identityAnswer));
        }
      } catch {
        /* ignore */
      }
      emit({ type: "done", full: identityAnswer, memorySaved });
      logUsage({ keyId: "local", model: "identity", success: true, latencyMs: Date.now() - started, retryCount: 0, toolUsage: "identity" });
      return;
    }

    // ---- Context assembly: history + summary + relevant memories
    const history = getRecentMessages(conversationId, 40);
    const summary = history.length > 30 ? getSummary(conversationId) : "";
    const prefs = memoryEnabled ? getPreferences("default") : {};
    const memories = memoryEnabled
      ? retrieveMemories(userText, "default", 5)
      : [];

    // ---- Tools: live research only when the intent needs current data.
    // 6B gate inputs: whether a real tool call ran, whether it returned
    // sources, and how many corrections preceded this turn.
    const historyMsgs = history.map((m) => ({ role: m.role, content: m.content }));
    const correctionCount = historyMsgs.filter(
      (m) => m.role === "user" && isCorrection(m.content)
    ).length;
    // ---- Stocks fast lane: premium (Marketstack EOD for stocks) first,
    // free Yahoo lane for the rest (indices/forex/crypto/commodities +
    // anything premium missed). Unknown symbols fall through to research.
    // Honored only when live research is enabled (kill-switch).
    let retrieved = "";
    let sourceUrls: string[] = [];
    let sourceList: Array<{ title: string; url: string }> = [];
    let researchOk = false;
    let researchPerformed = false;
    let researchConflicting = false;
    // Finance mode: box-office/profit/collection queries get the FINANCE
    // evidence rules plus entity/budget query variants.
    const financeMode = intent.needsWeb && looksLikeFinance(userText);
    const stockEntries =
      intent.needsWeb && config.webSearchEnabled ? extractStockQuery(userText) : null;
    if (stockEntries && stockEntries.length > 0) {
      emit({ type: "state", state: "searching" });
      try {
        const quotes: Quote[] = await fetchMarketstackQuotes(stockEntries);
        const covered = new Set(quotes.map((q) => q.label));
        const rest = stockEntries.filter((e) => !covered.has(e.label));
        if (rest.length > 0) quotes.push(...(await fetchQuotes(rest)));
        if (quotes.length > 0) {
          retrieved =
            `Live market data (structured quote feed — treat these figures as verified current and cite the quote links):\n` +
            formatQuotes(quotes);
          toolsUsed = "stocks";
          researchPerformed = true;
          researchOk = true;
          sourceUrls = quotes.map((q) => q.url).filter(Boolean);
          sourceList = quotes
            .filter((q) => q.url)
            .slice(0, 5)
            .map((q) => ({ title: `${q.label} (${q.symbol})`, url: q.url }));
        }
      } catch {
        // fall through to web research
      }
    }

    if (!retrieved) {
      const research = await maybeResearch(intent, userText, historyMsgs, correctionCount, emit);
      retrieved = research.text;
      if (research.performed) {
        toolsUsed = intent.category === "research" ? "web_search(deep)" : "web_search";
        researchPerformed = true;
        researchOk = research.ok;
        researchConflicting = research.conflicting;
        sourceUrls = research.sourceUrls;
        sourceList = research.sourceList;
        // Rule 1 — search-before-answer gate: mandatory topic + zero live
        // sources means confident factual claims are forbidden this turn.
        if (intent.mandatorySearch && !research.ok) {
          retrieved +=
            `\n\nVERIFICATION GATE (mandatory-search topic, NO live sources this turn): ` +
            `a confident date, figure, release-status, or source claim is FORBIDDEN in this response. ` +
            `You must: (1) say plainly you could not verify live, (2) give only date-stamped training knowledge with context, ` +
            `(3) keep phrasing calm and hedged with no celebration and no emojis attached to the claim, (4) name NO source.`;
        }
      }
    }

    emit({ type: "state", state: "processing" });

    const behavior =
      behaviorBlock(intent) + (financeMode ? `\n${financeBlock()}` : "");
    const parts = getParts({
      behavior,
      preferences: preferencesBlock(prefs),
      memories: memoriesBlock(memories),
      conversation:
        currentDateAnchor() +
        (summary ? `Earlier summary: ${summary.slice(0, 1500)}\n` : "") +
        historyToText(historyMsgs),
      retrieved,
      request: userText,
    });
    const system = buildSystemPrompt(parts);

    const messages: ChatMessage[] = [
      { role: "system", content: `${system}\n\n${identityBlock()}`.slice(0, 12000) },
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content.slice(0, 4000),
        })),
      { role: "user", content: userText.slice(0, 8000) },
    ];

    emit({ type: "state", state: "writing" });
    let full = "";
    let usedProvider = "groq";
    let usedModel = config.groqModel;
    try {
      const result = await streamWithFailover(messages, {
        signal,
        onRetry: () => {
          retries += 1;
        },
        onToken: (t) => emit({ type: "token", token: t }),
      });
      full = result.text;
      usedProvider = result.provider;
      usedModel = result.model;
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "The AI request failed unexpectedly.";
      logUsage({
        keyId: "pool", model: usedModel, success: false,
        latencyMs: Date.now() - started, retryCount: retries, toolUsage: toolsUsed,
      });
      emit({
        type: "error",
        message: isPoolExhausted()
          ? "I'm being rate-limited on all my keys right now — give me about 30 seconds and try again."
          : `I couldn't reach the AI service: ${message}`,
      });
      return;
    }

    if (!full.trim()) {
      emit({ type: "error", message: "The AI returned an empty response. Please try again." });
      return;
    }

    // Citation validation (Step 18/36): the streamed text already went out
    // token-by-token, so violations can't be un-shown — but the persisted +
    // final version is sanitized (unknown markdown-link URLs demoted to plain
    // text, bad [Sn] ids dropped, valid [Sn] rendered as clickable links)
    // and violations are logged for inspection.
    if (sourceUrls.length > 0) {
      try {
        const check = sanitizeCitations(full, sourceUrls.map((url) => ({ url })));
        if (!check.valid) {
          full = check.text;
          logTool("citation_check", `removed ${check.removed.length}: ${check.removed.slice(0, 3).join(" | ").slice(0, 500)}`, false, 0);
        }
        full = renderCitations(full, sourceUrls.map((url) => ({ url })));
      } catch {
        /* never break a good answer on validator failure */
      }
    }

    // Structured research outcome vocabulary (Step 42, additive).
    const researchStatus: ResearchStatus = !researchPerformed
      ? "not_needed"
      : !researchOk
        ? intent.mandatorySearch
          ? "insufficient"
          : "failed"
        : researchConflicting
          ? "conflicting"
          : sourceList.length >= 2
            ? "verified"
            : "partially_verified";

    addMessage(conversationId, "assistant", full, {
      model: `${usedProvider}:${usedModel}`,
      tools: toolsUsed,
      // Compact research metadata for the Sources UI (never raw pages).
      sources: sourceList,
      researchOk: researchPerformed ? researchOk : undefined,
      researchStatus: researchPerformed ? researchStatus : undefined,
    });
    logUsage({
      keyId: usedProvider, model: usedModel, success: true,
      latencyMs: Date.now() - started, retryCount: retries, toolUsage: toolsUsed,
    });

    // ---- Background-quality work, done inline but failure-proof
    try {
      if (conv.title === "New chat" && history.length <= 2) {
        renameConversation(conversationId, titleFromExchange(userText, full));
      }
    } catch {
      /* ignore */
    }
    try {
      const all = [...history.map((m) => `${m.role}: ${m.content.slice(0, 500)}`), `user: ${userText.slice(0, 500)}`, `assistant: ${full.slice(0, 800)}`];
      if (all.length > 24) {
        setSummary(
          conversationId,
          `Main topic: ${userText.slice(0, 200)}. Recent: ${all.slice(-6).join(" | ").slice(0, 1500)}`
        );
      }
    } catch {
      /* ignore */
    }

    emit({
      type: "done",
      full,
      memorySaved,
      sources: sourceList.length > 0 ? sourceList : undefined,
      researchOk: researchPerformed ? researchOk : undefined,
      researchStatus: researchPerformed ? researchStatus : undefined,
    });
  } catch (e) {
    emit({
      type: "error",
      message: e instanceof Error ? e.message : "Something went wrong.",
    });
  }
}
