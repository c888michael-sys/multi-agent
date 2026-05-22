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
| Reasoning | Plan-of-attack, hard decisions, deliberation | DeepSeek R1 (full 671B) via OpenRouter | Top reasoning model accessible for free; called rarely (50/day cap suits the use case) |
| Orchestration | Decide which role(s) to invoke; synthesize outputs | Gemini 3.5 Flash (default mode) | 1M context fits roster + intermediate state; low hallucination matters for routing |
| Action A (code) | Code-specialized execution | Codestral via Mistral | Code-specialized; generous Experiment-plan quota |
| Action B (structural) | General execution; formatting; structured outputs | Llama 3.3 70B via Groq | 300 tok/sec; 1000 RPD on its own pool |
| Action C (repetitive) | Bulk, high-volume tasks | Llama 4 Scout via Cerebras | 1M tokens/day; extreme speed (2100 tok/sec) |

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
- [ ] Stage 4: multi-turn conversation + context window management (manual + auto-clear with warning)
- [x] Stage 6: role abstraction layer (`RoleConfig` / `RoleResolver`) — routes role calls to constrained provider subsets, falls back through candidates, validates registration
- [x] Stage 6: Groq provider + Llama 3.3 70B as `action-structural` (live-verified end-to-end via `--role=action-structural`)
- [ ] Stage 6: OpenRouter provider + DeepSeek R1 as `reasoning`
- [ ] Stage 6: Cerebras provider + Llama 4 Scout as `action-repetitive`
- [ ] Stage 6: Mistral provider + Codestral as `action-code`
- [ ] Stage 6: roster-aware orchestrator routing
- [ ] Stage 5: web + bot integrations

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
    roles/              — Stage 6 (in progress)
      types.ts          — RoleConfig / RoleName / ProviderRef
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
- **`Controller`** (`src/agents/controller.ts`) — multi-agent orchestrator with two runtime modes: `parallel` (all sub-agents independently → synthesize) and `specialist` (controller picks one sub-agent for the task). Threads `CompleteOptions` through to every underlying call.
- **`ToolRunner`** (`src/tools/runner.ts`) — multi-turn function-calling loop. Captures Gemini's `thoughtSignature` and re-attaches it on subsequent turns (required for Gemini 3.x). Caps iterations at 10.
- **`ConservationPolicy`** (`src/conservation.ts`) — observes Router's usage snapshot, flips Pool mode round-robin ↔ serial with hysteresis. `tick()` is manual — no internal timer.
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

A `CLAUDE.md` file at the repo root documents standing rules for any Claude-Code session working on this project. The most important one:

> **Any meaningful or permanent change to the system MUST be reflected in `README.md` as part of the same commit.**

Don't ship a feature commit without the README update. Bug fixes that preserve behavior, internal refactors, dependency bumps — those don't need README changes.

Other standing rules in CLAUDE.md: never commit `.env`, never weaken `.gitignore`, never migrate language/stack without explicit user approval, flag credential leaks if the user pastes keys in chat.
