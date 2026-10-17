# CAI — Self-Hosted AI Assistant

CAI is a JARVIS-style AI assistant you run yourself: clean minimal chat UI,
multi-provider streaming with automatic failover, a concurrent multi-key pool,
persistent conversations, selective long-term memory, live web research with
citations, and an expressive minimal mascot.

Built with Next.js (App Router), React, TypeScript, and Tailwind. Zero external
services required — SQLite via the Node.js built-in `node:sqlite`.

## Features

- **Bring your own keys** — works with Groq, Google Gemini, and/or OpenRouter
  (free tiers included). Any subset works; unconfigured providers are skipped.
- **Multi-key pool** — round-robin / LRU / health-based / least-used / adaptive
  (default) key selection with cooldowns and auto-restore.
- **Automatic failover** — ordered provider fallback (`groq → gemini → openrouter`
  by default) so a single outage never takes the assistant down.
- **Streaming chat UI** — SSE token stream, conversation sidebar, toast errors,
  and a mascot that reflects state.
- **Long-term memory** — heuristic selective extraction with sensitive-data
  filtering; view, delete, or disable from Settings.
- **Live web research** — SearXNG / Tavily / free DuckDuckGo + Wikipedia
  pipeline with page fetching, extraction, ranking, conflict checks, and
  `[S1]..[Sn]` citations rendered as clickable links.
- **Market data** — stock quotes via Marketstack and a free Yahoo Finance lane
  (indices, forex, crypto, commodities).
- **Safe by default** — SSRF-guarded fetches, untrusted page content isolation,
  no secrets in logs or client bundles, credential-like memory never stored.

## Quick start

1. Create your env file and add at least one provider key:

```bash
cp .env.example .env
```

At minimum set `GROQ_API_KEY_1` (get one at
[console.groq.com/keys](https://console.groq.com/keys)). See
[Configuration](#configuration) for the full list.

2. Install and run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Requires Node.js 22.5+ (uses the built-in `node:sqlite` module).

## Configuration

All configuration is environment-based; see [`.env.example`](.env.example) for
the documented list. Highlights:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSISTANT_NAME` | `CAI` | Assistant display name |
| `OWNER_NAME` | `Owner` | Who the assistant belongs to |
| `GROQ_API_KEY_1..N` / `GROQ_API_KEYS` | — | Groq keys (multi-key pool) |
| `GEMINI_API_KEY` | — | Google Gemini key |
| `OPENROUTER_API_KEY` | — | OpenRouter key |
| `AI_PROVIDER_ORDER` | `groq,gemini,openrouter` | Failover order |
| `SQLITE_PATH` | `./data/cai.db` | Database file |
| `SEARXNG_URL` | — | Self-hosted SearXNG (tried first) |
| `TAVILY_API_KEY` | — | Tavily search key |
| `WEB_SEARCH_ENABLED` | `true` | Offline kill-switch |
| `MARKETSTACK_API_KEY` | — | EOD stock quotes |

## How it works

- **Providers** (`lib/ai/`): a lazy, cached provider map with ordered failover.
  Groq runs through a multi-key pool (`keyPool.ts`); Gemini and OpenRouter use a
  shared OpenAI-compatible client (`openaiCompat.ts`).
- **Pipeline** (`lib/ai/orchestrator.ts`): intent classification → memory
  retrieval (top-5 ranked, never a full dump) → context assembly → tool router
  (calculator direct-answer, live web research when fresh data is needed) →
  streaming completion → background memory extraction + title + summary.
- **Memory** (`lib/memory/`): explicit "remember…", preferences, projects, and
  goals are extracted heuristically. Passwords, card numbers, and similar
  patterns are never stored.
- **Research** (`lib/search/`): `planner` builds basic/deep query plans;
  providers run SearXNG → Tavily → DuckDuckGo/Wikipedia; then `processor`
  canonicalizes and dedupes, `fetcher` downloads pages in parallel,
  `extractor` strips boilerplate, `rank` scores authority × coverage ×
  freshness, and `verify` produces agreement/conflict notes. Failures are
  stated plainly — never fabricated.
- **Market data** (`lib/tools/stocks.ts`): Marketstack first for US + NSE/BSE,
  then the free Yahoo lane for everything else. Unknown symbols fall through
  to web research.
- **DB** (`lib/database/db.ts`): SQLite file via `node:sqlite`. Schema covers
  users, conversations, messages, summaries, memories, projects, settings, key
  metadata, and usage/tool logs. Swapping to Postgres means replacing this
  module — all callers use the exported functions.

## API

- `POST /api/chat` — SSE stream: `conversation` → `state` → `token…` →
  `done`/`error`; `done` carries `sources` + `researchOk` when research ran
- `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/:id`
- `GET/POST/DELETE /api/memories`, `PATCH/DELETE /api/memories/:id`
- `GET/PATCH /api/settings`
- `GET /api/health` — provider/search status with opaque key ids and counters,
  never raw keys

## Web research pipeline

- **Realtime decision** (`lib/ai/intent.ts`): deterministic classifier — time
  words, mandatory topics (festivals, movies, celebrities, tech launches,
  funding, sports), and net-worth/rates/rankings patterns trigger search. Math,
  stable facts, writing, and coding questions do not.
- **SearXNG** (optional, primary when set):

  ```bash
  docker run -d -p 8080:8080 searxng/searxng
  # then set SEARXNG_URL=http://localhost:8080
  ```

  Absence only falls back — nothing breaks.
- **Security**: server-side only; SSRF guard (private/localhost DNS blocked,
  redirects re-validated per hop, 1.5 MB cap, HTML-only); page content is
  labeled untrusted and the model is instructed never to follow instructions
  found inside it.
- **Citations**: the model emits `[S1]` ids only; the backend renders them as
  clickable `[domain](url)` links, demotes unknown URLs to plain text, and logs
  violations. Finance queries get extra evidence rules (gross ≠ net ≠ profit,
  identity checks, reported-vs-calculated labeling) with bounded escalation.

## Security notes

- API keys live server-side only. The client bundle never imports them, and
  `/api/health` exposes opaque ids and counters only.
- No stack traces, system prompts, or secrets are sent to the client.
- Memory filtering blocks credential-like content; chat input is length-capped.
- Never commit your `.env` — it is git-ignored by default.

## Production build

```bash
npm run build
npm start
```

## License

[MIT](LICENSE)
