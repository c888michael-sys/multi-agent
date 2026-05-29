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
// 20-1,500/day). gemma:3 is RESERVED for the mindmap-categorize role
// (analogous to gemini:3's perception isolation), so chat/round-robin
// traffic can't drain the slot that powers the mindmap burst. The
// remaining gemma:1 and gemma:2 form the universal safety net at the
// end of every chat-facing role's chain.
const GEMMA_FALLBACK = [
  { providerId: "gemma:1" },
  { providerId: "gemma:2" },
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
// Mindmap categorization needs a strong, reliable JSON-follower at the
// front of its chain. It stays cloud/reserved in both cloud and hybrid
// modes: local Qwen is already used by action-code, and routing the
// categorizer through the same local model makes the burst depend on an
// Ollama daemon that may not exist on the current web device.
const CLOUD_CATEGORIZE = { providerId: "gemini:1" };

/**
 * Build the role registry. With `local: true`, prepend the local Ollama
 * candidates to the reasoning and action-code chains. In every mode, put
 * Gemini Flash at the front of mindmap-categorize so the mindmap burst
 * never depends on local Ollama availability. All other roles stay
 * untouched.
 */
export function buildDefaultRoles(opts?: { local?: boolean }): RoleConfig[] {
  const roles = DEFAULT_ROLES.map((r) => ({ ...r, candidates: [...r.candidates] }));
  const categorize = roles.find((r) => r.name === "mindmap-categorize");
  if (categorize) categorize.candidates.unshift(CLOUD_CATEGORIZE);
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
  {
    // Dedicated role for the web UI's mindmap burst — takes a finished
    // chat reply and emits a structured-JSON view of it. Reserved
    // chain so chat/round-robin traffic can never drain the slot
    // that powers categorization (analogous to gemini:3's perception
    // isolation):
    //   1. gemma:3  — RESERVED for this role, removed from every other
    //      chain. Independent ~14,400 RPD pool on the gemini:3 project.
    //   2. cerebras:llama3-8b — fast, 1 M tok/day, fine for short JSON
    //      categorization.
    //   3. gemma:2 / gemma:1 — last-resort fallback if the reserved
    //      slot AND Cerebras are both exhausted.
    name: "mindmap-categorize",
    description:
      "Convert an assistant reply into the structured JSON the mindmap burst needs (sections/files/targets/phases). Detail-preserving, no paraphrasing.",
    candidates: [
      { providerId: "gemma:3" },
      { providerId: "cerebras:llama3-8b" },
      { providerId: "gemma:2" },
      { providerId: "gemma:1" },
    ],
    systemPromptTemplate:
      "You categorize an assistant reply into a JSON shape. Preserve every detail. Return ONLY valid JSON. No prose, no markdown fences.",
  },
];
