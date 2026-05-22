# multi-agent

A multi-agent AI orchestration system built on free-tier LLM APIs, designed for $0 personal use with token-efficient inter-agent communication and graceful failover across multiple accounts/providers.

**Status:** Planning. No code yet. This README is the live plan.

---

## What this is

A small Python library + (eventually) a thin local UI that lets you run agent workflows against Google's Gemini 3.5 Flash free tier, rotating across multiple accounts so a single account's daily quota doesn't kill a run. Built so that adding more providers (Groq, OpenRouter) and an orchestrator layer on top is cheap.

## Build order

The full vision is large, so the work is decomposed into independent stages. Each stage stands alone and gets its own design + implementation cycle.

### Stage 1 — `llm_router` (foundation) ← starting here

A Python module that hides the multi-key/multi-account chaos behind one function:

```python
from llm_router import complete
text = complete("Hello, world.")
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

**Test approach:** mock HTTP — no real quota spent during development.

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

**Acknowledged risk.** Multi-accounting is a Google ToS gray area. This is a personal project; the risk has been weighed and accepted.

---

## Roadmap checklist

- [ ] Stage 1: `llm_router` design doc
- [ ] Stage 1: implementation
- [ ] Stage 1: tests against mocked HTTP
- [ ] Stage 1: integration smoke test against 2 real Gemini accounts
- [ ] Stage 2: conservation mode
- [ ] Stage 3: orchestrator + 2 agent modes
- [ ] Stage 4: local UI
- [ ] Stage 5: web + bot integrations

---

## Repo layout (planned)

```
multi-agent/
  README.md           — this file (the plan)
  llm_router/         — Stage 1
  tests/              — pytest, mocked HTTP
  docs/specs/         — per-stage design docs
  .env.example        — GEMINI_KEY_1, GEMINI_KEY_2, ...
  .gitignore
  pyproject.toml      — added when Stage 1 implementation starts
```

## Setup (will fill in as Stage 1 lands)

1. Create 2 (eventually 3) Google accounts; generate one Gemini API key each at https://aistudio.google.com/apikey
2. Copy `.env.example` to `.env` and fill in keys
3. (TBD — install + usage instructions added with Stage 1 code)
