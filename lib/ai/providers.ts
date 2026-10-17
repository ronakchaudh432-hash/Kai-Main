// Cross-provider orchestration: ordered failover across all CONFIGURED
// providers (Groq multi-key pool → Gemini → OpenRouter :free by default).
// Unconfigured providers are skipped silently — the app works with any
// subset, including Groq-only exactly as before.

import { aiProvider, type AIProvider, type ChatMessage, type CompletionOptions } from "@/lib/ai/provider";
import { OpenAICompatibleProvider } from "@/lib/ai/openaiCompat";
import { config } from "@/lib/config";

function buildProviders(): Map<string, AIProvider> {
  const map = new Map<string, AIProvider>();
  if (config.groqKeys.length > 0) map.set("groq", aiProvider);
  if (config.geminiKey) {
    map.set(
      "gemini",
      new OpenAICompatibleProvider({
        name: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: () => config.geminiKey,
        defaultModel: () => config.geminiModel,
      })
    );
  }
  if (config.openrouterKey) {
    map.set(
      "openrouter",
      new OpenAICompatibleProvider({
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: () => config.openrouterKey,
        defaultModel: () => config.openrouterModel,
        extraHeaders: () => ({
          ...(config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
          "X-Title": config.assistantName,
        }),
      })
    );
  }
  return map;
}

export interface ProviderResult {
  text: string;
  provider: string;
  model: string;
}

let _cachedProviders: Map<string, AIProvider> | null = null;

/** Lazily built and cached provider map — only constructed once. */
function getProviders(): Map<string, AIProvider> {
  if (!_cachedProviders) _cachedProviders = buildProviders();
  return _cachedProviders;
}

/**
 * Stream via ordered provider failover: Groq (multi-key pool) →
 * Gemini → OpenRouter. Each unconfigured provider is skipped silently.
 */
export async function streamWithFailover(
  messages: ChatMessage[],
  opts: CompletionOptions & { onToken?: (t: string) => void } = {}
): Promise<{ text: string; provider: string; model: string }> {
  const all = getProviders();
  const order = config.providerOrder.filter((name) => all.has(name));
  if (order.length === 0) {
    throw new Error(
      "No AI providers configured. Add GROQ_API_KEY_1, GEMINI_API_KEY, or OPENROUTER_API_KEY to your .env file."
    );
  }
  let lastError: unknown = null;
  for (const name of order) {
    const provider = all.get(name)!;
    try {
      const model =
        name === "groq"
          ? config.groqModel
          : name === "gemini"
            ? config.geminiModel
            : config.openrouterModel;
      const text = await provider.stream(messages, {
        ...opts,
        model: opts.model ?? model,
      });
      if (!text.trim()) throw new Error(`${name} returned an empty response.`);
      return { text, provider: name, model: opts.model ?? model };
    } catch (e) {
      lastError = e;
      opts.onRetry?.({ attempt: 1, keyId: `provider:${name}`, status: 0 });
      // try the next provider
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All AI providers failed.");
}

/** Names of currently configured providers (safe for health endpoints). */
export function configuredProviders(): string[] {
  return [...buildProviders().keys()];
}
