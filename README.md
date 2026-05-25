# multi-agent

A multi-agent AI orchestration system built on free-tier LLM APIs, designed for $0 personal use with token-efficient inter-agent communication and graceful failover across multiple accounts/providers.

**Status:** All six stages live (Stage 6 multi-provider role architecture + Stage 5a streaming chat web UI both shipping). CLI + web UI both route through a shared smart-routed `ChatSession` over 10 provider instances (3 Gemini 3.5 Flash + 3 Gemma 3 27B + OpenRouter / Groq / Cerebras / Mistral) with **live RPM/RPD scraping from `X-RateLimit-*` headers** where providers expose them. Perception's Flash key is isolated; orchestration/reasoning share the other two. CLI local file access is on by default.

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
- **6 roles × custom fallback chains** — perception's Flash key isolated; orchestration/reasoning share two Flash keys; Gemma 3 27B is the universal safety net (~14,400 RPD/key on free tier)
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
| **orchestration** | `gemini:1 → gemini:2 → openrouter:deepseek-v4-flash → gemma:1 → gemma:2 → gemma:3` | Light-touch routing decisions; Gemini Flash is the right shape. Falls to DeepSeek V4 Flash on OpenRouter when both Flash keys are cool, then to Gemma 3 27B (different model = independent quota pool on the same Google project) as the safety net. |
| **reasoning** | `gemini:1 (thinking=high) → gemini:2 (thinking=high) → openrouter:deepseek-v4-flash → gemma:1 → gemma:2 → gemma:3` | Same chain shape but `thinking=high` mode on the Gemini hops; reasoning quality on Gemini Flash with extended thinking is at least as good as DeepSeek V4 Flash on Aider/GPQA, and the DeepSeek slot is preserved as the dedicated-reasoning fallback. DeepSeek R1 free was retired by OpenRouter (404 on every `:free` slug). |
| **perception** | `gemini:3 (useSearch=true) → gemma:1 → gemma:2 → gemma:3` | **`gemini:3` is reserved exclusively for perception** — it is NOT listed in orchestration or reasoning candidates, so heavy chat traffic can't drain the one Flash slot that has Google Search grounding. Gemma fallback exists for liveness even though it loses live web data when it takes over. |
| **action-code** | `mistral:codestral → gemma:1 → gemma:2 → gemma:3` | Mistral Codestral, code-specialized, ~1 B tokens / month free. Gemma falls in below. Gemini Flash is intentionally NOT in this chain — it's reserved for perception/orchestration/reasoning where it actually matters. |
| **action-structural** | `groq:llama-70b → gemma:1 → gemma:2 → gemma:3` | Groq Llama 3.3 70B, 1000 RPD on its own quota. |
| **action-repetitive** | `cerebras:llama3-8b → gemma:1 → gemma:2 → gemma:3` | Cerebras Llama 3.1 8B, 1 M tok / day, wafer-scale inference. |

**Why Gemma 3 (or 4 once published) as the universal safety net?** On Google AI Studio's free tier, every model has a **separate per-project RPD quota pool** — Gemini 3.5 Flash is capped at 20 RPD / project on the legacy free tier, but Gemma 3 27B-it has ~14,400 RPD / project. The same `GEMINI_KEY_N` therefore serves two independent rate-limit pools: a small premium one (Flash) and a huge bulk one (Gemma). Listing both keys' Gemma slots at the end of every chain means the system *never* hits "all providers exhausted" under normal load.

**Why `gemini:3` is reserved.** Without isolation, the chat orchestrator can fire 3-6 Gemini Flash calls per turn (plan → specialists → synthesis → mindmap pre-fetch), which would burn through all three Flash keys' daily 20-RPD caps within an hour of testing. Reserving one key for perception means searches against live web data still work even when chat has eaten the other two keys.

**Gemma 3 vs Gemma 4.** As of May 2026 the production model slug on AI Studio is `gemma-3-27b-it`. If Google publishes Gemma 4, change the `model` argument to `loadGemmaProvidersFromEnv()` in `src/config.ts` — the provider implementation is model-agnostic since Gemma uses the same `GoogleGenerativeAI` SDK as Gemini.

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
- [x] Stage 6: Cerebras provider + Llama 3.1 8B as `action-repetitive` (live-verified; Llama 4 Scout moved off the standard model list, 3.1 8B is the right shape for bulk/speed)
- [x] Stage 6: Mistral provider + Codestral as `action-code` (live-verified via `--role=action-code`)
- [x] Stage 6: roster-aware orchestrator (`task` command — orchestrator picks roles per task, dispatches in parallel, synthesizes)
- [x] Stage 5a: browser UI (live-verified end-to-end against real Gemini — idle / loading / response / mindmap phases all work for research / code / compare / plan templates; burst-card layout fixed + responsive breakpoints added)
- [x] Stage 5a: streaming chat + big-bang mindmap (vertical-scroll conversation with user/AI bubbles and smooth-scroll-to-newest; **streaming tokens via `/api/chat-stream` SSE** so the bubble fills in real-time; **live LoadingView agent rows** driven by real plan/role events; persistent smart-routed `ChatSession` turns; **Cerebras-pre-fetched mindmap categorization** via `action-repetitive` role with a "preserve all detail" prompt, local `deriveMindmapData` fallback; **rip-seam catalyst** with glowing void + **agent-colored fanning particles** so the 5 agents visually become the mindmap categories; click-to-focus per-node expansion with pre-filled scoped prompt; explicit 2-6 branch angle tables; box-edge connector trim; Atelier warm theme; mobile responsive with quota drawer; LS keys `lattice.responseStack.v2` and `lattice.chatSessionId.v1`)
- [x] Stage 6: **Gemma 3 27B-it slots wired per Gemini key** (`gemma:1/2/3` — separate per-model quota pool on the same Google project; ~14,400 RPD vs Flash's 20-1,500. Universal safety net at the end of every role's candidate chain in `default-registry.ts`.)
- [x] Stage 6: **Perception role isolated to `gemini:3`** — that Flash key is reserved exclusively for perception, so chat traffic on the other roles can't drain the one Gemini Flash slot with Google Search grounding.
- [x] Stage 6: **Live RPM/RPD from `X-RateLimit-*` response headers** (Groq / OpenRouter / Cerebras / Mistral) via `provider.getLastQuota?()` + `onHeaders` callback in `openai-compat.ts`. CLI's `usage` and web sidebar tag each gauge with `live` vs `est.` so you know which numbers come from the wire.
- [x] Stage 6: **Per-provider default cooldowns** — `DEFAULT_COOLDOWN_MS` table in `src/config.ts` (OpenRouter 10 s, others 60 s); response-header `Retry-After` always wins.
- [x] Stage 4: **CLI local file access on by default** for `ask` — `--no-tools` to opt out.
- [ ] Stage 5b: optional bot integrations (Telegram / Discord). Instagram bot idea removed.
- [ ] Provider-layer: OpenRouter fallback-routing (single OpenRouter call with a list of candidate models; OR walks the list top-to-bottom on 429/5xx/refusal/context-overflow — see [Planned: OpenRouter fallback routing](#planned-openrouter-fallback-routing))
- [ ] Web UI: mindmap transition **v3** — "robot arm rips the door, opens to a canvas-like (white) dimension, agents fly out, fades into mindmap" (current v2 is the seam-rip catalyst)
- [ ] Parse Gemini `RetryInfo.retryDelay` from `GoogleGenerativeAIError` so cooldowns reflect Gemini's own per-minute reset hint (currently we fall back to 60 s default for Gemini since the SDK doesn't surface `Retry-After`)
- [ ] Brave Search / DuckDuckGo Instant Answer tool for the Gemma perception fallback (when `gemini:3` is exhausted and the resolver falls to Gemma, give it a search tool so live web data isn't lost entirely)

Quality-of-life proposals (not yet started, ordered by likely user value):

- [ ] **Quota warning banner in the chat** — when any role drops below 10 % remaining OR the conservation policy flips to serial mode, surface a one-line banner above the composer naming the role and its likely fallback. The data is already in `/api/usage.json`; this is a UI add only.
- [ ] **Stop button during streaming** — a small `■` next to the composer while a turn is in flight, aborting the `/api/chat-stream` fetch and rolling the in-flight `liveTurn` back. Saves quota on bad turns.
- [ ] **Fast-mode toggle** — composer-bar switch that bypasses smart routing for the next turn (sends straight through the orchestration role, single call, ~10 s instead of 20–45 s). Useful for short conversational turns where multi-agent depth is overkill.
- [ ] **Settings drawer (CLI feature parity)** — surface `--serious` / `--thinking=high`, `--search`, `--role=` forced routing as toggles in the UI, so the web UI matches the CLI's full flag surface. Closes the "merge function into UI" thread.
- [ ] **PhaseErrorBoundary around loading + response phases** — currently only the orbital phase is wrapped; defensive coverage so any future render crash anywhere in the SPA shows a recoverable panel instead of blacking the page.

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
- **`RoleConfig` / `RoleResolver`** (`src/roles/`) — Stage 6: functional role → ordered list of candidate providers. Resolver picks the first registered + non-cooling candidate and calls the Router constrained to that provider subset. Defaults in `default-registry.ts` (live chains as of May 2026: see the *Role fallback chains* table above). All five non-Gemini providers (Groq, OpenRouter, Mistral, Cerebras) are wired plus Gemma 3 slots; perception's `gemini:3` is reserved exclusively to keep Google Search grounding alive when chat traffic drains the other Flash keys.

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

**Gemma slots come free with each Gemini key.** No separate signup — every `GEMINI_KEY_N` is automatically registered twice: once as `gemini:N` (Flash) and once as `gemma:N` (Gemma 3 27B-it). The two share a Google Cloud project but draw from **independent per-model RPD quota pools** on the free tier (Flash ≈ 20–1,500/day depending on project age; Gemma 3 ≈ 14,400/day). Doubles your effective Google-side headroom at zero cost.

**Note on Gemini Flash free-tier limits.** Google quotes "1500 RPD" as the headline number, but newer projects ship with a much smaller **20 RPD legacy quota** (5 RPM) until upgraded. If you see `429 RESOURCE_EXHAUSTED` quickly on a key, that's the 20-RPD cap — known and expected; the Gemma slot on the same key is your safety valve. The estimated daily budget in the sidebar's "EST" column may overstate the actual headroom in that situation.

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
- **Gemini `RetryInfo.retryDelay` in error messages is not yet parsed.** When Gemini 429s with a body like `"Please retry in 35.9s. ... retryDelay: 35s"`, our code currently falls back to the per-provider `DEFAULT_COOLDOWN_MS` (60 s). Tracked as a planned improvement; live cooldowns will be shorter once we parse the field.
- **The 20-RPD Gemini Flash "legacy free" quota is a thing.** Newer Google Cloud projects ship with this much-smaller free-tier cap (20 RPD, 5 RPM) instead of the 1,500 RPD Google quotes as the headline. The sidebar's `RPD x/1500` gauge is a config-time estimate, not a live header read — so if you see `RPD 4/1500` and then get rate-limited, you've hit the 20-cap, not the 1500-cap. The Gemma slot on the same key is your reliable workaround.

## Project conventions

A `CLAUDE.md` file at the repo root documents standing rules for any Claude-Code session working on this project. The two most important:

> **1. Any meaningful or permanent change MUST update `README.md` in the same commit.**

> **2. After every completed task, commit + push to GitHub before moving on.** Push is part of "done."

Bug fixes that preserve behavior, internal refactors, dependency bumps don't need README changes — but they still need to be pushed when complete.

Other standing rules in CLAUDE.md: never commit `.env`, never weaken `.gitignore`, never migrate language/stack without explicit user approval, flag credential leaks if the user pastes keys in chat.
