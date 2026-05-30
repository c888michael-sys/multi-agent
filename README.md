# multi-agent

A multi-agent AI orchestration system built on free-tier LLM APIs, designed for $0 personal use with token-efficient inter-agent communication and graceful failover across multiple accounts/providers.

**Status:** All six stages live (Stage 6 multi-provider role architecture + Stage 5a streaming chat web UI both shipping). CLI + web UI both route through a shared smart-routed `ChatSession` over 10 provider instances (3 Gemini 3.5 Flash + 3 Gemma 4 31B + OpenRouter / Groq / Cerebras / Mistral) with **live RPM/RPD scraping from `X-RateLimit-*` headers** where providers expose them. Perception's Flash key is isolated; orchestration/reasoning share the other two. CLI local file access is on by default.

---

## What this is

A TypeScript CLI + library that runs agent workflows across free-tier LLM APIs, with token-efficient inter-agent communication, persistent usage tracking, and graceful failover across multiple accounts and providers. Designed so that the orchestrator picks the right *role* for each task (perception, reasoning, action, etc.) and the right *model* for each role is just configuration.

## Capabilities at a glance

**Live and tested** (5 cloud providers + Gemma slots, all verified end-to-end with real keys):

- Multi-account / multi-project rotation with cooldown tracking + automatic failover
- Conservation mode (round-robin ↔ serial with hysteresis based on remaining quota)
- Persistent per-provider usage stats (`~/.multi-agent/state.json`, resets at UTC midnight)
- **Live RPM/RPD from `X-RateLimit-*` headers** (OpenRouter / Groq / Cerebras / Mistral); local sliding-window estimates for Gemini (SDK doesn't expose headers)
- **Per-provider default cooldowns** — OpenRouter 10 s, others 60 s; wire `Retry-After` from the response always wins
- Parallel and specialist multi-agent orchestration with token-efficient synthesis
- **Multi-turn smart-routed `ChatSession`** (orchestrator picks `direct` / `single` / `parallel` per turn) — used by both CLI `chat` REPL and web UI
- "Serious" mode using Gemini 3.x extended reasoning (`thinkingLevel: high`)
- Google Search grounding for live web data via Gemini Flash (perception role)
- **Local file tools default-on** for `ask` (`read_file`, `write_file`, `list_dir` sandboxed to `--workdir`; `--no-tools` opts out)
- Bash exec tool (`--allow-bash`) with timeout, output cap, and process-tree kill on Windows
- Backoff-and-retry when all providers are cooling
- **6 roles × custom fallback chains** — perception's Flash key isolated; orchestration/reasoning share two Flash keys; Gemma 4 31B is the universal safety net (~14,400 RPD/key on free tier)
- **Streaming web UI** with SSE token-by-token rendering, orbital-mindmap burst, MathJax, markdown formatting
- CLI: `ask`, `agents`, `task`, `chat`, `usage`, `sessions`, `verify-keys`, `smoke`, `serve`

**In progress / planned (Stage 5b):**

- Optional bot integrations (Telegram / Discord). Instagram bot idea removed.
- OpenRouter fallback-routing (single OR call with a model list; OR walks top-to-bottom on 429/5xx/refusal)
- Web UI mindmap transition v3 ("robot arm rips door → canvas dimension → agents fly out")
- Quality-of-life: quota warning banner, stop-button during streaming, fast-mode toggle, settings drawer

## Build order

The full vision is large, so the work is decomposed into independent stages. Each stage stands alone and gets its own design + implementation cycle.

### Stage 1 — `llm_router` (foundation) — ✓ done

A TypeScript module that hides the multi-key/multi-account chaos behind one function:

```typescript
import { complete } from "./src";
const text = await complete("Hello, world.");
```

**Stage 1 scope:**

- Holds a pool of **2 Google AI Studio accounts**, 1 API key each (scalable to N — adding a key is one line in config)
- Targets `gemini-3.5-flash` (released May 19, 2026; ~1M input / 65k output context; free tier with daily quota visible per-account at https://aistudio.google.com/rate-limit)
- On 429 (rate limit) → rotates to next account in pool
- Tracks quota state **per (account, model)**, not per key (rate limits are per-project, not per-key — confirmed against Google's docs)
- Surfaces a clean error when all accounts in the pool are exhausted
- Trusts live 429s over cached "I thought we had quota left" assumptions (free-tier limits change without notice)
- Designed behind a `Provider` interface so future providers (Groq, OpenRouter) plug in without touching rotation logic
- Caller-agnostic: works whether called once or by N parallel agents

**Out of scope for Stage 1:** any agent logic, any orchestrator, any UI, conservation mode, quota dashboards.

**Stack:** TypeScript (Node 20+), `@google/generative-ai` SDK, vitest for tests, `dotenv` for config. Chosen over Python because the eventual Stage 5 web UI will share types/code with the core.

**Test approach:** mock the SDK — no real quota spent during development.

### Stage 2 — conservation mode

A strategy layer that sits between callers and the router. Switches the pool from round-robin → serial-with-failover when aggregate remaining quota crosses a configurable threshold. Adds quota-tracking output so the user can see % remaining per account.

### Stage 3 — orchestrator + agents

A controller agent that delegates to sub-agents via token-efficient handoff format. Runtime flag for two modes:

- **Specialist:** each agent owns a distinct task/domain
- **Parallel:** all agents do the same task independently, controller synthesizes

For brainstorming workflows specifically: agents think independently first, controller merges — never pre-partition into sections.

Controller priming (system-prompt block):
> You are a transformer doing next-token prediction. Anthropic's Claude has been trained (via Constitutional AI and RLHF) to acknowledge uncertainty, revise mid-response, refuse to commit to bad answers, and verify reasoning before continuing. Imitate this behavior: prefer "I don't know" to confident guessing, restart when you notice you're wrong, check before claiming.

### Stage 4 — local UI shell

Decision deferred to Stage 4. Likely terminal CLI for simplicity; revisit Tauri/Electron if the CLI feels too limiting.

### Stage 5 — web UI + optional bot integrations

Explicitly out of scope until 1–4 are working.

### Stage 6 — multi-provider role-based architecture — ✓ done

Functional roles replace fixed sub-agent rosters. Each role declares a *capability requirement*; each model is configured to fill one or more roles. Same orchestrator code regardless of model assignments.

All five providers wired (Groq, OpenRouter, Mistral, Cerebras, plus Gemini Flash + Gemma slots), plus a roster-aware `RoleOrchestrator` driving the `task` CLI command and the web `/api/chat` smart-routing path. **For the actual live role → candidate chains as currently configured, see [Role fallback chains (May 2026 live config)](#role-fallback-chains-may-2026-live-config) below** — that section is the source of truth, this section is historical context.

---

## Role fallback chains (May 2026 live config)

The candidate order each role uses today, after live calibration against the actual free-tier limits each provider currently grants this project. **Lower in the list = degraded capability or higher quota** — the resolver walks top to bottom and uses the first non-cooling slot.

| Role | Chain (priority order) | Notes |
|---|---|---|
| **orchestration** | `gemini:1 → gemini:2 → openrouter:deepseek-v4-flash → gemma:1 → gemma:2` | Light-touch routing decisions; Gemini Flash is the right shape. Falls to DeepSeek V4 Flash on OpenRouter when both Flash keys are cool, then to Gemma 4 31B (different model = independent quota pool on the same Google project) as the safety net. |
| **reasoning** | `gemini:1 (thinking=high) → gemini:2 (thinking=high) → openrouter:deepseek-v4-flash → gemma:1 → gemma:2` | Same chain shape but `thinking=high` mode on the Gemini hops; reasoning quality on Gemini Flash with extended thinking is at least as good as DeepSeek V4 Flash on Aider/GPQA, and the DeepSeek slot is preserved as the dedicated-reasoning fallback. DeepSeek R1 free was retired by OpenRouter (404 on every `:free` slug). In **hybrid mode** (`--local` / web settings toggle), `ollama:deepseek-r1` is prepended and defaults to `deepseek-r1:14b` with 32K context. |
| **perception** | `gemini:3 (useSearch=true) → gemma:1 → gemma:2` | **`gemini:3` is reserved exclusively for perception** — it is NOT listed in orchestration or reasoning candidates, so heavy chat traffic can't drain the one Flash slot that has Google Search grounding. Gemma fallback exists for liveness even though it loses live web data when it takes over. |
| **action-code** | `mistral:codestral → gemma:1 → gemma:2` | Mistral Codestral, code-specialized, ~1 B tokens / month free. Gemma falls in below. Gemini Flash is intentionally NOT in this chain — it's reserved for perception/orchestration/reasoning where it actually matters. In **hybrid mode**, `ollama:qwen2.5-coder` (native 32 K context) is prepended. |
| **action-structural** | `groq:llama-70b → gemma:1 → gemma:2` | Groq Llama 3.3 70B, 1000 RPD on its own quota. |
| **action-repetitive** | `cerebras:gpt-oss-120b → gemma:1 → gemma:2` | Cerebras GPT-OSS 120B, 1 M tok / day, wafer-scale inference. |
| **mindmap-categorize** | `gemini:1 → gemma:3 → cerebras:gpt-oss-120b → gemma:2 → gemma:1` in both cloud and hybrid modes | **A strong JSON-follower leads the chain** (Gemini Flash) because Gemma is better as a high-quota fallback than as the primary structured-JSON model. `gemma:3` stays reserved for this role as a mid-chain fallback, now using the active Gemma 4 slug from `loadGemmaProvidersFromEnv()`. Powers the web UI's mindmap burst — takes a finished chat reply and emits the structured JSON the orbital renderer needs. Reservation mirrors `gemini:3`'s perception isolation: no other role's chain references `gemma:3`, so even round-robin storms (which hit all four specialists every turn) can never drain the categorize slot. Cerebras sits second as a fast fallback (~2000 tok/sec, JSON-friendly); `gemma:2 / gemma:1` are last-resort. This role is **mode-agnostic** — it does NOT switch to a local model in hybrid mode, because qwen-coder is already serving `action-code` and being hit twice per round-robin turn was the original "mindmap stuck on structuring…" failure mode. |

**Why Gemma 4 as the universal safety net?** On Google AI Studio's free tier, every model has a **separate per-project RPD quota pool** — Gemini 3.5 Flash is capped at 20 RPD / project on the legacy free tier, but Gemma has a much larger (~14,400 RPD / project) pool. The same `GEMINI_KEY_N` therefore serves two independent rate-limit pools: a small premium one (Flash) and a huge bulk one (Gemma). Listing both keys' Gemma slots at the end of every chain means the system *never* hits "all providers exhausted" under normal load. **Model slug:** `gemma-4-31b-it` as of May 2026 — Gemma 3 (`gemma-3-27b-it`) was retired (hard 404 on generateContent, no longer in ListModels). The current options are `gemma-4-31b-it` (dense, the 27B's successor — our default) and `gemma-4-26b-a4b-it` (MoE, ~4B active — faster/lighter). Override via the `model` arg to `loadGemmaProvidersFromEnv()` in `src/config.ts` when Google publishes the next slug.

**Why `gemini:3` is reserved.** Without isolation, the chat orchestrator can fire 3-6 Gemini Flash calls per turn (plan → specialists → synthesis → mindmap pre-fetch), which would burn through all three Flash keys' daily 20-RPD caps within an hour of testing. Reserving one key for perception means searches against live web data still work even when chat has eaten the other two keys.

**Gemma 4 replaces Gemma 3.** As of May 2026 the active safety-net slug is `gemma-4-31b-it`. The old `gemma-3-27b-it` slug now hard-404s on `generateContent`, so future Gemma retirements should be handled by updating the default `model` argument in `loadGemmaProvidersFromEnv()` in `src/config.ts`; the provider implementation is model-agnostic because Gemma uses the same `GoogleGenerativeAI` SDK as Gemini.

---

## Key design decisions (and why)

**Why start with the router, not the agents.** Agent-calling-an-LLM is a well-understood shape; nothing to prove there. The real risk in this project is multi-key/multi-account failover working reliably under real rate limits. Build the risky part first as an isolated, testable module, then layer everything else on top of its stable interface.

**Why 2 accounts to start instead of 3 or more.** Same code path either way — the pool is a list and rotation doesn't care about its length. Starting with 2 means less setup friction; adding the 3rd is one config line once the system proves itself.

**Why multi-account instead of multi-project-under-one-account.** Google explicitly flags multi-project-for-quota as a ToS abuse pattern, and one account hosting many projects has worse blast radius — if that account is flagged, all its projects die at once. 3 distinct accounts × 1 project each is the same effective quota with much better failure isolation.

**Why the `Provider` abstraction is non-negotiable.** Without it, every new provider becomes surgery through the rotation/quota code. With it, a new provider is ~50 lines and zero changes to the core.

**Why caller-agnostic.** Today: a script calls `complete()` in a loop. Later: N agents call `complete()` concurrently. The router doesn't need to know it's serving an orchestrator vs a script — that means Stage 3 doesn't require any Stage 1 changes.

**Why backoff lives in the router, not the caller.** When all providers in the pool are simultaneously cooling (e.g., per-minute limit hit during a burst), `complete()` blocks until at least one is ready instead of throwing immediately. It uses each provider's actual `cooldownUntil` time, so the wait is precise rather than blind exponential — plus small random jitter to avoid thundering-herd retries. Configurable via `RouterOptions.maxRetryWaitMs` (default 60s; set to 0 to restore fail-fast behavior).

**Why parallel mode staggers dispatches.** Firing 3 sub-agents at the exact same wall-clock millisecond concentrates their token consumption in one per-minute window. The Controller staggers them by `dispatchStaggerMs` (default 300ms) + small jitter — still concurrent, but spread across the RPM window. Set to 0 to disable.

**Why usage state persists to disk.** Each CLI invocation is a fresh Node process — without persistence, the snapshot would always show zeros and the ConservationPolicy would never have history to act on. State lives at `~/.multi-agent/state.json` (cross-platform via `os.homedir()`), tracks success/rate-limit counts and active cooldowns per provider id, and resets daily counters at UTC midnight. The file is advisory: corrupt or unreadable contents fall back to empty state with a warning rather than crashing. To clear state manually, delete the file.

**Why RPM/RPD prefer live header values.** OpenAI-compatible providers (Groq, OpenRouter, Cerebras, Mistral) return `X-RateLimit-Remaining` / `X-RateLimit-Limit` headers on every response. After each call we scrape those into a per-provider `lastQuota` field on the provider instance; the `ProviderPool.snapshot()` reads them and reports `rpmSource: "live"` / `rpdSource: "live"` when present. Local sliding-window + success counters are kept as a fallback for providers that don't expose headers (Gemini SDK abstracts them away), and the CLI / sidebar both tag each gauge with `live` or `est.` so it's obvious which number to trust. Per-provider RPM caps and rejection-retry cooldowns live in `DEFAULT_RPM` and `DEFAULT_COOLDOWN_MS` tables in `src/config.ts` — provider-prefix indexed (e.g. `openrouter` has a 10 s default cooldown because its per-minute window is short, whereas `gemini` defaults to 60 s). When a rate-limit response carries a `Retry-After` header, that always wins over the per-provider default.

**Acknowledged risk.** Free-tier scaling beyond a single project is a Google ToS gray area. Multi-accounting (Sybil) is the more clearly forbidden pattern; multi-project under one account is architecturally supported and the lower-risk path for scaling. This is a personal project; the risk has been weighed and accepted.

---

## Roadmap checklist

- [x] Stage 1: implementation
- [x] Stage 1: tests against mocked HTTP
- [x] Stage 1: smoke test against 3 real Gemini accounts (live-verified with all 3 GEMINI_KEY_N slots)
- [x] Stage 2: conservation mode (round-robin ↔ serial with hysteresis; per-provider usage tracking)
- [x] Stage 3: orchestrator + specialist/parallel modes + token-efficient synthesis
- [x] Stage 3: end-to-end demo verified live against Gemini 3.5 Flash
- [ ] Stage 3: prompt tuning pass (currently functional but verbose)
- [x] Stage 4: local CLI (`ask`, `agents`, `usage`)
- [x] Stage 4: serious mode (`--serious` / `--thinking=<level>`) — Gemini 3.x extended reasoning
- [x] Stage 4: backoff-and-retry when all providers cooled (default cap: 60s wait per call)
- [x] Stage 4: parallel dispatch stagger (300ms default) so 3 agents don't hit the per-minute window in the same wall-clock ms
- [x] Stage 4: calibrate `estimatedDailyBudget` from real AI Studio limits (gemini 1500/day, groq 1000/day, openrouter 50/day, cerebras 1440/day, mistral 500/day; per-prefix defaults in `src/config.ts` `DEFAULT_BUDGETS`; wired via `loadAllProviderConfigsFromEnv()` so the sidebar's per-role quota bars and the conservation-policy mode flip both read real numbers)
- [x] Stage 4: persistent usage state across CLI invocations (`~/.multi-agent/state.json`, daily UTC rollover)
- [x] Stage 4: web browsing via Google Search grounding (`--search`, free up to 5000 grounded prompts/mo)
- [x] Stage 4: local file tools (`--tools`: read_file, write_file, list_dir, path-confined to `--workdir`)
- [x] Stage 4: bash exec tool (`--allow-bash`: cross-platform, timeout + output-cap, kills process tree on Windows)
- [x] Stage 4: multi-turn conversation + context window management (`chat <session-id>` REPL with persistent history, `/clear` `/truncate` `/info` `/usage` `/help` `/exit` slash commands, 80%/95% budget warnings with confirm-to-continue, role-based failover for chat calls)
- [x] Stage 6: role abstraction layer (`RoleConfig` / `RoleResolver`) — routes role calls to constrained provider subsets, falls back through candidates, validates registration
- [x] Stage 6: Groq provider + Llama 3.3 70B as `action-structural` (live-verified end-to-end via `--role=action-structural`)
- [x] Stage 6: OpenRouter provider + DeepSeek V4 Flash as `reasoning` (live-verified; R1 free retired by OpenRouter, V4-Flash is the current free reasoning option)
- [x] Stage 6: Cerebras provider + GPT-OSS 120B as `action-repetitive` (live-verified; Llama 4 Scout moved off the standard model list, GPT-OSS 120B is the right shape for bulk/speed)
- [x] Stage 6: Mistral provider + Codestral as `action-code` (live-verified via `--role=action-code`)
- [x] Stage 6: roster-aware orchestrator (`task` command — orchestrator picks roles per task, dispatches in parallel, synthesizes)
- [x] Stage 5a: browser UI (live-verified end-to-end against real Gemini — idle / loading / response / mindmap phases all work for research / code / compare / plan templates; burst-card layout fixed + responsive breakpoints added)
- [x] Stage 5a: streaming chat + big-bang mindmap (vertical-scroll conversation with user/AI bubbles and smooth-scroll-to-newest; **streaming tokens via `/api/chat-stream` SSE** so the bubble fills in real-time; **live LoadingView agent rows** driven by real plan/role events; persistent smart-routed `ChatSession` turns; **dedicated `mindmap-categorize` prefetch** with a "preserve all detail" prompt and explicit cloud/reserved routing; **rip-seam catalyst** with glowing void + **agent-colored fanning particles** so the 5 agents visually become the mindmap categories; click-to-focus per-node expansion with pre-filled scoped prompt; explicit 2-6 branch angle tables; box-edge connector trim; Atelier warm theme; mobile responsive with quota drawer; LS keys `lattice.responseStack.v2` and `lattice.chatSessionId.v1`)
- [x] Stage 6: **Gemma 4 31B-it slots wired per Gemini key** (`gemma:1/2/3` — separate per-model quota pool on the same Google project; ~14,400 RPD vs Flash's 20-1,500. Universal safety net at the end of every role's candidate chain in `default-registry.ts`.)
- [x] Stage 6: **Perception role isolated to `gemini:3`** — that Flash key is reserved exclusively for perception, so chat traffic on the other roles can't drain the one Gemini Flash slot with Google Search grounding.
- [x] Stage 6: **Live RPM/RPD from `X-RateLimit-*` response headers** (Groq / OpenRouter / Cerebras / Mistral) via `provider.getLastQuota?()` + `onHeaders` callback in `openai-compat.ts`. CLI's `usage` and web sidebar tag each gauge with `live` vs `est.` so you know which numbers come from the wire.
- [x] Stage 6: **Per-provider default cooldowns** — `DEFAULT_COOLDOWN_MS` table in `src/config.ts` (OpenRouter 10 s, others 60 s); response-header `Retry-After` always wins.
- [x] Stage 4: **CLI local file access on by default** for `ask` — `--no-tools` to opt out.
- [x] **Hybrid local-model toggle** (`--local` on CLI; "Hybrid local models" toggle in the web settings drawer). When enabled, prepends locally-hosted Ollama providers to two role chains: `reasoning → ollama:deepseek-r1` (default `deepseek-r1:14b`) and `action-code → ollama:qwen2.5-coder` (default `qwen2.5-coder:14b`). All other roles unchanged. Cloud candidates remain in the chain as fallback if the daemon is unreachable or the model isn't pulled. Default Ollama endpoint is `http://localhost:11434`; override with `OLLAMA_HOST` env var. The web server registers Ollama providers at boot whenever `serve --local` is used OR a chat request body carries `useLocal: true` — the per-request flag lets the UI flip modes without restarting. See [src/providers/ollama.ts](src/providers/ollama.ts).
- [x] **Dynamic sidebar attribution — no hardcoded provider IDs.** Every "rate budgets" row reads its provider id, RPM/RPD, source tag (`live`/`est.`), and cooling state directly from `/api/usage.json`'s role snapshot. When the role resolver falls back (e.g. `gemini:1` cooling → `gemini:2` → `openrouter:deepseek-v4-flash`), the sidebar's provider line updates to whichever id is actually picked next; a small `⤳` glyph annotates the row when it's serving from a non-primary candidate. The snapshot endpoint walks the active resolver's chains (via the new `RoleResolver.listRoles()` accessor), so flipping the Hybrid-mode toggle instantly remaps reasoning and action-code rows to `ollama:*` without a server restart. Local rows show `∞` for both RPM and RPD with a `local` source tag (no cloud-style cap applies). The data path: `/api/usage.json?local=1` query param is set by the `useUsage` hook whenever `settings.useLocal` is true. See [src/web/server.ts:117](src/web/server.ts), [src/roles/resolver.ts:85](src/roles/resolver.ts), and `Sidebar` in [src/web/static/app.jsx:440](src/web/static/app.jsx).
- [x] **Mindmap categorization rewired — no fictional fallback.** The orbital used to silently render `FALLBACK_DATA` (hardcoded "Option A / Option B" / "Origin and context" / "Prepare → Execute → Learn") whenever both the Cerebras prefetch AND the local markdown-heading splitter failed. That made bursts look randomly seeded with content the model never produced. The new flow:
  1. After the final answer lands, `prefetchMindmapData(entry)` ships the assistant's full reply to the dedicated `mindmap-categorize` role with a "preserve every detail" prompt and an explicit `useLocal:false` request. The prefetch's promise is stored in a ref so the burst handler can await it.
  2. On click → if `entry.data` is valid: instant burst. If `dataLoading`: BarHandle shows `structuring…` (pulsing) and `expand()` awaits the pending promise. If the provider-side categorizer fails or returns malformed JSON, the UI now derives a deterministic structure from the assistant's actual markdown/text via `deriveMindmapData()` and opens the burst with that real content instead of blocking.
  3. `FALLBACK_DATA` is still defined in [templates.jsx:78](src/web/static/templates.jsx) as inert template reference, but live burst recovery no longer displays fictional "Option A / Background / Prepare" content. The only fallback path uses the reply text the model already showed on the chat page.

  See `prefetchMindmapData` and `expand` in [src/web/static/app.jsx](src/web/static/app.jsx), plus the new `dataState`/`errorMessage` props on `BarHandle`.
- [x] **Routing modes renamed and deepened.** Web and CLI now use user-facing modes instead of implementation jargon: `auto` keeps the short smart-routing path, `multi-agent` is the default sequential workflow (reasoning plans, perception researches when the plan asks for it, action roles execute, action-repetitive checks only when reasoning requested it, reasoning repairs if needed, and action-structural performs the final visual formatting), and `brainstorming` is the former round-robin fan-out renamed around its purpose: perception gives the research-based opinion, reasoning gives the logic/tradeoff opinion, action-code gives the implementation opinion, and action-structural gives the organization/presentation opinion before orchestration synthesizes them. Legacy `round-robin` remains accepted as an alias for `brainstorming` so old localStorage and clients keep working. See `src/agents/multi-agent-workflow.ts`, `src/chat/session.ts`, `src/agents/role-orchestrator.ts`, `src/web/server.ts`, and `src/web/static/app.jsx`.
- [x] **Hybrid-mode local-detection gate.** Toggling "Hybrid local models" ON in the settings drawer now pings a new `GET /api/ollama-health` route, which probes the configured Ollama daemon's `/api/tags` endpoint (1.5 s timeout) and reports `{ reachable, installed, missing }`. If the daemon isn't running OR the configured local models (default `deepseek-r1:14b`, `qwen2.5-coder:14b`, or your `OLLAMA_REASONING_MODEL` / `OLLAMA_CODER_MODEL` overrides) aren't pulled, the toggle is **refused** with an in-drawer error explaining exactly what's missing, instead of silently falling through to cloud fallbacks on every reasoning / action-code turn. On app mount, if `useLocal=true` is persisted from a prior device but Ollama isn't reachable on this one (including health-fetch failure), the toggle is auto-cleared and a transient banner (`mm-quota-warn` style) explains why. Chat requests now always send an explicit boolean `useLocal`, so a web toggle set to OFF still forces the cloud resolver even when the server process was started with `--local`. The categorizer prefetch always sends `useLocal:false` and routes through `mindmap-categorize`, so the mindmap burst never depends on a local daemon. See `onToggleLocal` and the mount-time `useEffect` in [src/web/static/app.jsx](src/web/static/app.jsx), plus the `/api/ollama-health` handler in [src/web/server.ts](src/web/server.ts).
- [x] **Mindmap categorization survives prose-wrapped JSON + adds timeouts.** The categorizer prefetch used to parse responses with `String(reply).replace(/```json|```/g, '').trim()` + `JSON.parse`. Some models reliably broke that by prefixing JSON with prose or wrapping output in `<think>…</think>` chain-of-thought blocks, and either case caused the parser to bail → `dataError=true` → mindmap refused to activate. Replaced with `extractFirstJsonObject(text)` which (1) strips `<think>…</think>` blocks (multi-line, case-insensitive), (2) strips `` ```json ``  and bare `` ``` ``  fences, (3) walks the cleaned text tracking brace depth and JSON-string state (so braces inside string literals don't confuse the scan), and (4) returns the first balanced `{…}` block. Also added a 120 s `AbortController` timeout on `prefetchMindmapData`'s fetch and a 180 s default `requestTimeoutMs` on every `OllamaProvider` call. See `extractFirstJsonObject` near the top of [src/web/static/app.jsx](src/web/static/app.jsx), `prefetchMindmapData` further down, and `fetchWithTimeout` in [src/providers/ollama.ts](src/providers/ollama.ts).
- [x] **File attachments in the web composer.** Paperclip button next to send opens the OS file picker; selected text files (max 256 KB each, 1 MB total) appear as removable chips above the textarea. On submit, file contents are prepended to the message as fenced blocks (`### filename\n\`\`\`ext\n...\n\`\`\``) so the model can read them inline. Binary detection rejects non-text uploads. Per-file content is fenced with an auto-extended backtick fence so files containing their own \`\`\` aren't broken. See `Composer` in [src/web/static/app.jsx](src/web/static/app.jsx).
- [x] **Router fix — chat backoff respects role allow-list.** `Router.completeChat` and `Router.completeChatStream` previously computed their wait-until-recovery using `pool.earliestAvailable()` instead of `earliestAvailableIn(providerIds)`, which meant role-constrained chat calls (the entire web UI hot path) would spin-retry against a cooled, allow-listed provider while unrelated healthy providers showed wait=0. Fixed by switching both call sites to the filtered variant, matching the existing `Router.complete` and `Router.completeWithTools` behavior. See [src/router.ts:250](src/router.ts), [src/router.ts:310](src/router.ts).
- [x] **Mindmap catalyst v4 — center-split rip.** Replaced the v3 catalyst (arm enters upper-right, yanks LEFT) with the user-locked design: right arm enters horizontally from the right, punctures center (crack-flash + debris burst), left arm enters from the left simultaneously; both halves tear apart toward opposite screen edges via jagged clip-path torn panels revealing the white canvas from center out; arms retract; existing shatter+fountain plays on white canvas. Single-clock architecture — both arms and torn panels driven by one rAF `t` in `CatalystOverlay`; dark torn-half panels swap in at puncture (CSS `animation-delay: 520ms` hides the real chat list at exactly that moment, masked by the rip flash). Re-timed timeline: `anticipation(0–520) → puncture(520–720) → pull(720–1440) → retreat(1440–1740) → shatter(1740–1940) → fountain(1940–2400)`. Deleted: v3 `mm-chat-tear`, `mm-seam-snatched`, `.mm-canvas-reveal`. Added: `.mm-canvas-under`, `.mm-torn-half`, `.mm-crack-svg`, crack-line polylines, ballistic debris polygons, mirrored left arm. See `COLLAPSE_TIMELINE` + `CatalystOverlay` in [src/web/static/app.jsx](src/web/static/app.jsx) and the new v4 CSS rules at the bottom of [src/web/static/style.css](src/web/static/style.css).
- [ ] Stage 5b: optional bot integrations (Telegram / Discord). Instagram bot idea removed.
- [ ] Provider-layer: OpenRouter fallback-routing (single OpenRouter call with a list of candidate models; OR walks the list top-to-bottom on 429/5xx/refusal/context-overflow — see [Planned: OpenRouter fallback routing](#planned-openrouter-fallback-routing))
- [x] **Web UI: mindmap transition v3 — robot arm rips the door + persistent canvas dimension.** Replaced the prior v2 catalyst (horizontal seam rip → `output`/`mindmap` tokens collide → shatter → fountain) with a cinematic robot-arm sequence ending on a persistent ivory workspace:
  1. **armEnter (0–450 ms)** — articulated robot arm (shoulder bar → upper arm → elbow joint → forearm → wrist → two-finger claw, all SVG) slides in from off-canvas right and descends toward the seam line at horizontal/vertical center.
  2. **armClamp (450–630 ms)** — claw closes on the seam (`clawOpen: 1 → 0`), brief anticipation overshoot in X so the clamp reads as a snap.
  3. **armYank (630–1100 ms)** — arm jerks LEFT with ease-in cubic, wrist rotates ~12° counter-clockwise to imply force. The chat scroll list tears with the yank via CSS `mm-chat-tear` keyframes (`translateX -110 vw` + `skewX -14°` + blur 4 px + opacity → 0). Behind the tear, a radial-gradient `mm-canvas-reveal` layer wipes from the rip-point to ivory `oklch(0.97 0.005 95)`.
  4. **armRetreat (1100–1360 ms)** — arm continues off-screen left, claw re-opens (releasing the torn fabric). A short `mm-rip-flash` ring pops at the rip-point as the canvas finishes revealing.
  5. **shatter (1360–1540 ms) + fountain (1540–2400 ms)** — same shatter-then-fountain pattern as v2 (kept because it works), now playing on the white canvas. Particles arc to their final orbital positions and hand off to the OrbitalNode mounts.

  Persistent canvas dimension: the palette switch is scoped to `[data-phase="collapsing"]` and `[data-phase="mindmap"]` on `.mm-root` — `--mm-bg`, `--mm-fg`, `--accent`, `--mm-border` all override to the ivory/deep-charcoal/ink-blue triplet. The atelier theme is restored only when `phase` flips to `imploding` (i.e. user clicks `COLLAPSE TO THREAD`). Mindmap-phase orbital nodes pick up a frosted-white card style automatically via the override. Verified end-to-end in preview: phase progression `response → collapsing (white canvas + arm) → mindmap (white canvas persists, 3 nodes) → response (atelier restored)`; background colors confirmed as `oklch(0.97 0.005 95)` during mindmap and `oklch(0.135 0.011 55)` after collapse-to-thread.

  See `COLLAPSE_TIMELINE` + `CatalystOverlay` in [src/web/static/app.jsx](src/web/static/app.jsx) and the `[data-phase=...]` palette overrides + `mm-chat-tear`/`mm-robot-arm`/`mm-canvas-reveal`/`mm-rip-flash` rules at the bottom of [src/web/static/style.css](src/web/static/style.css).
- [x] **Gemma 3 → Gemma 4 slug update + 404 failover + mode-aware categorize routing.** Three linked fixes for the "could not structure the mindmap" report:
  1. **Root cause — `gemma-3-27b-it` was retired.** A direct probe against the live API confirmed the slug returns a hard, consistent `404 ... is not found for API version v1beta, or is not supported for generateContent`, and ListModels no longer includes it. (An earlier read misattributed this to intermittent load-shedding — it's a genuine retirement.) The current Gemma 4 slugs both return 200 reliably: `gemma-4-31b-it` (dense, successor to the 27B) and `gemma-4-26b-a4b-it` (MoE, ~4B active). `loadGemmaProvidersFromEnv` now defaults to `gemma-4-31b-it`. Since Gemma is the universal safety net AND the categorizer's mid-chain fallback, this restores a large chunk of the system's resilience that had been silently broken.
  2. **404 is now failover-able (defensive).** `GeminiProvider.isRateLimitError` previously returned `false` for 404, so a retired slug threw out of the whole role instead of rotating. Now a 404-not-found/not-supported is treated as failover-able, so the *next* time Google retires a model the chain degrades gracefully (rotates to Cerebras / next Gemma slot) until someone updates the slug, rather than hard-failing. A chain whose every candidate 404s still surfaces `AllProvidersExhaustedError`.
  3. **mindmap-categorize leads with a reliable JSON model.** Even with the slug fixed, Gemma is the weakest JSON-follower in the pool, so it shouldn't be the categorizer's *primary*. Now `buildDefaultRoles` puts Gemini Flash (`gemini:1`) at the front in both cloud and hybrid modes; `gemma:3` + Cerebras remain as fallback. `rolesFor` routes BOTH modes through `buildDefaultRoles` (previously cloud mode used raw `DEFAULT_ROLES` and skipped the prepend). See `isRateLimitError` in [src/providers/gemini.ts](src/providers/gemini.ts), `buildDefaultRoles` in [src/roles/default-registry.ts](src/roles/default-registry.ts), and `rolesFor` in [src/cli.ts](src/cli.ts).
- [x] **LoadingView state-accumulation fix (data-layer).** The per-agent status rows used to be derived from `liveStatus` (the latest SSE event) alone, so every new event blanked the prior roles back to `queued`. **Root cause:** round-robin emits all four `role-start` events synchronously, so they arrive in a single network chunk; the SSE reader's inner loop calls `setLiveTurn()` once per event in a synchronous burst, and React batches those updates so only the *last* event survives to the next render. An earlier render-layer attempt (a `useState`+`useEffect` reducer inside `LoadingView`) did **not** fix this — it still only ever saw the surviving (last) event, because the batching happens upstream of the render. **Fix: accumulate in the DATA layer.** A plain `agentAcc` object is mutated once per event directly in the SSE loop (immune to batching), and a fresh snapshot ships on `liveTurn.agentState` with every `setLiveTurn`; `LoadingView` simply renders that prop. The reducer logic lives in two shared pure helpers — `makeInitialAgentMap()` and `applyAgentEvent(prev, status)`. Verified: app parses (esbuild), 211/211 tests pass, and replaying a round-robin event sequence through `applyAgentEvent` lights all four specialists `engaged` simultaneously after the burst, then all five `done` — instead of only the last role. See `makeInitialAgentMap` / `applyAgentEvent`, the SSE loop in `HeroMindmap.submit`, and `LoadingView` in [src/web/static/app.jsx](src/web/static/app.jsx).
- [x] **Reserved `gemma:3` slot for the mindmap-categorize role.** Mirrors the `gemini:3 → perception` reservation pattern but for the mindmap categorizer. New `mindmap-categorize` role added to the `RoleName` union with chain `gemma:3 → cerebras:gpt-oss-120b → gemma:2 → gemma:1`. **`gemma:3` is removed from every other role's safety net** so chat traffic on any role cannot drain the categorize slot — even round-robin storms (which fire all four specialists per turn). The frontend's `prefetchMindmapData` now ALWAYS routes to this role regardless of hybrid mode; previously, hybrid mode aliased the prefetch to `action-code` (qwen-coder) which got hit twice per round-robin turn — once for the action-code parallel call and again for the categorize — causing the categorize call to either queue forever or truncate against Ollama's default context. Reserved Gemma is mode-agnostic, so the mindmap stays responsive even when both local Ollama models are saturated. See the `mindmap-categorize` entry in [src/roles/default-registry.ts](src/roles/default-registry.ts) and the `prefetchMindmapData` change in [src/web/static/app.jsx](src/web/static/app.jsx).
- [x] **Safer local Ollama defaults + installed-tag fallback.** Hybrid mode now defaults to the smaller local pair (`deepseek-r1:14b` for reasoning, `qwen2.5-coder:14b` for coding) with 32K context each, because two 32B models plus large KV caches can run out of VRAM/RAM even when each model fits alone. Users can opt up or down with `OLLAMA_REASONING_MODEL`, `OLLAMA_CODER_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_REASONING_NUM_CTX`, and `OLLAMA_CODER_NUM_CTX`, and can tune patience with `OLLAMA_REQUEST_TIMEOUT_MS`; default local reasoning timeout is 15 minutes so slow cold loads do not skip the reasoner too eagerly. If Ollama has a compatible variant tag pulled for the requested size (for example `deepseek-r1:32b-qwen-distill-q4_K_M` instead of the configured `deepseek-r1:32b`), the provider resolves that installed tag after the first 404 and retries instead of failing the multi-agent turn. It will not silently use `qwen2.5-coder:32b` when the configured default is `qwen2.5-coder:14b`. See [src/providers/ollama.ts](src/providers/ollama.ts) and `loadOllamaProviders` in [src/config.ts](src/config.ts).
- [x] **Robust `.env` loading for web/local launches.** `src/config.ts` now searches upward from both `process.cwd()` and the module directory for `.env`, covering `tsx`, compiled `dist`, npm scripts, and process-manager launches. It also fills environment variables that exist but are blank from the parsed `.env` file. This prevents the web server from booting with only `ollama:*` providers registered (which caused orchestration to error with "wanted gemini/openrouter/gemma; registered deepseek-r1/qwen2.5-coder"). Verified by forcing `GEMINI_KEY_1/2/3` blank in the shell and confirming the loader still registers `gemini:1/2/3` + `gemma:1/2/3` from `.env`.
- [x] **Cross-device setup clarified + CLI doctor.** `.env` is intentionally gitignored, so a second device cloned from GitHub will not have cloud provider keys until `.env` is created on that device. `OLLAMA_HOST` also defaults to `http://localhost:11434`, meaning the machine running `npm run web`, not another PC on the LAN. Added `npm run cli -- doctor`, which prints cwd, module directory, discovered `.env` files, parsed key names, blank env vars filled from `.env`, and registered provider IDs without exposing secret values. If orchestration says only `ollama:*` is registered, run `doctor` from the same terminal and confirm its `cwd` is the clone you actually meant to launch. If the `.env` lives outside the repo, set `MULTI_AGENT_ENV=C:\path\to\.env` (or `DOTENV_CONFIG_PATH`) before running the CLI/web server.
- [ ] Web UI: **drag-rearrange** category nodes on the canvas (snap-to-cluster), AND a **drag-anywhere placement** mode so the user can pin nodes at arbitrary coordinates rather than along the polar ring. Persists per-entry under `localStorage[lattice.responseStack.v2]` so the layout survives reloads. Natural follow-up to the v3 catalyst + canvas workspace — the white dimension is now a long-lived surface, so free-form placement is the next logical capability.
- [x] Parse Gemini `RetryInfo.retryDelay` from `GoogleGenerativeAIError` so cooldowns reflect Gemini's own per-minute reset hint (the SDK doesn't surface `Retry-After`, but it embeds `RetryInfo.retryDelay` as JSON in the error message text — we now match `"retryDelay": "..."` directly + fall back to the English `"retry in X.Ys"` phrase, then to the per-provider 60 s default if neither pattern is present. See `parseGeminiRetryDelayMs` in `src/providers/gemini.ts`.)
- [x] **Brave Search / DuckDuckGo Instant Answer tool** for the Gemma perception fallback (when `gemini:3` is exhausted and the resolver falls to Gemma, the `web_search` tool gives the model a way to still fetch fresh web data). `src/tools/web-search.ts` — Brave preferred when `BRAVE_SEARCH_KEY` is set (free 2000 q/mo), DuckDuckGo Instant Answer as the keyless fallback (no signup). Wired into `cmdAskWithTools`, so `npm run cli -- ask "..."` already has `web_search` available alongside `read_file` / `write_file` / `list_dir`. 7 new unit tests covering Brave-primary, DDG-fallback, HTML-strip, empty-query, no-results, and Brave-429 → DDG fallthrough. 211/211 tests pass.
- [x] **UI bug — LoadingView only shows "orchestrator working"** while a chat turn is in flight. **Fixed.** Root cause: the streaming handler in `app.jsx` builds `lastStatus = { phase: evt.kind, ...evt }`, but the spread overrides `phase: evt.kind` with `evt.phase` (the inner sub-phase like `"single"` / `"synthesis"`). `LoadingView` and `statusLabel` were then computing `ph = phase || kind` — which resolved to `ph = "single"` instead of `"role-start"`, missed every branch in the switch, and left the agent state map in its initial plan-start state (so only orchestration ever showed engaged). Fix is one line in two places (`app.jsx`): `ph = kind || phase` (prefer outer event type over inner sub-phase). Sub-phase checks below still read `liveStatus.phase` directly and now work correctly. `LoadingView` now paints `reasoning: thinking…` / `action-code: thinking…` / `orchestration: synthesizing…` etc. as the SSE events arrive.

Quality-of-life proposals (not yet started, ordered by likely user value):

- [ ] **Quota warning banner in the chat** — when any role drops below 10 % remaining OR the conservation policy flips to serial mode, surface a one-line banner above the composer naming the role and its likely fallback. The data is already in `/api/usage.json`; this is a UI add only.
- [ ] **Stop button during streaming** — a small `■` next to the composer while a turn is in flight, aborting the `/api/chat-stream` fetch and rolling the in-flight `liveTurn` back. Saves quota on bad turns.
- [ ] **Fast-mode toggle** — composer-bar switch that bypasses smart routing for the next turn (sends straight through the orchestration role, single call, ~10 s instead of 20–45 s). Useful for short conversational turns where multi-agent depth is overkill.
- [ ] **Settings drawer (CLI feature parity)** — surface `--serious` / `--thinking=high`, `--search`, `--role=` forced routing as toggles in the UI, so the web UI matches the CLI's full flag surface. Closes the "merge function into UI" thread.
- [ ] **PhaseErrorBoundary around loading + response phases** — currently only the orbital phase is wrapped; defensive coverage so any future render crash anywhere in the SPA shows a recoverable panel instead of blacking the page.
- [ ] **Web-only editable long-term role instructions.** Add a local instructions/memory file that the web UI can edit and the user can also modify directly on disk. At the start of each new thread, load those custom instructions, feed the relevant parts to orchestration, and pass role-specific guidance to each specialist so users can persist preferences like tone, coding style, research depth, formatting rules, or per-model behavior without changing prompts in code. Keep it local-first and transparent: document the file path, expose an editor in settings, and make the first turn include the instructions plus the user prompt.

See `docs/specs/2026-05-22-stages-2-and-3.md` for what's been built without keys and exactly what needs tuning once keys arrive.

---

## Repo layout

```
multi-agent/
  README.md             — this file
  CLAUDE.md             — standing rules for any Claude session in this repo
  src/
    index.ts            — public exports + the convenience complete() entry
    cli.ts              — CLI (ask, agents, usage, --help)
    provider.ts         — Provider interface + CompleteOptions + ThinkingLevel
    router.ts           — pool-aware completion + backoff + tool-use passthrough
    pool.ts             — per-provider state, mode (round-robin/serial), pick logic
    state.ts            — StateStore interface + InMemory/File implementations
    config.ts           — env-driven provider construction
    conservation.ts     — ConservationPolicy + formatUsageReport
    errors.ts           — RouterError / AllProvidersExhaustedError / ...
    providers/
      gemini.ts         — GeminiProvider + helpers (history conversion, source extraction)
    agents/
      agent.ts          — stateless system-prompt + router wrapper
      controller.ts     — multi-agent orchestrator (parallel + specialist modes)
      prompts.ts        — CONTROLLER_PRIMING + routing/synthesis prompt templates
    tools/
      types.ts          — Tool / ToolDeclaration / ConversationPart
      runner.ts         — multi-turn tool-call loop (the "agent runtime")
      file-tools.ts     — FileTools (read/write/list, path-sandboxed)
      bash-tool.ts      — BashTool (cmd.exe/sh, timeout + output cap)
    roles/
      types.ts          — RoleConfig / RoleName / ProviderRef / RoleEvent
      resolver.ts       — RoleResolver: priority-ordered routing with cross-role failover
      default-registry.ts — DEFAULT_ROLES (perception / reasoning / orchestration / action-*)
    chat/
      session.ts        — ChatSession (persistent multi-turn history)
      repl.ts           — ChatRepl (interactive readline loop with slash commands)
      spinner.ts        — TTY spinner (no-op when non-tty)
    web/                — Stage 5a (browser UI; live-verified, see Web UI section)
      server.ts         — built-in http server: static + /api/* routes (chat / chat-stream / complete / task / usage.json / sessions)
      static/
        index.html      — SPA shell (loads React + Babel + MathJax from CDN)
        style.css       — visual styles (Atelier warm theme)
        app.jsx         — HeroMindmap component + phases + sidebar + catalyst overlay
        templates.jsx   — template defs (research/code/compare/plan), node extractors, mindmap renderers
  tests/                — vitest, mocked SDK throughout
    fixtures.ts         — FakeProvider, ToolFakeProvider, RateLimitedError
  scripts/
    smoke.ts            — npm run smoke (1 real call)
    verify-keys.ts      — npm run verify-keys (1 call per configured key)
    demo-parallel.ts    — multi-agent demo against real keys
  docs/specs/           — per-stage design docs
  .env.example          — documented env var layout
  .gitignore            — covers .env, node_modules, dist, etc.
  package.json
  tsconfig.json         — strict mode, noUncheckedIndexedAccess
```

## Architecture

```
                  ┌─────────────────────────────────────────────────┐
                  │ CLI (src/cli.ts)  +  Web (src/web/server.ts)    │
                  │  ask / agents / task / chat / usage / serve     │
                  └──────────────┬──────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ↓                         ↓                         ↓
  ┌─────────┐            ┌──────────────┐          ┌────────────┐
  │  Agent  │            │  Controller  │          │ ToolRunner │
  │(1-shot) │            │ (multi-agent │          │ (tool-call │
  │         │            │  orchestr.)  │          │  loop)     │
  └────┬────┘            └──────┬───────┘          └─────┬──────┘
       │                        │                        │
       └───────────────┬────────┴────────────────────────┘
                       ↓
              ┌────────────────┐
              │     Router     │ ← rotation, cooldown, backoff,
              └────────┬───────┘   completeWithTools passthrough
                       ↓
              ┌────────────────┐
              │  ProviderPool  │ ← provider state, mode (RR/serial),
              └────────┬───────┘   pickAvailable + cooldown logic
                       ↓
              ┌────────────────┐
              │   StateStore   │ ← optional JSON persistence
              └────────────────┘   (~/.multi-agent/state.json)

  Provider implementations (src/providers/*) — one per LLM backend
  Tool implementations    (src/tools/*)     — bash, file, plus future others
```

**Key abstractions, in order of dependency:**

- **`Provider`** (`src/provider.ts`) — unified interface every LLM backend implements. `complete()` for text; optional `completeWithTools()` for function calling. Knows how to classify its own rate-limit errors (`isRateLimitError`) and extract `Retry-After` (`retryAfterMs`).
- **`ProviderPool`** (`src/pool.ts`) — holds provider state: cooldown timestamps, success/rate-limit counters, optional daily-budget estimates. Pick strategy is pluggable (round-robin vs serial). Hydrates from `StateStore` on construction, persists after every counter change.
- **`Router`** (`src/router.ts`) — the workhorse. `complete()` picks a provider from the pool, calls it, rotates on 429, backs off when all are cooling, retries until success or `maxRetryWaitMs` is hit. `completeWithTools()` is the same machinery for function-calling providers.
- **`StateStore`** (`src/state.ts`) — JSON-on-disk persistence behind an interface. Per-provider counters + cooldowns survive process restarts; daily counters auto-reset at UTC midnight. Corrupt files fall back to empty state with a warning (never crash on read).
- **`Agent`** (`src/agents/agent.ts`) — stateless. Applies a system prompt to a user input, calls the router. Used as a sub-agent in multi-agent flows.
- **`Controller`** (`src/agents/controller.ts`) — multi-agent orchestrator with two runtime modes: `parallel` (all sub-agents independently → synthesize) and `specialist` (controller picks one sub-agent for the task). Threads `CompleteOptions` through to every underlying call. Used by the `agents` CLI command.
- **`ChatSession`** (`src/chat/session.ts`) — multi-turn conversation with persistent disk-backed history. `send(userInput)` appends user/assistant turns and writes back. Token-budget estimation via simple chars/N heuristic; surfaces budget warnings without enforcing them at the session layer (the REPL handles user-facing prompts). Smart-routing mode (default): each turn first asks the orchestrator for a JSON plan (`direct` / `single` / `parallel`) — reuses `parsePlan` from `RoleOrchestrator`. Direct: orchestrator answers itself. Single: specialist receives clean history. Parallel: each specialist gets clean history + a per-task framing instruction, orchestrator synthesizes. Powerful mode (toggleable mid-session) injects `thinking: high` into every call. Plans, intermediate outputs, and routing preambles are all ephemeral — never persisted to disk.
- **`ChatRepl`** (`src/chat/repl.ts`) — interactive readline-based loop on top of `ChatSession`. Event-driven (queue + promise) rather than for-await to survive stdin closing mid-handler. Handles `/clear`, `/truncate`, `/info`, `/usage`, `/help`, `/exit` slash commands plus 80% warning / 95% confirm prompts.
- **`RoleOrchestrator`** (`src/agents/role-orchestrator.ts`) — the Stage 6 capstone. Takes a free-form task, asks the orchestration role for a JSON plan (`direct` / `single` / `parallel`), executes the plan via `RoleResolver`, synthesizes per-role outputs when needed. Used by the `task` CLI command. Defensive plan parsing falls back to a single `action-structural` call on malformed JSON.
- **`ToolRunner`** (`src/tools/runner.ts`) — multi-turn function-calling loop. Captures Gemini's `thoughtSignature` and re-attaches it on subsequent turns (required for Gemini 3.x). Caps iterations at 10.
- **`ConservationPolicy`** (`src/conservation.ts`) — observes Router's usage snapshot, flips Pool mode round-robin ↔ serial with hysteresis. `tick()` is manual; `attachConservationPolicy(router)` registers a `router.onAfterCall` hook so the policy auto-ticks after every successful call. The CLI's `buildRouter` calls this by default — conservation adapts in real time once any provider has an `estimatedDailyBudget` set.
- **`RoleConfig` / `RoleResolver`** (`src/roles/`) — Stage 6: functional role → ordered list of candidate providers. Resolver picks the first registered + non-cooling candidate and calls the Router constrained to that provider subset. Defaults in `default-registry.ts` (live chains as of May 2026: see the *Role fallback chains* table above). All five non-Gemini providers (Groq, OpenRouter, Mistral, Cerebras) are wired plus Gemma 4 slots; perception's `gemini:3` is reserved exclusively to keep Google Search grounding alive when chat traffic drains the other Flash keys.

## Setup

### Minimal (Gemini only)

1. Provision N independent Gemini quota buckets — separate Google Cloud projects under one account (up to 25 per account; lower ToS risk than multi-account). Generate one API key per project at https://aistudio.google.com/apikey.
2. `cp .env.example .env` and fill in `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`, ...
3. `npm install`
4. `npm test` — mocked test suite, no real quota
5. `npm run verify-keys` — calls each configured key once (1 request per key)
6. `npm run smoke` — single round-trip through the router (1 request)

### Multi-provider

For the full role-based architecture, add keys for any of these providers (each role degrades gracefully if its provider's key is missing):

| Env var | Provider | Sign-up URL | Free tier |
|---|---|---|---|
| `OPENROUTER_KEY` | OpenRouter | https://openrouter.ai → Keys | `:free` models capped to ~20/day per account without a $10 lifetime credit top-up; **~1000/day after the top-up** (one-time, not subscription). Calls without credit return `402 insufficient_quota`. |
| `GROQ_KEY` | Groq | https://console.groq.com → API Keys | 30 RPM / 1000 RPD account-wide |
| `MISTRAL_KEY` | Mistral | https://console.mistral.ai → API Keys (phone verification required) | 1B tokens/month on Experiment plan |
| `CEREBRAS_KEY` | Cerebras | https://cloud.cerebras.ai → API Keys | 1M tokens/day, 30 RPM |

**Gemma slots come free with each Gemini key.** No separate signup — every `GEMINI_KEY_N` is automatically registered twice: once as `gemini:N` (Flash) and once as `gemma:N` (Gemma 4 31B-it). The two share a Google Cloud project but draw from **independent per-model RPD quota pools** on the free tier (Flash ≈ 20–1,500/day depending on project age; Gemma 4 ≈ 14,400/day). Doubles your effective Google-side headroom at zero cost.

### Hybrid local mode (optional)

If you have an Ollama daemon running on the same machine (or on your LAN), you can route the two most expensive role chains to local models instead of the cloud:

| Role | Local model | Where it usually goes (cloud) |
|---|---|---|
| `reasoning` | `deepseek-r1:14b` | `gemini:1` / `gemini:2` with `thinking=high` |
| `action-code` | `qwen2.5-coder:14b` | `mistral:codestral` |

All other roles (orchestration, perception, action-structural, action-repetitive) continue to use their cloud chains regardless of this toggle — perception in particular needs Google Search grounding and cannot be swapped to a local model.

Setup:

1. Install Ollama (https://ollama.com).
2. `ollama pull deepseek-r1:14b` (about 9 GB; safer default for the reasoning role).
3. `ollama pull qwen2.5-coder:14b` (middle-ground coder model; override if you intentionally want 32B).
4. Enable via either path:
   - **CLI**: pass `--local` to any command — `npm run cli -- task --local "..."`, `npm run cli -- chat --local my-session`, `npm run cli -- serve --local`.
   - **Web UI**: open the settings drawer (top-right gear), toggle "Hybrid local models." The toggle persists in `localStorage[lattice.settings.v1]`; each chat-stream request sends an explicit `useLocal: true` or `useLocal: false`, so the server picks the resolver that matches the visible toggle instead of inheriting the process default.

Override the daemon URL with `OLLAMA_HOST=http://other-host:11434` in `.env` if Ollama runs on a different machine. The cloud chain is preserved as fallback in local mode — if the daemon is down or the model isn't pulled, the role gracefully falls through to the original cloud candidate. To use a bigger/smaller local pair without code changes, set `OLLAMA_REASONING_MODEL` and/or `OLLAMA_CODER_MODEL`; use `OLLAMA_NUM_CTX` for both roles or `OLLAMA_REASONING_NUM_CTX` / `OLLAMA_CODER_NUM_CTX` when mixing sizes. For example, a 32B reasoner plus 14B coder compromise can use `OLLAMA_REASONING_MODEL=deepseek-r1:32b`, `OLLAMA_REASONING_NUM_CTX=16384`, `OLLAMA_CODER_MODEL=qwen2.5-coder:14b`, and `OLLAMA_CODER_NUM_CTX=32768`.

Cross-device note: GitHub does not include `.env`. On every device that runs the CLI or web server, create its own `.env` with the cloud keys (`GEMINI_KEY_1`, etc.). If the file lives outside the repo, point the app at it before launch: PowerShell one-off example: `$env:MULTI_AGENT_ENV='C:\path\to\.env'; npm run cli -- doctor`; persistent example: `setx MULTI_AGENT_ENV "C:\path\to\.env"` then open a new terminal. `DOTENV_CONFIG_PATH` is accepted as an alias. If local Ollama runs on a different device from the web server, set `OLLAMA_HOST=http://<that-device-ip>:11434` in the web server device's `.env`. To diagnose what a device actually loaded, run `npm run cli -- doctor` from the intended clone and check the printed `cwd` before changing env-loading code.

**Confirmed Gemini 3.5 Flash free-tier limits (May 2026, per project):**

| Bucket | Limit | Notes |
|---|---:|---|
| **RPM** | **5** | Requests-per-minute; trips first under bursty load |
| **TPM** | **250,000** | Tokens-per-minute; generous, rarely binding |
| **RPD** | **20** | Requests-per-day; the real bottleneck — resets at UTC midnight |

These are baked into `DEFAULT_BUDGETS["gemini"] = 20` and `DEFAULT_RPM["gemini"] = 5` in `src/config.ts`. Google's docs sometimes quote 15 RPM / 1500 RPD as the headline — those apply to upgraded/paid tiers, not the legacy free quota you get on a fresh project. If you have an upgraded project, override per-deploy via `ProviderConfig.estimatedDailyBudget` / `estimatedRpmCap`. **Gemma 4 on the SAME project has its own 30 RPM / 14,400 RPD pool**, which is why we register it as a separate `gemma:N` slot — it's the real safety net for the action roles and any role that doesn't strictly need Flash-specific features (`thinking=high` / Google Search grounding).

## CLI

```
npm run cli -- ask "your prompt here"                       # one-shot, local file tools on by default
npm run cli -- ask --no-tools "..."                         # pure LLM, no fs access
npm run cli -- ask --role=reasoning "..."                   # force a specific role's chain
npm run cli -- agents "your prompt here"                    # parallel, 3 default agents
npm run cli -- agents --mode=specialist "your prompt"       # specialist routing
npm run cli -- agents --trace "your prompt"                 # print per-agent outputs
npm run cli -- task "your prompt"                           # roster-aware orchestrator picks roles per task
npm run cli -- chat <session-id>                            # interactive smart-routed REPL with persistent history
npm run cli -- sessions                                     # list saved chat sessions
npm run cli -- usage                                        # per-provider RPM/RPD live or estimated, cooldowns
npm run cli -- verify-keys                                  # one ping per configured key, reports ✓/✗
npm run cli -- serve [--port=N]                             # boots the web UI on localhost (default 7421)
npm run cli -- --help
```

### Explicit role routing

`--role=<name>` on `ask` forces the call through the named role's primary candidate provider (with fallback to its other candidates only if the primary is exhausted). Useful for testing and for forcing a specific model when you know which one fits the task.

```
npm run cli -- ask --role=action-structural "Format X as Y."   # → Groq Llama 3.3 70B
npm run cli -- ask --role=reasoning "What's the right approach for X?"
npm run cli -- ask --role=perception "What's the latest CVE for log4j?"
```

Valid roles: `perception`, `reasoning`, `orchestration`, `action-code`, `action-structural`, `action-repetitive`. Each role's candidate list is in `src/roles/default-registry.ts`.

### Auto-routing (the orchestrator picks roles for you)

`task <prompt>` lets the orchestrator (Gemini) decide how to handle the task:

- **Trivial query** → orchestrator answers directly (no other role invoked).
- **One role fits** → routes to that role's primary provider.
- **Multiple angles** → fans out to several roles in parallel, synthesizes outputs.

```
npm run cli -- task "What's 2+2?"
npm run cli -- task "Write a Python function for binary search."
npm run cli -- task "Compare DuckDB and SQLite for analytics workloads."
npm run cli -- task --trace "Find recent SQLite benchmarks and analyze them."
```

`--trace` shows the plan (`direct` / `single` / `parallel`) and per-role outputs before the synthesized answer. `--serious` and `--thinking=<level>` propagate to every underlying call.

The orchestrator's plan-generation output is parsed as JSON with defensive fallback: malformed plans degrade to a single `action-structural` call instead of throwing.

### Failover and visibility

When a role's primary candidate is exhausted, the resolver:

1. **Falls back through the role's own candidate list first** (e.g., reasoning: `gemini:1` thinking=high → `gemini:2` thinking=high → `openrouter:deepseek-v4-flash` → `gemma:1/2/3`).
2. **If the role's whole candidate list is exhausted**, borrows ANY healthy provider from outside the role's list as a last-resort substitute. Capabilities may degrade — for example, a borrow that subs Groq for perception loses Google Search grounding.
3. **If nothing in the pool can serve**, throws `AllProvidersExhaustedError`.

Every deviation from the happy path prints a warning to stderr:

```
⚠ role 'reasoning': primary gemini:1 cooling, used backup gemini:2
⚠ role 'perception' exhausted; substituting from outside the role's candidate list (one of: groq:llama-70b). Capabilities may be degraded.
⚠ role 'action-code' fully exhausted — no provider could serve.
```

The substitution warning now names the **actual** provider that served the call (via a `CallAttribution` out-param threaded through `Router.complete*`), not just the list of eligible foreigns. When all role candidates AND cross-role substitution all fail, the thrown `AllProvidersExhaustedError.attempts` carries the aggregated attempts across every candidate that was tried — previous behavior dropped earlier candidates' attempts on the floor.

Disable cross-role substitution with `crossRoleFailover: false` when constructing `RoleResolver` programmatically (CLI defaults to enabled).

### Multi-turn chat sessions

`chat <session-id>` opens an interactive REPL with persistent history at `~/.multi-agent/sessions/<id>.json`. Sessions survive process restarts — open the same id later and the conversation continues.

**Smart routing** (default): every turn first asks the orchestrator (Gemini) for a JSON plan. Three possible plans:

| Plan | What happens | REPL indicator |
|---|---|---|
| `direct` | Orchestrator answers itself, no specialist call | (no tag) |
| `single` | One specialist handles the turn with the full conversation history | `[routed to <role>]` |
| `parallel` | N specialists work different angles concurrently, orchestrator synthesizes | `[parallel: a, b, c → synthesized]` |

The orchestrator's plan + per-specialist outputs are ephemeral — only the final reply gets persisted to history, so the conversation stays clean. Disable per-session by constructing `ChatSession` with `smartRouting: false` (legacy single-role behavior).

**Powerful mode**: enable Gemini's `thinking: high` setting on every call in the session. Start with `--powerful` or toggle mid-session via `/power on|off`. Non-Gemini specialists ignore the setting; Gemini calls become slower but more deliberate. Useful for hard problems where you'd rather wait than re-prompt.

```
npm run cli -- chat my-tough-session --powerful
chat:my-tough-session> ...
```

**To wipe history**: `/clear` inside the REPL, or delete `~/.multi-agent/sessions/<id>.json` from outside. The REPL also greets you with the prior turn count when you resume an existing session, with `/clear` mentioned right there.

**Save / load (branching):**

```
chat:my-session> /save backup-before-rewrite
saved current history as session 'backup-before-rewrite' at ~/.multi-agent/sessions/backup-before-rewrite.json
chat:my-session> (continue talking, original is preserved as 'backup-before-rewrite')
chat:my-session> /load backup-before-rewrite
⚠ /load will OVERWRITE the current session's history with 'backup-before-rewrite'... Continue? [y/N] y
loaded 'backup-before-rewrite' (5 turn(s)) into current session.
```

`/save <name>` snapshots the current history to a new session id; the current session continues. `/load <name>` replaces the current session's history with a saved one (prompts to confirm). Useful when you want to branch a conversation and explore without losing the original thread.

**Auto-summarization (default on):** when projected token usage hits 85% of the budget, the orchestrator silently summarizes older turns into a single "[Earlier conversation summary]" pair, keeping the most recent 3 pairs verbatim. You'll see `[auto-summarized N older turn(s) to free context budget]` above the reply on turns that trigger it. Disable by constructing `ChatSession` with `autoSummarize: false`. Tunables: `autoSummarizeAtPct` (default 85), `keepRecentTurns` (default 3).

**Generating indicator:** a tiny TTY spinner (`⠋ thinking...` / `⠋ thinking (powerful mode)...`) appears while waiting for the model. No-op in piped/non-interactive output so logs stay clean.

---

## Web UI (Stage 5a — live-verified)

A browser interface for the system, served from `localhost` by a built-in HTTP server. The frontend is a single-page React app rendered via in-browser Babel (no build step required). Designed from a handoff bundle exported from claude.ai/design — see "Source attribution" below.

**Start it:**

```
npm run web              # boots on http://localhost:7421 by default
npm run cli -- serve --port=9000   # custom port
```

Open the printed URL in a browser. Ctrl+C to stop.

**Visual system — Atelier (warm).**

Warm charcoal background (`oklch(0.135 0.011 55)`) with cream-ivory typography (`oklch(0.975 0.008 80)`) and a single muted-amber accent (`oklch(0.77 0.11 65)`). Tuned away from the prior cool-slate "cyberpunk" feel toward a design-studio / leather-notebook palette. Agent dots span a warm differentiation band (amber → sage → mauve → olive → terracotta) so the five specialists read as peers, not as a rainbow LED panel. Swap any of the `--mm-bg` / `--accent` / `--mm-fg` variables in `style.css` to retheme without touching the rest of the file.

**What it does**

Six phase-states, animated transitions between each:

1. **Idle** — centered composer; Bricolage Grotesque hero "Many *minds,* one conversation."; mono eyebrow `$ LATTICE/ORCHESTRATOR — V0.4.1 // 5/5 READY`; mono template chips.
2. **Loading** — your prompt locks into a card; the visible role rows in the sidebar switch into a routing state while the backend `ChatSession` decides whether to answer directly, call one specialist, or fan out to multiple roles.
3. **Response — chat scroll, streaming.** A normal vertical-scroll conversation, modeled on Claude/ChatGPT. Each turn is a row: the user's prompt as a right-aligned bubble, the orchestrator's reply as a left-aligned bubble underneath. **The reply streams in token-by-token over `/api/chat-stream` (SSE)** — same persistent smart-routing `ChatSession` path used by the CLI chat REPL (orchestrator plan → optional specialist role calls → synthesis), but the final answer-producing call uses Gemini's `generateContentStream`, so tokens appear immediately rather than the user staring at a blank bubble for 15-45 s. The `LoadingView` agent rows reflect **real plan state in real time** — `orchestrator planning…` → `reasoning thinking…` → `synthesizing…` — driven by `plan-start` / `role-start` / `role-end` SSE events instead of the previous fake cycle. A blinking caret follows the partial bubble while tokens are still arriving. The bubble renders markdown into real UI elements (headings, lists, tables, inline code, bold) and MathJax renders `$...$` / `$$...$$` LaTeX so formatting symbols do not sit around raw. The category split is reserved for the mindmap, on burst. The composer pins at the bottom and the **seam handle** — a wide horizontal seam with a chevron-knob labeled `BURST INTO MINDMAP` (replaces the prior iOS-style pull pill) — sits above the scroll list, always operating on the newest turn. New turns smooth-scroll into view via a bottom-anchor element + double-rAF defer. During `collapsing` the composer fast-hides (160 ms) and the chat list dissolves (360 ms, blur + scale-down) so the catalyst sequence plays on a clean stage.
4. **Collapsing — the catalyst sequence** (~1.9 s, JS-orchestrated timeline `COLLAPSE_TIMELINE` in `app.jsx`):
   - **0–520 ms — seam rip.** The seam line splits at its center: the two halves slide LEFT and RIGHT apart (not down), and a glowing accent **void** blooms in the gap. The chevron knob fades + shrinks. Tokens emerge *from the void*, not from a descending bar. (`mmSeamRipLeft` / `mmSeamRipRight` / `mmSeamKnobOut` / `mmSeamVoidBloom` keyframes; previous slide-down-as-unit `mmBarSlide` retired.)
   - **420–920 ms — collision.** Two **labeled text-box tokens** fly in: one tagged `output` (B) from the LEFT and one tagged `mindmap` (A) from the RIGHT, accelerating inward (ease-in cubic), meeting at exact dead center. A transient classifier/radar field pulses behind the collision so the handoff reads as analysis rather than a plain slide. Each token is a 132 px-wide miniature card with a mono label + accent tick.
   - **920–1010 ms — impact.** A soft radial ring expands at the collision point; the two flying tokens vanish and the `mindmap` token re-mounts as the centered **anchor** (`.mm-anchor-a`) — there's no triple-stack, the impact is a clean handoff.
   - **1010–1170 ms — shatter.** N **mini text-box particles** materialize clustered around A, each pre-rendered with its eventual category's label + a content preview. N is the actual number of categorized chunks in the newest response.
   - **1170–1900 ms — gravity fountain (now agent-fan).** Each mini text-box travels along a quadratic Bézier from A toward its final orbital position, scaling from 0.13× → 1×. Each particle's **trail is rendered in the color of one of the 5 agents** (cycling through `MM_AGENTS`) and its mini-card border + label use the same color, so the burst reads as "the 5 agents fanning out and becoming the mindmap categories." The trail is a partial Bézier truncated via **de Casteljau subdivision** with tangent-retreat at BOTH ends, so the line stops at the edge of the A anchor and the edge of the particle box — never visually crosses either. Each trail is drawn as a soft outer glow + crisp inner core for depth. In the last 15 % of the fountain, the mini-card plays an exit transition (scale +12 %, blur 0 → 6 px, opacity → 0) which dovetails with the OrbitalNode's matching entrance (starts at scale 1.12 + blur 6 + opacity 0, settles to scale 1 + blur 0 + opacity 1 over 320 ms). Particle final positions and OrbitalNode resting positions are computed by the SAME shared `computeOrbitalLayout(nodes, stageW, stageH)` helper so the boxes land exactly on top of each other at the handoff.
5. **Mindmap (settled)** — A as **active composer** at the geometric center of the usable area (above the bottom edge, below the thread strip — composer top:cy is set programmatically to match the radial origin, so no overlap with the strip header). A `COLLAPSE TO THREAD` button sits directly **above** the composer (where the user's hand already is after dragging the seam down). Category nodes are placed by an **explicit angle table** for branch counts 2–6 (`ANGLE_TABLES_DEG` in `app.jsx`) — deterministic, balanced top-and-bottom shapes; counts outside 2–6 fall back to even polar spacing. SVG dashed accent lines are trimmed at BOTH ends (`lineFromBoxToBox`) so they never visually pierce the composer or a node. Nodes are visual category entry points derived from the full markdown answer; **click a node** to open the focused-node view: it fills the canvas (sidebar untouched), shows that category's details, slides the composer up to the bottom, and **pre-fills the prompt with `For the [category] part: `** with the cursor placed after the trailing space so a follow-up scoped to that category is one keystroke away.
6. **Imploding** (~440 ms) — nodes scale toward A, lines fade, the response stack re-materializes.

The prompt's *type* is detected via keyword heuristics (`research|find|sources|...` -> research, `code|implement|function|...` -> code, `compare|vs|tradeoffs|...` -> compare, anything else -> plan). The chat response is not forced into that schema. **Mindmap categorization runs as a background pre-fetch via Cerebras (`action-repetitive` role, 1M tok/day quota).** As soon as a chat turn lands, the frontend kicks off `POST /api/complete` with `role: "action-repetitive"` and a `comprehensiveCategorizePrompt(...)` (in `templates.jsx`) that explicitly tells the model to preserve EVERY detail — no truncation, no paraphrasing — and emit it into the matching template JSON. The parsed result is cached on the entry's `data` field, but ONLY after `isValidMindmapData(template, parsed)` confirms the shape (array fields are actually arrays, etc.) — malformed-but-parseable JSON is rejected so it can never crash the renderer. When the user clicks BURST the data is already there → instant transition. If the prefetch fails, returns the wrong shape, or hasn't returned yet, the burst falls back to the local heuristic `deriveMindmapData(...)` (markdown-heading split + paragraph fallback), and if even THAT yields an invalid shape the burst uses `FALLBACK_DATA[template]`, so the mindmap is never blank. As an additional safety net, the orbital phase is wrapped in a `PhaseErrorBoundary` — any render-time crash inside any descendant component shows a recoverable error panel with a "back to chat" button instead of unmounting the React tree and black-screening the page.

**Orbital sizing.** The orbit radius is computed from the stage dimensions so nodes never spill past the edges: `baseR = max(minR, min(stageW/2 − nodeW/2 − pad, stageH/2 − nodeH/2 − pad, 320))`. On very narrow viewports the orbital starts to crowd — collapse the sidebar or widen the window if it feels tight.

> **Layout invariant — no overlaps.** The orbital layout must keep nodes (a) clear of the composer A at center, and (b) clear of each other. The current logic enforces (a) via `minR ≥ composerHalfW + nodeW/2 − slack` and (b) via even angular spacing + a per-pair repulsion pass (`resolveOverlaps`) after positions are computed. If you change node sizes, the composer max-width, jitter ranges, or the number of nodes per template, re-verify both invariants — especially on viewports under ~1100 px wide, where the available radius is small. Any future change here should keep the contract: no card visually intersects another card or the composer, including after drift settles.

Persistence: the visible chat transcript is mirrored to `localStorage[lattice.responseStack.v2]`, and the backend `ChatSession` id is stored in `localStorage[lattice.chatSessionId.v1]`, so browser turns keep real backend context across main-chat and mindmap follow-ups. "New thread" clears the old backend session, rotates the session id, wipes the visible transcript key, and returns to the idle hero.

**Backend endpoints**

| Route | Method | Body / params | Returns |
|---|---|---|---|
| `/` | GET | — | `index.html` (the SPA shell) |
| `/style.css`, `/app.jsx`, `/templates.jsx` | GET | — | static files from `src/web/static/` (`.jsx` served as `text/babel`) |
| `/api/complete` | POST | `{ prompt: string, role?: string }` | `{ reply: string }` — one-shot completion through the named role (default `orchestration`). The web frontend uses `role: "action-repetitive"` to drive the Cerebras-backed mindmap pre-fetch |
| `/api/task` | POST | `{ prompt: string }` | `{ reply, plan, perRole }` — same `RoleOrchestrator` path as the CLI `task` command |
| `/api/chat` | POST | `{ sessionId, message }` | `{ reply, servedBy, plan, summarizedTurns, tokenEstimate, budgetPct, turns, ... }` — buffered multi-turn `ChatSession` shape (one JSON reply at the end) |
| `/api/chat-stream` | POST | `{ sessionId, message }` | `text/event-stream` — same `ChatSession` path as `/api/chat`, but emits SSE frames as the turn runs: `{kind:"plan-start"}` / `{kind:"plan",plan}` / `{kind:"role-start",role,phase}` / `{kind:"role-end",role,ok}` / `{kind:"token",text}` / `{kind:"summarize-start"}` / `{kind:"summarize-end",folded}` / `{kind:"done",reply,...}` / `{kind:"error",error}`. The web frontend uses this so the chat bubble fills in token-by-token and the LoadingView agent rows show real-time status |
| `/api/usage.json` | GET | — | `{ mode, providers: [{id, successCount, rateLimitCount, remainingPct, estimatedDailyBudget, rpmCount, rpmCap, rpmSource, rpdSource, liveQuotaFetchedAt, cooling, cooldownMsRemaining}], roles: {<role>: {…, rpmSource, rpdSource, cooldownMsRemaining, candidates: [...]}} }` — machine-readable counterpart to `/api/usage`, polled by the sidebar. `rpm/rpdSource` is `"live"` when the values came straight from a provider's `X-RateLimit-*` headers (OpenRouter / Groq / Cerebras / Mistral) or `"estimated"` when computed from our local sliding window (always for Gemini, since the SDK doesn't expose those headers) |
| `/api/sessions` | GET | — | `{ sessions: string[] }` |
| `/api/sessions/:id` | GET | — | full session snapshot |
| `/api/sessions/:id/clear` | POST | — | wipe a session |
| `/api/usage` | GET | — | `formatUsageReport` text |

**Architecture decisions**

- **No build step.** Frontend uses `<script type="text/babel">` + `@babel/standalone` from a CDN, exactly like the prototype bundle. Trades runtime parse cost (acceptable for a personal-use local tool) for zero toolchain overhead. Production deployment would swap in a real bundler.
- **Vanilla `node:http`**, not Express. No new npm dependencies.
- **Frontend chat uses `/api/chat`, not `/api/task` or `/api/complete`.** `/api/chat` wraps `ChatSession` with smart routing, so every browser turn first asks the orchestrator for `direct` / `single` / `parallel`, specialists receive clean conversation history, and parallel work is synthesized by orchestration. `/api/task` remains available for one-shot CLI-task parity; `/api/complete` remains the older one-shot orchestration-role route.
- **5 visible roles in sidebar, 6 roles in system.** The sidebar's `MM_AGENTS` array surfaces the 5 roles currently shown in the product chrome (orchestration, perception, reasoning, action-code, action-structural). The 6th role (`action-repetitive`) is omitted from the sidebar but still available in the role registry. The composer label `smart routing · 5 visible roles` means the orchestrator can route across those visible roles, not that every turn necessarily calls all five.
- **Sidebar gauges are wired to `/api/usage.json`.** Agent rows now show real role status: `ready`, `fallback ready`, `unavailable`, or `temp unavailable` when all registered candidates for that role are cooling. The context gauge is conversation-context usage from `ChatSession`; the daily quota bars are provider-budget estimates only when the provider exposes `remainingPct` (`n/a` otherwise). Context used and token/daily quota used are intentionally separate concepts.

---

## Web UI handover notes (read this if you're picking it up cold)

**Status as of last commit:** code compiled, typechecks clean, mocked unit tests pass (197/197 — including `tests/pool.test.ts` covering live-quota override, per-entry cooldown, RPM window pruning, plus 15 web-server tests). Live-verified end-to-end with real keys: 6 roles route correctly, perception isolation confirmed (`gemini:3` only — orchestration/reasoning don't touch it), Gemma slots load alongside Gemini slots (10 providers total). Browser smoke confirmed `/api/chat` turn persistence, MathJax rendering in the response bubble, real/fallback sidebar statuses with `live` vs `est.` source tags, and local markdown-heading mindmap splitting.

**To verify it works:**

1. `npm install` (no new deps but make sure node_modules is current).
2. `npm run web` — expect: `multi-agent web UI live at http://localhost:7421/`.
3. Open the URL in a browser. **Expected:** see the "Many minds, one conversation." hero with a centered composer.
4. Type a research-ish prompt: "What is Rust's borrow checker?" — submit.
5. **Expected:** sidebar agents pulse; after ~1.2 s minimum + the real API time, the chat enters the response phase. A `you` bubble appears on the right with your prompt, and an `orchestrator` bubble appears below it on the left with the smart-routed markdown answer rendered as formatted headings/lists/tables/bold text. `$...$` and `$$...$$` LaTeX should render through MathJax. The `BURST INTO MINDMAP` seam handle sits above the chat list.
6. Type a second prompt that depends on the first and submit. **Expected:** a new `you / orchestrator` turn appends to the bottom of the chat list, the backend `/api/chat` session includes the earlier turn as context, and the list smooth-scrolls to bring the new turn into view. Older turns stay reachable by scrolling up — they are NOT dimmed or backgrounded.
7. Click (or pull-drag-down past ~48 px) the **bar handle** at the top of the canvas. **Expected:** the bar glides DOWN the Y-axis (~420 ms) and dissipates at the collision point; a classifier/radar field briefly pulses; **labeled text-box tokens** tagged `output` (B, from left) and `mindmap` (A, from right) fly inward and just touch at center (~500 ms); a soft radial ring expands; the two flying tokens vanish and the `mindmap` token re-mounts as the centered anchor (~90 ms); **mini text-box particles** materialize clustered around A, each carrying its own category label + content preview (~160 ms); the mini boxes travel along Bézier paths toward their final positions while growing from 0.13× → 1× — the trail line and the box advance together via de Casteljau path truncation, so **the line never pokes past the box** (~730 ms). Total ~1.9 s. Settled state: A composer at center, nodes distributed around A in a full 360° cycle, dashed accent lines connecting them back to A.
8. **Type a follow-up prompt into A while still in the orbital view** and press Enter / click send. **Expected:** the orbital unmounts; you see the loading phase; then the chat returns with a new turn appended and smooth-scrolled into view. The follow-up uses the same backend chat session as the main page.
9. Click the `COLLAPSE TO THREAD` button above the center composer (or `BACK TO MINDMAP` from a focused node). **Expected:** nodes implode toward A, lines fade, then the chat list re-materializes with the newest turn auto-scrolled into view.
10. **Click any orbital node.** **Expected:** the node expands to fill the canvas (sidebar untouched), composer slides up to the bottom strip pre-filled with `For the [category] part: ` (cursor at end), so you can ask a follow-up scoped to that category. `← BACK TO MINDMAP` button top-left returns to the orbital view.
11. Try a code prompt, a comparison prompt, a planning prompt. Each should pick a different template and produce different orbital nodes (files for code, targets for compare, phases for plan).
12. Reload the page. **Expected:** the entire chat is restored from `localStorage[lattice.responseStack.v2]`, you land back on the response phase, the list auto-scrolls to the newest turn.

**Layout note — Atelier theme + chat-scroll + 360° mindmap (current).** Warm charcoal background, ivory typography, single muted-amber accent (re-tuned away from the prior cool-slate "cyberpunk" feel). Response page is a **vertical-scroll chat** (you-bubble right, orchestrator-bubble left, full markdown answer inside the AI bubble) — older turns are reachable by scrolling, not by a dim/blur effect. The `BURST INTO MINDMAP` seam handle replaces the prior iOS-style pull pill and operates on the newest turn. Catalyst sequence (1.9 s, `COLLAPSE_TIMELINE` in `app.jsx`): seam **rips open horizontally** with a glowing void in the gap → two labeled text-box tokens (`output` left, `mindmap` right) emerge from the void and collide at center → mindmap re-mounts as the centered anchor → N **agent-colored mini text-box particles** fan out along Bézier arcs to their final orbital positions, each particle wearing one of the 5 agent colors so the burst reads as "the agents becoming the categories." Trail is a **partial Bézier via de Casteljau subdivision** with tangent-retreat at BOTH ends, so the line never punches into the A anchor box or the particle box. Settled mindmap: explicit angle table for branch counts 2–6 (`ANGLE_TABLES_DEG`); each node is derived locally from the markdown response and click-to-expands to a focused-node view that fills the canvas, pre-fills the composer with `For the [category] part: `, and surfaces the category details. `COLLAPSE TO THREAD` button sits directly above the center composer. Full chat history persists under `localStorage[lattice.responseStack.v2]` and the matching backend `ChatSession` id under `localStorage[lattice.chatSessionId.v1]`.

**Planned — mindmap transition v3 ("robot arm rips the door"):** the seam-rip catalyst above is the v2 visual. A planned v3 (not yet built) will replace it with this concept exactly as described by the user:

> robot arm rips open door, opens to dimension wiwth a more canvas like background (white), then agents fly out, and it fades  into the mindmap

**Things to specifically watch for / known-likely-issues:**

- **`window.HeroMindmap` race.** The `index.html` polls every 30ms for `HeroMindmap` to be defined before mounting. Babel compiles asynchronously; if you see a blank page, open devtools console — likely a SyntaxError in one of the JSX files that prevented it from registering. The fix is in the JSX, not the polling loop.
- **CDN unpkg failures.** The page loads React, ReactDOM, and Babel from unpkg.com. If the user is offline or unpkg is down, the page won't render. Mitigation later: vendor those scripts locally.
- **`.jsx` MIME.** Server serves `.jsx` as `text/babel`. If a browser refuses to execute (some browsers are stricter than others), the script tag in `index.html` may need explicit `type="text/babel" data-presets="env,react"` or similar. Worth checking devtools network tab.
- **Burst-card layout (FIXED).** The prototype's CSS positioned `.mm-card` absolutely but never set its coordinates, so all cards stacked at origin in the mindmap phase. The append-only fix at the bottom of `style.css` (`/* Burst layout — overrides for cards that actually flow. */`) turns `.mm-burst-cards` into a responsive auto-fit grid and overrides the per-card position. Cards animate in with a staggered entrance via `--i`.
- **Responsive sidebar.** On viewports under 880 px the sidebar collapses off-screen. A floating `quota` button (top-right) toggles it open as a drawer so you can still read provider call counts / cooling state on mobile.
- **Mobile layout.** Under 640 px the orbital mindmap stops being a polar cluster and reflows to a vertical column: composer first, nodes stacked below, no SVG connectors (saves render cost on phones). The seam handle becomes a full-width 56 px touch target. Focused-node view fills the screen. The hero typography scales down via `clamp()`.
- **Where's my quota?** The left sidebar polls `GET /api/usage.json` every 3 s. Agent rows show real role availability (`ready`, `fallback ready`, `unavailable`, `temp unavailable`). The context gauge comes from the current `ChatSession` token estimate; the daily quota bars use provider `remainingPct` when a provider exposes an estimated daily budget, otherwise they show `n/a` instead of inventing usage. On desktop the panel is always visible; on mobile, tap `quota` (top-right). For terminal-style output, hit `GET /api/usage` for plain text, or run `npm run cli -- usage` from the shell.
- **What does "new thread" do?** Clears the response stack, wipes `localStorage[lattice.responseStack.v2]`, and drops you back at the idle hero. Same effect as opening the page fresh.
- **Background canvas (`ConstellationOverlay`) particle count is 64.** Heavy on weak machines. Drop to 32 if perf is bad.
- **Fonts (`Geist`, `Geist Mono`, `Instrument Serif`)** load from Google Fonts. First paint will have a flash of unstyled text. Acceptable for personal use.
- **Detection regexes for prompt templates are crude.** "How does the borrow checker work" gets `research`; "implement a borrow checker" gets `code`. False positives/negatives are expected. Improve `TEMPLATE_DEFS.*.detect` in `src/web/static/templates.jsx`.

**File map for the web module:**

```
src/
  web/
    server.ts                  - HTTP server (node:http, no deps)
    static/
      index.html               - SPA shell, mounts React app
      style.css                - all visual styles (29 KB, dense)
      app.jsx                  - HeroMindmap component + phases + sidebar
      templates.jsx            - template defs (research/code/compare/plan),
                                 detection, system prompts, burst renderers
```

`src/cli.ts` has the `serve` command. `src/index.ts` exports `startWebServer`. `package.json` has `"web": "tsx src/cli.ts serve"`.

**Source attribution.**

The web frontend was adapted from a handoff bundle exported from **claude.ai/design**, located on the original developer's machine at:

```
C:\Users\Michael\Downloads\ai chat-handoff.zip
```

Extracted into `C:\Users\Michael\Downloads\ai-chat-handoff-extracted\ai-chat\project\`. The source files are:

- `hero-mindmap.html` (design canvas bootstrap — REPLACED by my `src/web/static/index.html`)
- `hero-mindmap.css` (visual styles — COPIED unchanged to `style.css`)
- `hero-mindmap.jsx` (main component — COPIED to `app.jsx` then ADAPTED)
- `hero-mindmap-templates.jsx` (template defs + renderers — COPIED unchanged to `templates.jsx`)

**Adaptations made to the prototype:**

1. `MM_AGENTS` rewritten to map to the system's real roster (5 of 6 roles).
2. Weight tables in `Sidebar` (lines ~167-170) updated to use real role IDs.
3. `window.claude.complete(...)` (the design studio's mock API) replaced with backend fetches. The main chat now uses `fetch('/api/chat', ...)` for persistent smart-routed `ChatSession` turns; `/api/task` remains available for one-shot RoleOrchestrator parity with the CLI `task` command, and `/api/complete` remains available for older one-shot calls.
4. Agent display labels use `a.name.toLowerCase()` instead of `a.id` (because IDs now have hyphens like "action-code" which read badly with the `.agent` suffix).
5. `index.html` rewritten to drop the 1280×760 letterbox in favor of viewport-filling layout.
6. CSS file otherwise unchanged.

**What's NOT yet done that you should do next:**

1. ~~Live-verify end-to-end~~ — done; verified via `npm run web` against a real Gemini key for research/code/compare/plan prompts.
2. ~~Burst-card layout bugs~~ — fixed (see "Burst-card layout (FIXED)" above).
3. ~~Wire the sidebar's token gauges to real `/api/usage` data~~ — done via `/api/usage.json`; sidebar polls every 3s + on phase=response. Caveat: orchestration and perception both bind to `gemini:1` so they show identical numbers — fix needs per-role accounting at the snapshot layer.
4. ~~Session-persistence~~ — done: last `{prompt, response}` saved to `localStorage[lattice.lastThread.v1]`, restored straight into the response phase on reload. (Did NOT wire `/api/chat` — the template flow is single-shot per prompt, not conversational.)
5. ~~Tests for `src/web/server.ts`~~ — done: `tests/web-server.test.ts` has 12 tests covering static-serve, traversal protection, the four `/api/*` routes, CORS preflight, and resolver error propagation.
6. Vendor React / ReactDOM / Babel locally instead of unpkg CDN if the user wants offline use.
7. Sidebar toggle button for narrow viewports (currently off-screen under 880px with no visible way to show it).
8. Per-role token accounting at the router/pool layer so the sidebar can attribute usage to the *role* that initiated the call, not just the underlying provider.

**If you want to test the design source files directly** (not the integrated version): open `C:\Users\Michael\Downloads\ai-chat-handoff-extracted\ai-chat\project\hero-mindmap.html` in a browser. It mocks the model call (`window.claude.complete`) and returns fixture data, so you can verify the visual design without any backend.

```
npm run cli -- chat my-session
chat: session 'my-session' (role: orchestration). Type /help for commands, /exit to leave.
chat:my-session> What's a closure in JavaScript?
[answer with full context of prior turns]
chat:my-session> Give me an example.
[answer building on the previous turn]
chat:my-session> /info
session id: my-session, role: orchestration, turns: 2, est. tokens: 312 / 100000
chat:my-session> /clear
history cleared.
chat:my-session> /exit
```

**Slash commands:**

| Command | Action |
|---|---|
| `/help` | Show available commands |
| `/clear` | Wipe history (persists immediately) |
| `/truncate <N>` | Keep only the most recent N turns |
| `/info` | Print session id, role, turn count, token estimate |
| `/usage` | Print router provider usage snapshot |
| `/power [on\|off]` | Toggle powerful (Gemini thinking=high) mode for the rest of the session |
| `/save <name>` | Snapshot current history to a new session id (branch point) |
| `/load <name>` | Replace current history with a saved session (asks to confirm) |
| `/exit` | Leave session (history persists) |

Slash commands accept either `/cmd` or `\cmd` (Windows users habitually type backslash) and `exit`/`quit` work as bare aliases for `/exit`.

**Context budget:** sessions track token usage via a character-count heuristic (~4 chars/token). At 80% of budget, a warning prints. At 95%, you're prompted to confirm/clear/cancel before the next call goes out — protects against silently exceeding the model's context window on long sessions. Default budget: 100,000 tokens. Override per session by constructing `ChatSession` with a custom `tokenBudget`.

**List existing sessions:** `npm run cli -- sessions`

### Serious mode (Gemini 3.x extended reasoning)

`--serious` enables Gemini 3.5 Flash's "thinking" variant for the call (and, in
`agents`, for every underlying sub-agent + synthesis call). Use it on hard
problems — proofs, design decisions, debugging. It spends more tokens
internally but still counts as 1 request per call against your daily quota.

```
npm run cli -- ask --serious "Prove there are infinitely many primes."
npm run cli -- agents --serious "Design a cache invalidation strategy for X."
```

For finer control: `--thinking=minimal|low|medium|high`. `--serious` is just
shorthand for `--thinking=high`. Default (no flag) uses the model's default.

### Web browsing (Google Search grounding)

`--search` enables Gemini 3.x's native Google Search grounding. The model
decides when to search, may issue multiple internal queries per call, and the
response gets a `Sources:` footer with the actual URLs cited.

```
npm run cli -- ask --search "What's the latest stable Node.js LTS?"
npm run cli -- agents --search "Compare React 19 and Svelte 5 performance benchmarks."
```

**Cost on free tier:** 5,000 grounded prompts per month across all Gemini 3.x
usage. Plenty for personal use, but use deliberately — not by default. Each
grounded prompt also consumes one of your daily-request budget on the chosen
key, same as a normal call.

Combine with other flags: `--search --serious` makes the model think *and*
verify against the web for hard questions.

### Local file tools

`--tools` gives the model three local file tools — `read_file`, `write_file`,
`list_dir` — via Gemini's function calling. The model decides which to call
and gets the results back as input to its next turn. Multi-turn loop is
capped at 10 iterations.

```
npm run cli -- ask --tools "List the files in src/ and summarize what each does."
npm run cli -- ask --tools --workdir=./scratch "Create a hello.txt with the word hello."
npm run cli -- ask --tools --trace "Read package.json and tell me the npm scripts."
```

**Sandboxing.** All file ops are scoped to `--workdir` (default: current working
directory). Paths that try to escape via `..` or absolute-paths-outside-root
return `ERROR: path escapes workdir` to the model. There is no filtering on
dotfiles — if you ask the model to read `.env`, it will read `.env`. Use
`--workdir` to scope away from anything sensitive.

**Cost.** Each tool-using request makes 2+ real model calls (one to decide on
the tool, one for the final answer, plus one per additional tool round).
Trace mode (`--trace`) shows the exact call sequence.

### Bash tool

`--allow-bash` adds a `bash` tool to the set. The model can run any shell
command in `--workdir` (cmd.exe on Windows, /bin/sh on Unix). Combined
stdout+stderr plus exit code is returned to the model.

```
npm run cli -- ask --tools --allow-bash "Run git status and summarize the state."
npm run cli -- ask --tools --allow-bash "Run npm test and tell me if anything failed."
```

**Defaults:** 30s timeout (process tree killed via `taskkill /T /F` on Windows,
SIGKILL on Unix); 50KB output cap with truncation note.

**Safety profile:** No sandbox. The model can do anything you can do — delete
files, push to git, install packages. The `--allow-bash` flag (separate from
`--tools`) is the only gate. Don't pair it with prompts that grant the model
broad autonomy unless you're prepared for the consequences.

---

## Mindmap catalyst v4 (center-split rip) — implemented

**Status:** Done. Visual refinements applied post-launch: animation starts dark (root stays dark during rip; white canvas revealed by torn panels only), arms scaled to ~32vw per arm with humanoid proportions, two-prong claw replaced with 4-finger hand-grip, MathJax typesetting added to OrbitalNode and FocusedNodeView for math in mindmap cards.

### What the user approved (locked, do not re-litigate)

A **2D robotic arm enters from the RIGHT**, punctures the chat surface at the center, and then **the chat tears in half down a vertical center seam — both halves are pulled to opposite screen edges**, revealing the white mindmap canvas that was sitting underneath the whole time (white expands outward from the center). Debris and cracks fly at the puncture; a ragged torn-paper edge runs down each half's inner (center-facing) edge. The arm(s) retract off-screen. Then the **existing v3 particle shatter+fountain plays unchanged** on the white canvas to build the orbital category nodes.

Decisions the user made explicitly (these resolve every ambiguity — honor them):
1. **Motion = center-out split, BOTH sides.** Not a single drag-right. The chat splits at center; left half exits left, right half exits right; white is revealed from the middle outward. (Matches storyboard panel 3: outward arrows, two hands, white blooming from center.)
2. **Chat content is DISCARDED.** It's being replaced by the mindmap, so the torn halves do NOT need to preserve readable chat text or fly off intact. See "the content-swap trick" below — the halves become simplified dark panels at split-time, which is fine because they're moving fast.
3. **Node build = keep the existing fountain.** Reuse the v3 `shatter`+`fountain` particle sequence verbatim; it already arcs colored particles into the category nodes. Just re-time its start to begin after the retreat.
4. **Arm stays 2D / stylized.** The flat vector arm from v3 is good enough — do NOT chase photorealism. Clean, readable, natural-looking tear beats a fancy arm.
5. **Effects wanted:** puncture cracks, scattered debris, natural ragged torn edges. "Make it look natural."

### Storyboard beats (4)

| Beat | Name | What happens |
|---|---|---|
| 1 | **ANTICIPATION** | Arm slides in from off-canvas right, claw open, horizontal, approaches screen center. Real chat fully visible + readable underneath. A beat of tension. |
| 2 | **GRIP + PUNCTURE** | Claw closes at center; arm jabs IN. White crack-flash + radiating crack lines + debris burst at the center seam. (This flash is what masks the content-swap — see below.) |
| 3 | **PULL APART** | The two halves part: left half slides left (`translateX → -110vw`) + slight CCW rotate, right half slides right (`+110vw`) + slight CW rotate. White canvas revealed from center outward. Jagged torn edge down each half's inner edge. Debris scatters with ballistic motion. A second (left) arm may assist the left half — see "one arm vs two." |
| 4 | **REVEALED: CLEAN CANVAS** | Halves gone, arm(s) retracted off-screen. Clean white canvas. Optional faint ragged edges linger at far screen edges. Then v3 shatter+fountain builds the orbital nodes on the white. |

### Architecture decision — ONE component, ONE clock (critical)

The single biggest trap: the arm lives in `CatalystOverlay` but the chat lives in `ResponseStackView` — **two components, two render trees, two potential clocks.** The arm visibly grips and tears the chat, so they MUST be frame-locked. Do NOT split timing across a CSS keyframe (chat) and a rAF loop (arm) — they will desync and the grip won't line up.

**Solution: render the torn halves INSIDE `CatalystOverlay`, driven by its single existing rAF `t` clock.** `CatalystOverlay` already owns the rAF loop that sets `t` (elapsed ms) and already receives `stageRect`. Everything — arm, both halves, cracks, debris, white-canvas-under, fountain — computes from that one `t`. No cross-component sync, no clock lift needed.

**The content-swap trick (how the halves get their look without cloning live chat):**
- Beats 1–2: the REAL `.mm-chat-list` (in `ResponseStackView`) stays visible and readable. `CatalystOverlay` renders only the arm + (at puncture) the cracks/flash on top.
- At the **puncture flash** (beat 2→3 boundary): `ResponseStackView` hides the real chat instantly (it already gets a `.collapsing` class — add `opacity:0` / `visibility:hidden` to `.mm-phase-response.collapsing .mm-chat-list` keyed to fire at the flash moment, ~700ms in). Simultaneously `CatalystOverlay` mounts two **simplified dark torn-half panels** (just the chat's dark bg color `oklch(0.16 0.01 60)` ≈ `--mm-bg`, with a jagged inner clip-path; NO live text). Because the puncture white-flash covers the screen center for ~120ms AND the halves immediately accelerate apart, the eye never registers that the text vanished. This avoids cloning/snapshotting live React DOM entirely.
- This is the pragmatic, performant, single-clock path. Do not try to literally split the live chat element in two — one DOM element cannot translate two halves in opposite directions, and cloning the React subtree twice is heavy and fiddly.

### One arm vs two

Storyboard panels 1–2 clearly show ONE arm entering from the right; panel 3 shows what reads as two hands parting the halves. **Recommended:** primary arm enters from the right (beats 1–2, faithful to panels 1–2); at puncture, a **mirrored second arm enters from the left** to grab the left half; both pull apart in beat 3 (faithful to panel 3). The second arm is the first arm's SVG mirrored on X — cheap to add. If that feels too busy when you see it live, fall back to a single right arm that pulls the right half while the left half is flung left by "tear momentum" (no left arm). Implementer's judgment — but two mirrored arms is the most faithful to the sketch.

### Concrete timeline (rewrite `COLLAPSE_TIMELINE`, app.jsx ~line 1553)

Total ~2400ms (same as v3). All windows `{ start, dur }` in ms:
```
anticipation { start:    0, dur: 520 }   // right arm slides in, claw open, decel (easeOut)
puncture     { start:  520, dur: 200 }   // claw snaps shut, jab in, crack-flash + debris spawn; left arm enters
pull         { start:  720, dur: 720 }   // halves part to opposite edges (easeIn accel); real chat hidden from here
retreat      { start: 1440, dur: 300 }   // arms continue off-screen, claws open
shatter      { start: 1740, dur: 200 }   // v3 particle cluster spawns at center (UNCHANGED logic, re-timed)
fountain     { start: 1940, dur: 460 }   // v3 particles arc to orbital node positions (UNCHANGED logic, re-timed)
total: 2400
```
Tune by eye, but keep `pull` the longest non-fountain beat and keep shatter+fountain ≈ the v3 durations so the node-build still reads well.

### Per-beat math (replace the v3 `armX/armY/armRotZ/clawOpen` block, app.jsx ~lines 1619–1650)

Coordinates are px offsets from screen center; positive X = right. Right arm "home" (gripping center) is `armX ≈ 90` (claw tip reaches center). Use `easeOutCubic`/`easeInCubic` helpers already defined in the function.

- **anticipation:** right arm `armX: +700 → +90` (easeOut), horizontal so claw points LEFT toward center (`armRotZ ≈ 90°` since the v3 arm is drawn vertical — rotate it to horizontal). `clawOpen: 1`.
- **puncture:** `clawOpen: 1 → 0`; small inward jab `armX: +90 → +70 → +90` (sin bump); fire `crackT` (cracks animate) and `debris` spawn. Left arm: `armX: -700 → -90` over this window (mirror).
- **pull:** right arm `armX: +90 → +760` (easeIn); left arm `armX: -90 → -760`. Each half's translate is tied to its arm's X so the grip stays glued: `rightHalfX = armX_right - 90`, `leftHalfX = armX_left + 90` (so at pull-start both are 0). Add slight rotate per half (`±4°`) and a tiny `skewY` for the peel feel.
- **retreat:** arms `±760 → ±1300`, `clawOpen → 1`.
- After retreat: arms `armVisible = false`.

White reveal is NOT a radial wipe anymore — it's just the `.mm-canvas-under` layer (always full-white, behind everything) becoming visible as the dark halves slide away. No `revealRadius` math.

### Effects (all inside CatalystOverlay, all from `t`)

- **Crack-flash (puncture):** a short white radial pop at center (reuse the v3 `.mm-rip-flash` div, re-timed to `puncture.start`), opacity `1→0` over ~160ms. This is the swap-masker.
- **Crack lines (puncture→pull):** SVG `<g>` of 7–10 jagged polylines radiating from center, each animated via `stroke-dasharray`/`stroke-dashoffset` from hidden→full over ~150ms so they "shoot out," then fade during `pull`. Dark stroke (`oklch(0.30 0.01 60)`) on the dark chat, or white on the revealing canvas — pick whatever reads (probably dark, since they're cracks IN the dark chat).
- **Debris (puncture→pull):** 16–24 small SVG `<polygon>` triangles spawned at center on puncture. Give each a random initial velocity (outward + upward bias) and apply gravity per frame: `x = cx + vx*τ`, `y = cy + vy*τ + 0.5*g*τ²` where `τ` = seconds since puncture. Random size 3–9px, random rotation. Fade out by end of `pull`. Color = dark chat fleck.
- **Torn edges:** each dark half gets a jagged **inner** (center-facing) edge via `clip-path: polygon(...)`. Build the polygon with ~8–12 points down the seam, each with a small random horizontal jitter (±6–10px) so it reads as torn paper, not a clean sawtooth. Generate the point list once (useMemo) so it's stable across frames. The far (outer) edges stay straight. Optionally leave a faint 1–2px ragged SVG strip at the extreme screen edges during `mindmap` (subtle, optional).

### White canvas layer (replaces the v3 radial wipe)

- Add `.mm-canvas-under` — `position:absolute; inset:0; background: oklch(0.98 0.005 95); z-index:` just below the chat list and below the catalyst overlay's arm/halves but ABOVE the atelier background. Mount it during `collapsing` and `mindmap`; it's the white that the parting halves reveal.
- **Delete** the v3 `.mm-canvas-reveal` radial-gradient div and ALL its `revealRadius`/`revealP` logic in `CatalystOverlay`.
- The `[data-phase="collapsing"]`/`[data-phase="mindmap"]` palette overrides in `style.css` (~line 3287) that flip `--mm-bg`/`--mm-fg`/`--accent` to ivory/charcoal/ink-blue and restore on `imploding` are **CORRECT — keep them unchanged.** They make the orbital nodes + thread strip frosted-white automatically.

### Reused vs deleted

| Reuse (keep) | Delete / replace |
|---|---|
| The 2D arm SVG group (mirror it for the 2nd arm) | v3 arm motion (upper-right entry, LEFT yank) |
| `shatter` + `fountain` particle blocks (re-time only) | `.mm-canvas-reveal` div + `revealRadius`/`revealP` |
| `.mm-rip-flash` (re-time to puncture) | v3 `mm-chat-tear` keyframe (goes LEFT) |
| `[data-phase=...]` palette overrides in CSS | v3 `mm-seam-snatched` keyframe |
| `easeInCubic`/`easeOutCubic` helpers | The "arm rips the door" comments describing v3 |

### Files to touch
- [src/web/static/app.jsx](src/web/static/app.jsx): `COLLAPSE_TIMELINE` (~1553) and `CatalystOverlay` (~1564–1990). Rewrite the timeline + arm block + reveal; ADD the two torn-half panels, crack lines, debris, second arm; KEEP shatter/fountain. In `ResponseStackView` (~2106) the chat already gets a `.collapsing` class — no JS change needed there beyond confirming the chat hides at the puncture moment via CSS.
- [src/web/static/style.css](src/web/static/style.css): add `.mm-canvas-under`, the two torn-half base styles, `.mm-phase-response.collapsing .mm-chat-list { opacity: 0 }` (with a delay matching `puncture.start` ≈ 700ms so the real chat stays through beats 1–2), torn-edge clip-path helpers. Remove `.mm-canvas-reveal`, `mm-chat-tear`, `mm-seam-snatched` (~3316–3335). Keep the `[data-phase=...]` palette overrides (~3287–3375).

### Verification
1. `npm run web`; open `http://localhost:7421`; send a prompt; wait for the response; click **BURST INTO MINDMAP**.
2. Expect, in order: right arm enters → claw grips center → white crack-flash + cracks + debris → chat splits, both halves slide to opposite edges with torn inner edges revealing white from center → arms retract off-screen → particle fountain builds the orbital nodes on white.
3. Phase progression must stay `response → collapsing → mindmap → (click COLLAPSE TO THREAD) → imploding → response`, and the atelier charcoal theme must restore on `imploding`.
4. The content-swap (real chat → dark halves) must be invisible to the eye — if you can see the text "blink out" before the split, the chat is hiding too early or the flash is too weak/mistimed. Fix by aligning the `.mm-chat-list` opacity-hide exactly to `puncture.start` and ensuring the crack-flash covers center at that instant.
5. `npm run typecheck` (clean) and `npm test` (230 passing) must both stay green. Pure-frontend change, but run both. Use the Claude Preview MCP (`preview_start` on the `multi-agent-web` config, then `preview_eval` to drive the burst + sample `data-phase` and element positions) to verify without watching by hand — that's how prior catalyst work was verified.

### Gotchas (learned from v3)
- Don't unmount the chat mid-animation via React — hide it with CSS (`opacity`/`visibility`) and let the parent unmount it only when `phase` flips to `mindmap`. Unmounting mid-frame drops `liveTurn`/`responses` state and can crash the transition.
- The torn-edge clip-path point list must be `useMemo`'d (stable), or it'll re-randomize every frame and the edge will "boil."
- Keep debris count modest (≤ ~24). It's a 2.4s one-shot; SVG with a few dozen nodes is fine, hundreds is not.
- `stageRect` can be `{w:0,h:0}` for the first frame or two — guard all geometry on `stageRect?.w` like the existing code does.

---

## Planned: OpenRouter fallback routing

OpenRouter accepts a list of models on every request. If the first choice fails or rate-limits, the request automatically runs against the next one in the list — same response shape, same SDK, no app-side changes. This is a cheaper-to-build alternative to the per-provider router we already have, and worth bolting on at the OpenRouter provider layer specifically (it doesn't replace the multi-provider Router — it strengthens the OpenRouter slot inside it).

```python
client.chat.completions.create(
  model="anthropic/claude-sonnet-4.6",
  extra_body={
    "models": [
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
      "google/gemini-3.1-pro-preview"
    ],
    "route": "fallback"
  },
  messages=[{"role": "user", "content": "..."}]
)
```

Things worth knowing (per OpenRouter's docs):

- List order is priority order — OpenRouter walks it top to bottom.
- No extra fee for fallback routing; you pay for whichever model actually serves the request.
- Rate limits, 5xx errors, content refusals, and context-length errors all count as failures, and the next model picks up automatically.
- Providers can be mixed within the same chain (Anthropic + OpenAI + Google is fine).

**Where it would plug in.** `src/providers/openrouter.ts` already constructs a single-model OpenRouter call. The fallback chain would be threaded through `CompleteOptions` (so callers can override per-call, e.g. `reasoning` role uses a different chain than `action-code`) and configured per-role via the role registry. The user has flagged this as optional and is still deciding on exact reroute chains — when those land the implementation should be ~50 lines + a config schema bump.

## Testing

- `npm test` — full mocked suite, runs in under 1s. **Always run before committing.**
- `npm run test:watch` — vitest watch mode.
- `npm run typecheck` — TypeScript strict-mode check, no emit. Should always pass.
- `npm run smoke` — single real round-trip to confirm at least one key works (1 quota).
- `npm run verify-keys` — calls every configured key once, prints ✓/✗ per slot (1 quota per key).

**Test layout mirrors source.** `tests/router.test.ts` covers `src/router.ts`, etc. New tests go in the matching file. `tests/fixtures.ts` provides `FakeProvider` (for `complete()` paths) and `ToolFakeProvider` (for tool-use paths) — both let you script deterministic responses.

**Test discipline:**
- Always cover new functionality with mocks first; only spend real quota when validating the API integration path itself (provider implementations, end-to-end behavior).
- Tests that don't care about backoff should opt out via `maxRetryWaitMs: 0` — keeps the suite fast (the default 90s wait would otherwise stall any test that legitimately exhausts a pool).
- Tests that exercise the parallel-mode Controller should opt out of dispatch stagger via `dispatchStaggerMs: 0` for the same reason.

## How to extend: add a new provider

1. **Create** `src/providers/<name>.ts` implementing the `Provider` interface from `src/provider.ts`:
   - Required: `id`, `model`, `complete()`, `isRateLimitError()`, `retryAfterMs()`.
   - Optional but recommended: `completeWithTools()` for function calling support.
2. **Add a loader** in `src/config.ts` that reads the provider's env key (e.g., `GROQ_KEY`) and constructs Provider instances. Follow the `loadGeminiProvidersFromEnv` pattern.
3. **Export** the provider class + loader from `src/index.ts`.
4. **Wire into the Router** in `src/index.ts`'s default-router builder or in `src/cli.ts`'s `buildRouter()`. Just push the new provider(s) into the pool array.
5. **Write tests** in `tests/<name>.test.ts` — minimum coverage:
   - `isRateLimitError` handles the provider's actual error shape (status code, error field name, message strings).
   - `retryAfterMs` parses whatever header/field the provider uses.
   - If implementing tool use: history conversion + response parsing.
6. **Document** the env var in `README.md` setup table + in `.env.example`.

The Router does NOT need changes — it's provider-agnostic. As long as your Provider correctly classifies rate-limit errors, all rotation/cooldown/backoff machinery works automatically.

## How to extend: add a new CLI command

1. Add a new `cmdX()` function in `src/cli.ts`.
2. Add the command name to the dispatcher's `if (command === ...)` chain in `main()`.
3. Update `printHelp()` to document the command and its flags.
4. If introducing new flags, register them in the `parseArgs({ options: ... })` call.
5. Update the CLI section of `README.md` per the CLAUDE.md convention.

## Known gotchas

- **Gemini 3.x requires `thoughtSignature` echoed back on multi-turn tool calls.** Without it, the API returns 400 with "Function call is missing a thought_signature." Captured in `parseToolResponse`, re-attached in `historyToGeminiContents`. Don't strip it from `ToolCallRequest.signature`.
- **Windows `child.kill()` only kills `cmd.exe`, not its descendants.** A spawned `node` subprocess keeps running. `BashTool` uses `taskkill /F /T` to kill the entire process tree. Without this, timeout tests hang indefinitely and workdir cleanup fails with EPERM.
- **OpenRouter free models require the `:free` suffix in the model ID.** Without it, calls go to the paid version (rejected if you have no credits). When constructing OpenRouter Provider model IDs, always use `:free`.
- **Groq and OpenRouter rate-limit account-wide, not per-model.** Putting two models from the same provider into the pool doesn't double quota — they fight for the same bucket. Use different providers for different roles when possible.
- **Gemini rate-limits per-project, not per-key.** Generating 3 keys inside one Google Cloud project = 3 strings sharing one quota pool. To actually scale, use 3 separate projects (recommended) or 3 separate Google accounts (Sybil — ToS gray area).
- **PowerShell wraps native exe stderr as red error text.** A successful `git push` will look like a failure in PowerShell output. Look at the final lines and exit codes for the real outcome, not the red wrapper.
- **Backoff `maxRetryWaitMs` must exceed the typical cooldown duration.** Default cooldown is 60s; default `maxRetryWaitMs` is 90s. With matching values, the retry math gives up at the boundary before sleeping. Found this the hard way in live testing.
- **State file at `~/.multi-agent/state.json` persists across runs and across tests if you ever point a `FileStateStore` at the default path.** Tests should use `InMemoryStateStore` or temporary paths.
- **Role routing iterates candidates in priority order, not via the Router's round-robin.** Earlier versions built a multi-provider allow-list per role and let the Router pick — that defeated role priority because the round-robin cursor decided which one got the call, not the role's primary. `RoleResolver.runRole` now iterates candidates one-at-a-time with a single-element allow-list each, falling through to the next only when the current is fully exhausted.
- **OpenRouter `:free` models require a $10 credit top-up for the standard rate limit.** Without credits, `:free` slugs return `402 insufficient_quota` (which our error classifier currently treats as a rate-limit because the body contains "quota"). One-time deposit, not a subscription. If you see all-failures on every OpenRouter attempt, this is almost certainly why — direct-curl returns the explicit "Out of credits" message.
- **Gemini SDK abstracts response headers.** `@google/generative-ai` returns parsed objects, not raw `Response`s, so we never see `X-RateLimit-*` headers Google may or may not send. That's why all `gemini:N` and `gemma:N` rows in the usage display tag as `[est.]` — they use the local sliding-window counter, not header-reported live values. The OpenAI-compat providers (Groq / OpenRouter / Cerebras / Mistral) tag as `[live]` once they've received a response that carried the headers.
- **Gemma slots and Gemini slots share a Google Cloud project but have INDEPENDENT per-model RPD pools.** This is what makes the Gemma safety net work — exhausting `gemini:1` Flash quota doesn't touch the `gemma:1` Gemma quota even though they're the same key. Don't conflate them when reading the sidebar: row count = 6 Google-side rows (3 Flash + 3 Gemma) on 3 keys.
- **Gemini `RetryInfo.retryDelay` parsing.** When Gemini 429s with a body like `Please retry in 35.9s. [{"@type":"...RetryInfo","retryDelay":"35s"}]`, we parse the structured `retryDelay` field (with English fallback) so the pool cools for exactly the duration Google asked, not the 60 s default. See `parseGeminiRetryDelayMs`. The match is on a substring (`"retryDelay":"..."`) rather than the full JSON array because sibling objects can have inner brackets like `"links":[]` that break naive array-bracket matchers.
- **The 20-RPD Gemini Flash "legacy free" quota is a thing.** Newer Google Cloud projects ship with this much-smaller free-tier cap (20 RPD, 5 RPM) instead of the 1,500 RPD Google quotes as the headline. The sidebar's `RPD x/1500` gauge is a config-time estimate, not a live header read — so if you see `RPD 4/1500` and then get rate-limited, you've hit the 20-cap, not the 1500-cap. The Gemma slot on the same key is your reliable workaround.

## Project conventions

A `CLAUDE.md` file at the repo root documents standing rules for any Claude-Code session working on this project. The two most important:

> **1. Any meaningful or permanent change MUST update `README.md` in the same commit.**

> **2. After every completed task, commit + push to GitHub before moving on.** Push is part of "done."

Bug fixes that preserve behavior, internal refactors, dependency bumps don't need README changes — but they still need to be pushed when complete.

Other standing rules in CLAUDE.md: never commit `.env`, never weaken `.gitignore`, never migrate language/stack without explicit user approval, flag credential leaks if the user pastes keys in chat.
