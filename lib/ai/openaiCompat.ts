// Generic OpenAI-compatible chat provider. Covers OpenRouter and Gemini
// (via Google's OpenAI-compatibility endpoint) with one implementation:
// same /chat/completions contract, same SSE streaming. Groq keeps its own
// provider (multi-key pool); this class is for single-key providers.

import type { AIProvider, ChatMessage, CompletionOptions } from "@/lib/ai/provider";

export interface OpenAICompatConfig {
  name: string;
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey: () => string;
  defaultModel: () => string;
  extraHeaders?: () => Record<string, string>;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private cfg: OpenAICompatConfig;

  constructor(cfg: OpenAICompatConfig) {
    this.name = cfg.name;
    this.cfg = cfg;
  }

  private url(): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private async callOnce(
    messages: ChatMessage[],
    opts: CompletionOptions,
    stream: boolean,
    onToken?: (t: string) => void
  ): Promise<string> {
    const key = this.cfg.apiKey();
    if (!key) throw new Error(`No API key configured for provider "${this.name}".`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(this.cfg.extraHeaders?.() ?? {}),
    };
    // Remove empty header values (some runtimes reject them).
    for (const k of Object.keys(headers)) {
      if (!headers[k]) delete headers[k];
    }
    const res = await fetch(this.url(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model ?? this.cfg.defaultModel(),
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        stream,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      const err = new Error(
        `${this.name} request failed with status ${res.status}${detail ? `: ${detail}` : ""}`
      ) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    if (!res.body) throw new Error(`${this.name} returned an empty response body.`);
    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    }
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

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    return this.callOnce(messages, opts, false);
  }

  async stream(
    messages: ChatMessage[],
    opts: CompletionOptions & { onToken?: (t: string) => void } = {}
  ): Promise<string> {
    return this.callOnce(messages, opts, true, opts.onToken);
  }
}
