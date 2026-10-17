// AI provider abstraction. Groq is the primary provider via its
// OpenAI-compatible chat-completions endpoint. Future providers implement
// the same `AIProvider` interface — the orchestrator never touches Groq directly.

import { groqKeyPool } from "@/lib/ai/keyPool";
import { config } from "@/lib/config";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; keyId: string; status: number }) => void;
}

export interface AIProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
  stream(
    messages: ChatMessage[],
    opts?: CompletionOptions & { onToken?: (t: string) => void }
  ): Promise<string>;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function classifyStatus(status: number): "retry" | "fatal-config" | "fatal-request" {
  if (status === 429 || (status >= 500 && status <= 599)) return "retry";
  if (status === 401 || status === 403) return "fatal-config";
  return "fatal-request";
}

export class GroqProvider implements AIProvider {
  readonly name = "groq";

  private ensurePool(): void {
    groqKeyPool.configure(config.groqKeys);
  }

  private async callOnce(
    key: string,
    messages: ChatMessage[],
    opts: CompletionOptions,
    stream: boolean,
    onToken?: (t: string) => void
  ): Promise<string> {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? config.groqModel,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        stream,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      // Capture Groq's error body (safe: it never contains key material) so
      // the user sees the real cause, e.g. model_not_found, instead of a bare status.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      const err = new Error(
        `Groq request failed with status ${res.status}${detail ? `: ${detail}` : ""}`
      ) as Error & {
        status: number;
      };
      err.status = res.status;
      throw err;
    }
    if (!res.body) {
      const err = new Error("Groq returned an empty response body.") as Error & {
        status: number;
      };
      err.status = res.status;
      throw err;
    }
    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    }
    // SSE stream: accumulate + forward tokens
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = json.choices?.[0]?.delta?.content ?? "";
          if (token) {
            full += token;
            onToken?.(token);
          }
        } catch {
          // partial JSON chunk — ignore
        }
      }
    }
    return full;
  }

  private async withFailover<T>(
    messages: ChatMessage[],
    opts: CompletionOptions,
    exec: (key: string, keyId: string) => Promise<T>
  ): Promise<T> {
    this.ensurePool();
    if (groqKeyPool.size === 0) {
      throw new Error(
        "No Groq API keys configured. Add GROQ_API_KEY_1 (etc.) to your .env file."
      );
    }
    const tried = new Set<string>();
    const maxAttempts = Math.max(1, Math.min(groqKeyPool.size * 2, 8));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slot = groqKeyPool.acquire();
      if (!slot || tried.has(slot.id) && attempt >= groqKeyPool.size) {
        // still allow re-trying the soonest-recovering key
        if (!slot) break;
      }
      if (slot && tried.has(slot.id) && groqKeyPool.size > 1) continue;
      if (!slot) break;
      tried.add(slot.id);
      try {
        const estimate = JSON.stringify(messages).length / 4;
        const result = await exec(slot.key, slot.id);
        groqKeyPool.markSuccess(slot, estimate);
        return result;
      } catch (e) {
        lastError = e;
        const status =
          typeof (e as { status?: unknown }).status === "number"
            ? (e as { status: number }).status
            : 0;
        if (status !== 0) groqKeyPool.markFailure(slot, status);
        opts.onRetry?.({ attempt: attempt + 1, keyId: slot.id, status });
        const kind = status === 0 ? "retry" : classifyStatus(status);
        if (kind === "fatal-request") throw e;
        if (kind === "fatal-config" && tried.size >= groqKeyPool.size) {
          throw new Error(
            "All configured Groq API keys were rejected (401/403). Check your keys."
          );
        }
        // otherwise try the next key
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Groq request failed.");
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    return this.withFailover(messages, opts, (key) =>
      this.callOnce(key, messages, opts, false)
    );
  }

  async stream(
    messages: ChatMessage[],
    opts: CompletionOptions & { onToken?: (t: string) => void } = {}
  ): Promise<string> {
    return this.withFailover(messages, opts, (key) =>
      this.callOnce(key, messages, opts, true, opts.onToken)
    );
  }
}

export const aiProvider: AIProvider = new GroqProvider();
