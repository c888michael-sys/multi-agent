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
 *     e.g., `groq:llama-70b`, `openrouter:deepseek-r1`,
 *     `mistral:codestral`, `cerebras:llama-4-scout`.
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
      // Placeholder: OpenRouter DeepSeek R1 will go here once that provider is wired.
      // { providerId: "openrouter:deepseek-r1" },
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
      // Placeholder: Mistral Codestral will go here.
      // { providerId: "mistral:codestral" },
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
      // Placeholder: Groq Llama 3.3 70B will go here.
      // { providerId: "groq:llama-70b" },
      ...GEMINI_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the structural-action agent. Follow the requested format exactly. Be terse.",
  },
  {
    name: "action-repetitive",
    description: "High-volume bulk work where speed matters more than depth.",
    candidates: [
      // Placeholder: Cerebras Llama 4 Scout will go here.
      // { providerId: "cerebras:llama-4-scout" },
      ...GEMINI_FALLBACK,
    ],
    systemPromptTemplate: "You are the bulk-action agent. Process the task quickly and concisely.",
  },
];
