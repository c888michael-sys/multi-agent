# multi-agent

A multi-agent AI orchestration system built on free-tier LLM APIs, designed for $0 personal use with token-efficient inter-agent communication and graceful failover across multiple accounts/providers.

**Status:** Working CLI on top of Gemini 3.5 Flash (3-project pool) with conservation mode, agent orchestration (parallel + specialist), web search, local file tools, and bash exec. Next phase: multi-provider role-based architecture (Stage 6).

---

## What this is

A TypeScript CLI + library that runs agent workflows across free-tier LLM APIs, with token-efficient inter-agent communication, persistent usage tracking, and graceful failover across multiple accounts and providers. Designed so that the orchestrator picks the right *role* for each task (perception, reasoning, action, etc.) and the right *model* for each role is just configuration.

## Capabilities at a glance

**Live and tested** (against Gemini 3.5 Flash, free tier):

- Multi-account / multi-project rotation with cooldown tracking + automatic failover
- Conservation mode (round-robin ↔ serial with hysteresis based on remaining quota)
- Persistent per-provider usage stats (`~/.multi-agent/state.json`, resets at UTC midnight)
- Parallel and specialist multi-agent orchestration with token-efficient synthesis
- "Serious" mode using Gemini 3.x extended reasoning (`thinkingLevel: high`)
- Google Search grounding for live web data — free up to 5000 grounded prompts/month
- Local file tools (`read_file`, `write_file`, `list_dir`) sandboxed to a working dir
- Bash exec tool with timeout, output cap, and process-tree kill on Windows
- Backoff-and-retry when all providers are cooling
- CLI: `ask`, `agents`, `usage`, `verify-keys`, `smoke`

**In progress / not yet built:**

- Role-based multi-provider architecture (Stage 6 — adds Groq/OpenRouter/Mistral/Cerebras, lets each functional role use the best-suited model)
- Multi-turn conversation + automatic context management
- Web UI + bot integrations (Stage 5)

## Build order

The full vision is large, so the work is decomposed into independent stages. Each stage stands alone and gets its own design + implementation cycle.

### Stage 1 — `llm_router` (foundation) ← starting here

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

### Stage 5 — web UI + bot integrations (e.g., Instagram)

Explicitly out of scope until 1–4 are working.

### Stage 6 — multi-provider role-based architecture ← next

Functional roles replace fixed sub-agent rosters. Each role declares a *capability requirement*; each model is configured to fill one or more roles. Same orchestrator code regardless of model assignments.

**Roles:**

| Role | Description | Primary model | Why |
|---|---|---|---|
| Perception | Data collection (web browsing, document reading) | Gemini 3.5 Flash + `--search` | Only free model with native Google Search grounding |
| Reasoning | Plan-of-attack, hard decisions, deliberation | DeepSeek V4 Flash (284B MoE / 13B active) via OpenRouter | Strongest free reasoning model on OpenRouter as of May 2026; 1M context; native reasoning. R1 free retired by OpenRouter — V4-Flash is the current free option in the same family |
| Orchestration | Decide which role(s) to invoke; synthesize outputs | Gemini 3.5 Flash (default mode) | 1M context fits roster + intermediate state; low hallucination matters for routing |
| Action A (code) | Code-specialized execution | Codestral via Mistral | Code-specialized; generous Experiment-plan quota |
| Action B (structural) | General execution; formatting; structured outputs | Llama 3.3 70B via Groq | 300 tok/sec; 1000 RPD on its own pool |
| Action C (repetitive) | Bulk, high-volume tasks | Llama 3.1 8B via Cerebras | 1M tokens/day; wafer-scale inference at ~2000 tok/sec. Llama 4 Scout (mentioned in some 2026 marketing) was moved off the standard model list — 3.1 8B is the right shape for bulk repetitive work anyway |

**Quota isolation:** every role draws from a *different* provider's quota pool, so heavy use in one role doesn't starve the others. No two of our roles share an account-wide rate limit.

**Build order within Stage 6:**

1. Role abstraction layer (`RoleConfig`, `RoleResolver`) over the current Router. No behavior change initially; existing Gemini calls just routed through the new layer.
2. Add Groq provider; register Llama 3.3 70B as `action-structural`.
3. Add OpenRouter provider; register DeepSeek R1 as `reasoning`.
4. Add Cerebras provider; register Llama 4 Scout as `action-repetitive`.
5. Add Mistral provider; register Codestral as `action-code`.
6. Roster-aware orchestrator: Gemini picks which role(s) to invoke per task.

Stage 6 adds ~4 new TS providers but does not change Stages 1–4 behavior except where the orchestrator gains awareness of the new roles.

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

**Acknowledged risk.** Free-tier scaling beyond a single project is a Google ToS gray area. Multi-accounting (Sybil) is the more clearly forbidden pattern; multi-project under one account is architecturally supported and the lower-risk path for scaling. This is a personal project; the risk has been weighed and accepted.

---

## Roadmap checklist

- [x] Stage 1: implementation
- [x] Stage 1: tests against mocked HTTP
- [ ] Stage 1: smoke test against 2 real Gemini accounts (waiting on keys)
- [x] Stage 2: conservation mode (round-robin ↔ serial with hysteresis; per-provider usage tracking)
- [x] Stage 3: orchestrator + specialist/parallel modes + token-efficient synthesis
- [x] Stage 3: end-to-end demo verified live against Gemini 3.5 Flash
- [ ] Stage 3: prompt tuning pass (currently functional but verbose)
- [x] Stage 4: local CLI (`ask`, `agents`, `usage`)
- [x] Stage 4: serious mode (`--serious` / `--thinking=<level>`) — Gemini 3.x extended reasoning
- [x] Stage 4: backoff-and-retry when all providers cooled (default cap: 60s wait per call)
- [x] Stage 4: parallel dispatch stagger (300ms default) so 3 agents don't hit the per-minute window in the same wall-clock ms
- [ ] Stage 4: calibrate `estimatedDailyBudget` from real AI Studio limits
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
- [x] Stage 5a: response stack + big-bang mindmap (composer pins to bottom, newest B pops out of composer with older B's pushed up, hint at top pulls down to singularity-collapse then burst-from-center with gentle float; LS key bumped to `lattice.responseStack.v2`)
- [ ] Stage 5b: bot integrations (Telegram / Discord / Instagram)
- [ ] Provider-layer: OpenRouter fallback-routing (single OpenRouter call with a list of candidate models; OR walks the list top-to-bottom on 429/5xx/refusal/context-overflow — see [Planned: OpenRouter fallback routing](#planned-openrouter-fallback-routing))

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
    web/                — Stage 5a (browser UI; not live-verified — see handover notes)
      server.ts         — built-in http server, static + /api/* routes
      static/
        index.html      — SPA shell
        style.css       — visual styles (from claude.ai/design handoff bundle)
        app.jsx         — HeroMindmap React component (adapted from handoff)
        templates.jsx   — template defs + burst renderers (from handoff)
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
                  ┌─────────────────────────────┐
                  │ CLI (src/cli.ts)            │
                  │  ask / agents / usage       │
                  └──────────────┬──────────────┘
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
- **`RoleConfig` / `RoleResolver`** (`src/roles/`) — Stage 6: functional role → ordered list of candidate providers. Resolver picks the first registered + non-cooling candidate and calls the Router constrained to that provider subset. Defaults in `default-registry.ts`. Currently all roles fall back to Gemini until other providers are wired (steps 2-5 of Stage 6).

## Setup

### Minimal (Gemini only)

1. Provision N independent Gemini quota buckets — separate Google Cloud projects under one account (up to 25 per account; lower ToS risk than multi-account). Generate one API key per project at https://aistudio.google.com/apikey.
2. `cp .env.example .env` and fill in `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`, ...
3. `npm install`
4. `npm test` — mocked test suite, no real quota
5. `npm run verify-keys` — calls each configured key once (1 request per key)
6. `npm run smoke` — single round-trip through the router (1 request)

### Multi-provider (Stage 6)

For the full role-based architecture, add keys for any of these providers (each role degrades gracefully if its provider's key is missing):

| Env var | Provider | Sign-up URL | Free tier |
|---|---|---|---|
| `OPENROUTER_KEY` | OpenRouter | https://openrouter.ai → Keys | ~50 req/day across all free models combined |
| `GROQ_KEY` | Groq | https://console.groq.com → API Keys | 30 RPM / 1000 RPD account-wide |
| `MISTRAL_KEY` | Mistral | https://console.mistral.ai → API Keys (phone verification required) | 1B tokens/month on Experiment plan |
| `CEREBRAS_KEY` | Cerebras | https://cloud.cerebras.ai → API Keys | 1M tokens/day, 30 RPM |

## CLI

```
npm run cli -- ask "your prompt here"
npm run cli -- agents "your prompt here"                    # parallel, 3 default agents
npm run cli -- agents --mode=specialist "your prompt"       # specialist routing
npm run cli -- agents --trace "your prompt"                 # print per-agent outputs
npm run cli -- usage                                        # cumulative usage (persisted across runs, daily UTC reset)
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

1. **Falls back through the role's own candidate list first** (e.g., reasoning: DeepSeek V4 → Gemini-thinking-high fallbacks).
2. **If the role's whole candidate list is exhausted**, borrows ANY healthy provider from outside the role's list as a last-resort substitute. Capabilities may degrade — for example, a borrow that subs Groq for perception loses the live web search feature.
3. **If nothing in the pool can serve**, throws `AllProvidersExhaustedError`.

Every deviation from the happy path prints a warning to stderr:

```
⚠ role 'reasoning': primary openrouter:deepseek-v4 cooling, used backup gemini:1
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

**What it does**

Six phase-states, animated transitions between each:

1. **Idle** — centered composer with a hero headline, "5 agents online" status, template-type hints.
2. **Loading** — your prompt locks into a card; the 5 specialist rows in the sidebar light up sequentially as "thinking".
3. **Response** — composer **A** pins to the bottom of the stage and the response **B** pops up out of it (motion). On every new prompt the new **B** appears just above A and any older B's get pushed up; the topmost slot above the stack is a **hint bar** that prompts "pull or tap // expand the mindmap". The newest B is brighter and slightly larger; older B's dim and shrink — the stack reads as a thread of agent outputs. Each B carries its own copy-whole-response button.
4. **Collapsing** (transient ~520 ms) — pulling the hint down or clicking it fires the "big bang" pre-stage: the entire stack converges toward a central singularity. The composer rises off the bottom to the center, response cards shrink/blur as they fall into the same point.
5. **Mindmap** — the singularity explodes outward into the sorted template grid (research → headings + sources, code → file snippets, compare → ranking + per-target, plan → phases + steps). Each card staggers in from the center and, once settled, **gently floats** (small translate + sub-degree rotation, infinite alternate). A scanline overlay + blinking caret on the `// research // synthesized` tag pushes the "agents are still running" feel. Click *collapse* to play the reverse: cards implode back to the singularity, then the response stack re-materializes.
6. **Imploding** (transient ~440 ms) — collapse-back animation; the cards implode into the singularity before the stack returns.

The prompt's *type* is detected via keyword heuristics (`research|find|sources|...` → research, `code|implement|function|...` → code, `compare|vs|tradeoffs|...` → compare, anything else → plan). The model is then asked for a JSON schema matching that template; the JSON drives the burst-stage renderer. The mindmap visualizes the **newest** response in the stack — pull down on the hint and the most recent B is the one that bursts.

Persistence: the full response stack (not just the last thread) is mirrored to `localStorage[lattice.responseStack.v2]`, so reloading the page restores every B in order and you land back in the response phase ready to continue.

**Backend endpoints**

| Route | Method | Body / params | Returns |
|---|---|---|---|
| `/` | GET | — | `index.html` (the SPA shell) |
| `/style.css`, `/app.jsx`, `/templates.jsx` | GET | — | static files from `src/web/static/` (`.jsx` served as `text/babel`) |
| `/api/complete` | POST | `{ prompt: string }` | `{ reply: string }` — one-shot completion through the orchestration role |
| `/api/chat` | POST | `{ sessionId, message }` | `{ reply, servedBy, plan, summarizedTurns, ... }` — multi-turn `ChatSession` shape (not used by the current frontend but available) |
| `/api/usage.json` | GET | — | `{ mode, providers: [{id, successCount, rateLimitCount, remainingPct, cooling}], roles: { <role>: {providerId, successCount, rateLimitCount, remainingPct, cooling} | {providerId, registered: false} } }` — machine-readable counterpart to `/api/usage`, polled by the sidebar |
| `/api/sessions` | GET | — | `{ sessions: string[] }` |
| `/api/sessions/:id` | GET | — | full session snapshot |
| `/api/sessions/:id/clear` | POST | — | wipe a session |
| `/api/usage` | GET | — | `formatUsageReport` text |

**Architecture decisions**

- **No build step.** Frontend uses `<script type="text/babel">` + `@babel/standalone` from a CDN, exactly like the prototype bundle. Trades runtime parse cost (acceptable for a personal-use local tool) for zero toolchain overhead. Production deployment would swap in a real bundler.
- **Vanilla `node:http`**, not Express. No new npm dependencies.
- **Frontend talks to backend via `/api/complete` only** for now. The `/api/chat` (multi-turn `ChatSession`) endpoint is built and exposed but not yet wired into the UI — the UI does single-shot completions per turn, which is enough for the template-driven mindmap flow.
- **5 agents in sidebar, 6 roles in system.** The sidebar's `MM_AGENTS` array surfaces the 5 specialists the orchestrator actively dispatches to (orchestration, perception, reasoning, action-code, action-structural). The 6th role (`action-repetitive`) is omitted from the sidebar but still available in the role registry. Adjust `src/web/static/app.jsx` `MM_AGENTS` to surface a different mix.
- **All agent stats in the sidebar are fake.** The token-usage gauges and "thinking…" pulses are illustrative — not wired to real `formatUsageReport` data. Hooking them to `/api/usage` is a follow-up.

---

## Web UI handover notes (read this if you're picking it up cold)

**Status as of last commit:** code compiled, typechecks clean, mocked unit tests pass (186/186 — 12 cover `src/web/server.ts`: route shapes, error paths, CORS, traversal protection). The web UI has been **live-verified end-to-end** against a real Gemini key: all four phases render, the orchestrator returns parseable JSON for each template, the pull-down handle expands into a working burst-card mindmap, per-card copy buttons work, the sidebar gauges show real provider call counts, and the last thread persists across reloads.

**To verify it works:**

1. `npm install` (no new deps but make sure node_modules is current).
2. `npm run web` — expect: `multi-agent web UI live at http://localhost:7421/`.
3. Open the URL in a browser. **Expected:** see the "Many minds, one conversation." hero with a centered composer.
4. Type a research-ish prompt: "What is Rust's borrow checker?" — submit.
5. **Expected:** the composer slides to the **bottom** of the stage; sidebar agents pulse; after ~1.6s minimum + the real API time, a response card **B** pops up out of the composer (translate-up + scale-in motion) and a **hint bar** appears at the top of the stack.
6. Type a second prompt and submit. **Expected:** the new B' pops up out of the composer just above it; the previous B is pushed up and dims/shrinks slightly. Stack reads top-to-bottom: hint → older B → newest B' → composer.
7. Click (or pull-drag-down past ~70 px) the hint bar. **Expected:** the whole stack — every B and the composer — converges toward a singularity at stage-center over ~520 ms; then the burst explodes outward into the sorted template grid. Cards arrive with a stagger and then **gently float**. The newest response is the one that bursts.
8. Click *collapse* in the mindmap thread-strip. **Expected:** burst cards implode toward the singularity, then the response stack re-materializes with the cards staggering back into place.
9. Try a code prompt, a comparison prompt, a planning prompt. Each should pick a different template and produce a different burst layout.
10. Reload the page. **Expected:** the entire response stack is restored from `localStorage[lattice.responseStack.v2]` and you land back on the response phase.

**Layout note — response stack + big bang (current).** The web UI uses a stacked response model (A at bottom, newest B above A, older B's pushed up, hint at top). Pulling the hint runs a collapse-into-singularity animation (520 ms) followed by a burst-from-center mindmap with a gentle infinite float. The CSS keyframes that drive this live in the *Response stack* / *Big bang collapse* / *Burst cards radiate* blocks of `src/web/static/style.css`. The response history is the full ordered stack, persisted under `localStorage[lattice.responseStack.v2]`. The earlier single-thread key `lattice.lastThread.v1` is dead.

**Things to specifically watch for / known-likely-issues:**

- **`window.HeroMindmap` race.** The `index.html` polls every 30ms for `HeroMindmap` to be defined before mounting. Babel compiles asynchronously; if you see a blank page, open devtools console — likely a SyntaxError in one of the JSX files that prevented it from registering. The fix is in the JSX, not the polling loop.
- **CDN unpkg failures.** The page loads React, ReactDOM, and Babel from unpkg.com. If the user is offline or unpkg is down, the page won't render. Mitigation later: vendor those scripts locally.
- **`.jsx` MIME.** Server serves `.jsx` as `text/babel`. If a browser refuses to execute (some browsers are stricter than others), the script tag in `index.html` may need explicit `type="text/babel" data-presets="env,react"` or similar. Worth checking devtools network tab.
- **Burst-card layout (FIXED).** The prototype's CSS positioned `.mm-card` absolutely but never set its coordinates, so all cards stacked at origin in the mindmap phase. The append-only fix at the bottom of `style.css` (`/* Burst layout — overrides for cards that actually flow. */`) turns `.mm-burst-cards` into a responsive auto-fit grid and overrides the per-card position. Cards animate in with a staggered entrance via `--i`.
- **Responsive sidebar (NEW).** On viewports under 880px wide the sidebar collapses off-screen via CSS media query — the agent gauges are still in the DOM but hidden. A toggle to slide it back in is a future task. Under 600px the burst grid drops to a single column.
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
3. `window.claude.complete(...)` (the design studio's mock API) replaced with `fetch('/api/complete', ...)` against my backend.
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

## Project conventions

A `CLAUDE.md` file at the repo root documents standing rules for any Claude-Code session working on this project. The two most important:

> **1. Any meaningful or permanent change MUST update `README.md` in the same commit.**

> **2. After every completed task, commit + push to GitHub before moving on.** Push is part of "done."

Bug fixes that preserve behavior, internal refactors, dependency bumps don't need README changes — but they still need to be pushed when complete.

Other standing rules in CLAUDE.md: never commit `.env`, never weaken `.gitignore`, never migrate language/stack without explicit user approval, flag credential leaks if the user pastes keys in chat.
