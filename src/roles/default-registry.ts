import type { RoleConfig } from "./types.js";

/**
 * Default role-to-provider mapping. Each role lists candidate providers in
 * priority order — the resolver picks the first registered + non-cooling one.
 *
 * Until other providers land (Stage 6, steps 2-5), every role falls back to
 * the Gemini pool. As we wire up Groq, OpenRouter, Mistral, and Cerebras,
 * the candidate lists for action/reasoning roles will get those providers
 * prepended; Gemini stays as a last-resort fallback for everything.
 *
 * Provider id convention:
 *   - Gemini accounts: `gemini:1`, `gemini:2`, `gemini:3`, ...
 *   - Other providers: `<provider>:<short-model-name>`
 *     e.g., `groq:llama-70b`, `openrouter:deepseek-v4-flash`,
 *     `mistral:codestral`, `cerebras:llama3-8b`.
 *
 * This file is the single source of truth for role configuration. Adding a new
 * provider = update the candidate list here, plus register the provider with
 * the router in src/config.ts. The orchestrator picks up the change with no
 * other code edits.
 */

const GEMINI_FALLBACK = [
  { providerId: "gemini:1" },
  { providerId: "gemini:2" },
  { providerId: "gemini:3" },
];

export const DEFAULT_ROLES: RoleConfig[] = [
  {
    name: "perception",
    description:
      "Data collection. Uses Gemini's native Google Search grounding for live web data.",
    candidates: GEMINI_FALLBACK.map((c) => ({
      ...c,
      mode: { useSearch: true },
    })),
    systemPromptTemplate:
      "You are the perception agent. Gather facts from the web for the task. Return concise findings with sources.",
  },
  {
    name: "reasoning",
    description:
      "Plan-of-attack, hard decisions, deliberation. Highest-effort thinking mode.",
    candidates: [
      // Primary: DeepSeek V4 Flash (284B MoE / 13B active, 1M context, native
      // reasoning). Strongest free reasoning model on OpenRouter as of May 2026.
      // ~50/day shared OpenRouter budget — adequate for a rarely-called role.
      { providerId: "openrouter:deepseek-v4-flash" },
      // Fallbacks: Gemini Flash with thinking=high when V4 Flash is
      // unavailable or when OPENROUTER_KEY isn't set. Different provider +
      // model family, independent quota pool, comparable GPQA scores — a
      // real fallback, not just degraded.
      ...GEMINI_FALLBACK.map((c) => ({ ...c, mode: { thinking: "high" as const } })),
    ],
    systemPromptTemplate:
      "You are the reasoning agent. Think step by step. Produce a structured plan or decision with brief justification. Acknowledge uncertainty; prefer 'I don't know' to confident guessing.",
  },
  {
    name: "orchestration",
    description:
      "Decide which role(s) to invoke for a task; synthesize outputs from sub-agents.",
    candidates: GEMINI_FALLBACK,
    systemPromptTemplate:
      "You are the orchestrator. Choose the right role(s) for the task and integrate results into one coherent answer. Be terse.",
  },
  {
    name: "action-code",
    description: "Code-specialized execution: write, modify, debug code.",
    candidates: [
      // Primary: Mistral Codestral — code-specialized, generous Experiment-plan
      // quota (~1B tokens/month). Different model family from the others.
      { providerId: "mistral:codestral" },
      ...GEMINI_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the code-action agent. Produce code that runs. No prose unless asked.",
  },
  {
    name: "action-structural",
    description:
      "General execution: structured outputs, formatting, transformations, summaries.",
    candidates: [
      { providerId: "groq:llama-70b" }, // Llama 3.3 70B, very fast, 1000 RPD on its own pool
      ...GEMINI_FALLBACK, // graceful fallback if GROQ_KEY missing or Groq is cooling
    ],
    systemPromptTemplate:
      "You are the structural-action agent. Follow the requested format exactly. Be terse.",
  },
  {
    name: "action-repetitive",
    description: "High-volume bulk work where speed matters more than depth.",
    candidates: [
      // Primary: Cerebras Llama 3.1 8B — wafer-scale inference at ~2000 tok/sec,
      // 1M tokens/day free. Llama 4 Scout (mentioned in earlier docs) was
      // moved off the standard model list; 8B is the right shape for bulk
      // repetitive work anyway: speed and quota over depth.
      { providerId: "cerebras:llama3-8b" },
      ...GEMINI_FALLBACK,
    ],
    systemPromptTemplate: "You are the bulk-action agent. Process the task quickly and concisely.",
  },
];
