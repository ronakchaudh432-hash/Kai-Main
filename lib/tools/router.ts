// Pluggable tool router. Each tool declares name/description/schema/timeout;
// the orchestrator calls `execute` only when the intent genuinely needs it.

import { calculate, extractExpression, looksLikeMath } from "@/lib/tools/calculator";
import { research, type ResearchResult } from "@/lib/search/web";
import { extractStockQuery, fetchMarketstackQuotes, fetchQuotes, formatQuotes, type Quote } from "@/lib/tools/stocks";
import { logTool } from "@/lib/database/db";

export interface ToolDefinition {
  name: string;
  description: string;
  execute: (input: string) => Promise<{ output: string; data?: unknown }>;
}

async function timed<T>(name: string, input: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logTool(name, input, true, Date.now() - start);
    return result;
  } catch (e) {
    logTool(name, input, false, Date.now() - start);
    throw e;
  }
}

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "Evaluate arithmetic expressions safely (no LLM needed).",
  execute: async (input: string) => {
    return timed("calculator", input, async () => {
      const expr = extractExpression(input);
      const value = calculate(expr);
      const pretty = Number.isInteger(value)
        ? value.toLocaleString("en-US")
        : String(Math.round(value * 1e10) / 1e10);
      return { output: `${expr.trim()} = ${pretty}` };
    });
  },
};

export const datetimeTool: ToolDefinition = {
  name: "datetime",
  description: "Current date/time (server clock, UTC + local).",
  execute: async (input: string) => {
    return timed("datetime", input, async () => {
      const now = new Date();
      return {
        output: `Now: ${now.toUTCString()} (local: ${now.toString()})`,
      };
    });
  },
};

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Live web search + research for current or factual questions.",
  execute: async (input: string) => {
    return timed("web_search", input, async () => {
      const r: ResearchResult = await research(input);
      if (!r.ok) return { output: `Web lookup unavailable: ${r.error ?? "unknown error"}`, data: r };
      const lines = r.sources.slice(0, 5).map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet}`);
      return {
        output: `${r.answer ? `Summary: ${r.answer}\n` : ""}${lines.join("\n\n")}${r.detail ? `\n\n${r.detail}` : ""}`,
        data: r,
      };
    });
  },
};

export const stocksTool: ToolDefinition = {
  name: "stocks",
  description: "Live market quotes: premium EOD (Marketstack) for stocks, free lane for indices/forex/crypto/commodities.",
  execute: async (input: string) => {
    return timed("stocks", input, async () => {
      const entries = extractStockQuery(input);
      if (!entries) return { output: "No recognizable stock/index/commodity symbol in query." };
      const quotes: Quote[] = await fetchMarketstackQuotes(entries);
      const covered = new Set(quotes.map((q) => q.label));
      const rest = entries.filter((e) => !covered.has(e.label));
      if (rest.length > 0) quotes.push(...(await fetchQuotes(rest)));
      if (quotes.length === 0) {
        return { output: `No live quote found for: ${entries.map((e) => e.label).join(", ")}` };
      }
      return { output: formatQuotes(quotes), data: quotes };
    });
  },
};

export const tools: Record<string, ToolDefinition> = {
  calculator: calculatorTool,
  datetime: datetimeTool,
  web_search: webSearchTool,
  stocks: stocksTool,
};

/** Direct-answer fast path: pure math is computed locally, no model call. */
export async function tryDirectToolAnswer(message: string): Promise<string | null> {
  if (looksLikeMath(message)) {
    try {
      const { output } = await calculatorTool.execute(message);
      return output;
    } catch {
      return null;
    }
  }
  return null;
}
