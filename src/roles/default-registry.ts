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

// Two Gemini Flash slots reserved for orchestration + reasoning. `gemini:3`
// is intentionally NOT in this list — it's the perception-only key, so
// chat traffic can't drain the one slot with Google Search grounding.
const GEMINI_FLASH_SHARED = [
  { providerId: "gemini:1" },
  { providerId: "gemini:2" },
];

// Gemma 3 27B-it slots on every Gemini key — same project, different
// model, separate per-model RPD quota pool (~14,400/day vs Flash's
// 20-1,500/day). Universal safety net at the end of every chain.
const GEMMA_FALLBACK = [
  { providerId: "gemma:1" },
  { providerId: "gemma:2" },
  { providerId: "gemma:3" },
];

/**
 * Local-mode candidates — when the hybrid toggle is on, these get
 * prepended to the matching role's chain so they win when registered.
 *
 *   reasoning      → ollama:deepseek-r1   (DeepSeek-R1 32B, locally hosted)
 *   action-code    → ollama:qwen2.5-coder (Qwen 2.5 Coder, locally hosted)
 *
 * Cloud candidates remain in the chain as fallback if the local daemon
 * is unreachable or the model isn't pulled. All other roles are
 * unchanged in local mode.
 */
const LOCAL_REASONING = { providerId: "ollama:deepseek-r1" };
const LOCAL_ACTION_CODE = { providerId: "ollama:qwen2.5-coder" };

/**
 * Build the role registry. With `local: true`, prepend the local Ollama
 * candidates to the reasoning and action-code chains; cloud roles stay
 * untouched.
 */
export function buildDefaultRoles(opts?: { local?: boolean }): RoleConfig[] {
  const roles = DEFAULT_ROLES.map((r) => ({ ...r, candidates: [...r.candidates] }));
  if (opts?.local) {
    const reasoning = roles.find((r) => r.name === "reasoning");
    if (reasoning) reasoning.candidates.unshift(LOCAL_REASONING);
    const actionCode = roles.find((r) => r.name === "action-code");
    if (actionCode) actionCode.candidates.unshift(LOCAL_ACTION_CODE);
  }
  return roles;
}

export const DEFAULT_ROLES: RoleConfig[] = [
  {
    name: "perception",
    description:
      "Data collection. Uses Gemini's native Google Search grounding for live web data. `gemini:3` is reserved exclusively for this role.",
    candidates: [
      // Reserved key — NOT in any other role's chain. When chat hammers
      // gemini:1 and gemini:2 dry, perception still has its own Flash key
      // with search grounding alive.
      { providerId: "gemini:3", mode: { useSearch: true } },
      // Last-resort fallback: Gemma can answer the question but loses live
      // web data. Better than failing.
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the perception agent. Gather facts from the web for the task. Return concise findings with sources.",
  },
  {
    name: "reasoning",
    description:
      "Plan-of-attack, hard decisions, deliberation. Highest-effort thinking mode.",
    candidates: [
      // Primary: Gemini 3.5 Flash with `thinking=high` — extended reasoning,
      // close to GPT-4-class on GPQA when given the full thinking budget.
      // Two keys (gemini:1, gemini:2) shared with orchestration so we
      // don't waste a slot on a rarely-called role.
      ...GEMINI_FLASH_SHARED.map((c) => ({ ...c, mode: { thinking: "high" as const } })),
      // Backup: DeepSeek V4 Flash on OpenRouter (284B MoE / 13B active,
      // native reasoning). Independent quota pool. R1 free was retired
      // by OpenRouter — V4 Flash is the current free option.
      { providerId: "openrouter:deepseek-v4-flash" },
      // Safety net: Gemma 3 27B on any of the three Gemini keys (separate
      // per-model quota; ~14,400 RPD per key on free tier).
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the reasoning agent. Think step by step. Produce a structured plan or decision with brief justification. Acknowledge uncertainty; prefer 'I don't know' to confident guessing.",
  },
  {
    name: "orchestration",
    description:
      "Decide which role(s) to invoke for a task; synthesize outputs from sub-agents.",
    candidates: [
      // Primary: Gemini 3.5 Flash (no thinking) on the two shared keys.
      // Routing decisions are short, frequent, and don't need extended
      // reasoning — Flash defaults are the right shape.
      ...GEMINI_FLASH_SHARED,
      // Backup: DeepSeek V4 Flash for when both Gemini Flash slots are
      // cooled. Slower but a real second opinion on routing.
      { providerId: "openrouter:deepseek-v4-flash" },
      // Safety net: Gemma 3.
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the orchestrator. Choose the right role(s) for the task and integrate results into one coherent answer. Be terse.",
  },
  {
    name: "action-code",
    description: "Code-specialized execution: write, modify, debug code.",
    candidates: [
      // Primary: Mistral Codestral — code-specialized, ~1B tokens/month
      // free on Experiment plan. Different model family.
      { providerId: "mistral:codestral" },
      // Safety net: Gemma 3. Flash deliberately not included — preserves
      // Flash quota for orchestration/reasoning/perception where it matters.
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the code-action agent. Produce code that runs. No prose unless asked.",
  },
  {
    name: "action-structural",
    description:
      "General execution: structured outputs, formatting, transformations, summaries.",
    candidates: [
      // Primary: Groq Llama 3.3 70B — 30 RPM, 1000 RPD on its own quota.
      { providerId: "groq:llama-70b" },
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the structural-action agent. Follow the requested format exactly. Be terse.",
  },
  {
    name: "action-repetitive",
    description: "High-volume bulk work where speed matters more than depth.",
    candidates: [
      // Primary: Cerebras Llama 3.1 8B — wafer-scale inference at
      // ~2000 tok/sec, 1M tokens/day free.
      { providerId: "cerebras:llama3-8b" },
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate: "You are the bulk-action agent. Process the task quickly and concisely.",
  },
];
