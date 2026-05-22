# multi-agent

A multi-agent AI orchestration system built on free-tier LLM APIs, designed for $0 personal use with token-efficient inter-agent communication and graceful failover across multiple accounts/providers.

**Status:** Planning. No code yet. This README is the live plan.

---

## What this is

A small Python library + (eventually) a thin local UI that lets you run agent workflows against Google's Gemini 3.5 Flash free tier, rotating across multiple accounts so a single account's daily quota doesn't kill a run. Built so that adding more providers (Groq, OpenRouter) and an orchestrator layer on top is cheap.

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
- [ ] Stage 5: web + bot integrations

See `docs/specs/2026-05-22-stages-2-and-3.md` for what's been built without keys and exactly what needs tuning once keys arrive.

---

## Repo layout

```
multi-agent/
  README.md           — this file (the plan)
  src/
    index.ts          — public entry: complete()
    router.ts         — rotation + failover
    provider.ts       — Provider interface
    providers/
      gemini.ts       — Gemini implementation
    pool.ts           — per-provider quota/cooldown state
    errors.ts
    config.ts         — load keys from env
  tests/              — vitest, mocked SDK
  docs/specs/         — per-stage design docs
  .env.example
  .gitignore
  package.json
  tsconfig.json
```

## Setup

1. Provision N independent quota buckets — either one Google Cloud project per slot under a single Google account (recommended; up to 25 per account, lower ToS risk) or one separate Google account per slot. Generate one Gemini API key at https://aistudio.google.com/apikey for each.
2. `cp .env.example .env` and fill in `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`, ... — add as many as you have.
3. `npm install`
4. `npm test` — mocked test suite, no real quota
5. `npm run verify-keys` — calls each configured key once, prints ✓/✗ per slot (1 request per key)
6. `npm run smoke` — single round-trip through the router (1 request)

## CLI

```
npm run cli -- ask "your prompt here"
npm run cli -- agents "your prompt here"                    # parallel, 3 default agents
npm run cli -- agents --mode=specialist "your prompt"       # specialist routing
npm run cli -- agents --trace "your prompt"                 # print per-agent outputs
npm run cli -- usage                                        # cumulative usage (persisted across runs, daily UTC reset)
npm run cli -- --help
```

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
