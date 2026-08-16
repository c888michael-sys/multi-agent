import type { RoleConfig } from "./types.js";
import {
  OPENROUTER_REASONING_PROVIDER_ID,
  CUSTOMISABLE_ROLES,
} from "../models/reasoning-model-overrides.js";

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
 *     e.g., `groq:llama-70b`, `openrouter:reasoning`,
 *     `mistral:large`, `cerebras:gpt-oss-120b`.
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

// Gemma 4 31B-it slots on every Gemini key — same project, different
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
 *   reasoning      → ollama:qwen3.5-9b    (Qwen 3.5 9B by default, locally hosted)
 *   vision         → ollama:qwen3.5-9b    (same configured multimodal reasoner)
 *   action-code    → ollama:qwen2.5-coder (Qwen 2.5 Coder, locally hosted)
 *
 * Cloud candidates remain after the local candidates for normal resolver
 * failover. The web UI separately checks daemon/model availability before it
 * enables hybrid mode. All other roles are unchanged in local mode.
 */
const LOCAL_REASONING = { providerId: "ollama:qwen3.5-9b" };
const LOCAL_ACTION_CODE = { providerId: "ollama:qwen2.5-coder" };
// Mindmap categorization needs a strong, reliable JSON-follower at the
// front of its chain. It stays cloud/reserved in both cloud and hybrid
// modes: local Qwen is already used by action-code, and routing the
// categorizer through the same local model makes the burst depend on an
// Ollama daemon that may not exist on the current web device.
const CLOUD_CATEGORIZE = { providerId: "gemini:1" };

// Extra function-calling models inserted as action-code FALLBACKS for agentic
// tool sessions, so a turn that needs tools degrades to another tool-capable
// model rather than Gemma if the primary (mistral:large) is cooling. Probed
// live 2026-06: groq llama-3.3-70b, cerebras gpt-oss-120b, and all Mistral
// chat models (large/small/codestral) ✅ once the response parser stopped
// requiring the OpenAI-only `type:"function"` field that Mistral omits.
const TOOL_CAPABLE_ACTION_CODE = [
  { providerId: "groq:llama-70b" },
  { providerId: "cerebras:gpt-oss-120b" },
  // NVIDIA hosts strong function-calling chat/coder models on a generous free
  // tier; included as a fallback when registered (NVIDIA_KEY set).
  { providerId: "nvidia:llama-70b" },
];

/**
 * Build the role registry. With `local: true`, prepend the local Ollama
 * candidates to the reasoning, vision, and action-code chains. In every mode, put
 * Gemini Flash at the front of mindmap-categorize so the mindmap burst
 * never depends on local Ollama availability.
 *
 * With `toolCapable: true` (agentic tool sessions), insert extra
 * function-calling models into the action-code chain as fallbacks ahead of
 * the Gemma safety net — keeping the user's primary (mistral:large, or local
 * ollama in hybrid mode) first.
 */
export function buildDefaultRoles(opts?: { local?: boolean; toolCapable?: boolean }): RoleConfig[] {
  const roles = DEFAULT_ROLES.map((r) => ({ ...r, candidates: [...r.candidates] }));
  const categorize = roles.find((r) => r.name === "mindmap-categorize");
  if (categorize) categorize.candidates.unshift(CLOUD_CATEGORIZE);
  if (opts?.local) {
    const reasoning = roles.find((r) => r.name === "reasoning");
    if (reasoning) reasoning.candidates.unshift(LOCAL_REASONING);
    const vision = roles.find((r) => r.name === "vision");
    if (vision) vision.candidates.unshift(LOCAL_REASONING);
    const actionCode = roles.find((r) => r.name === "action-code");
    if (actionCode) actionCode.candidates.unshift(LOCAL_ACTION_CODE);
  }
  if (opts?.toolCapable) {
    const actionCode = roles.find((r) => r.name === "action-code");
    if (actionCode) {
      // Insert tool-capable fallbacks just before the first Gemma slot, so the
      // primary stays first and Gemma stays last.
      const have = new Set(actionCode.candidates.map((c) => c.providerId));
      const toAdd = TOOL_CAPABLE_ACTION_CODE.filter((c) => !have.has(c.providerId));
      const gemmaIdx = actionCode.candidates.findIndex((c) => c.providerId.startsWith("gemma:"));
      const insertAt = gemmaIdx === -1 ? actionCode.candidates.length : gemmaIdx;
      actionCode.candidates.splice(insertAt, 0, ...toAdd);
    }
  }
  // Per-role override slots go FIRST in each customisable role's chain (ahead of
  // even the local-prepend), so a user's explicit provider+model choice wins.
  // The slot reports inactive until an override is set, so the resolver skips it
  // and the rest of the chain serves unchanged by default.
  for (const role of CUSTOMISABLE_ROLES) {
    const cfg = roles.find((r) => r.name === role);
    if (cfg) cfg.candidates.unshift({ providerId: `override:${role}` });
  }
  return roles;
}

/**
 * Web sessions can enter Builder mode on any turn, so their resolver must
 * always include the function-calling action-code fallbacks. Normal chat still
 * keeps its configured primary first; these candidates are only reached when
 * that primary cannot serve the call.
 */
export function buildWebRoles(local = false): RoleConfig[] {
  return buildDefaultRoles({ local, toolCapable: true });
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
      // Primary: selected OpenRouter free text model. Defaults to Qwen3-Next
      // 80B, but the model slug can be changed without touching fallbacks.
      { providerId: OPENROUTER_REASONING_PROVIDER_ID },
      // Secondary: Gemini 3.5 Flash with `thinking=high` — extended reasoning.
      // Two keys (gemini:1, gemini:2) shared with orchestration.
      ...GEMINI_FLASH_SHARED.map((c) => ({ ...c, mode: { thinking: "high" as const } })),
      // Safety net: Gemma 4 31B on any of the three Gemini keys (separate
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
      // Backup: the selected OpenRouter reasoning model for when both Gemini
      // Flash slots are cooled. Same provider id as the reasoning primary.
      { providerId: OPENROUTER_REASONING_PROVIDER_ID },
      // Safety net: Gemma 4.
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the orchestrator. Choose the right role(s) for the task and integrate results into one coherent answer. Be terse.",
  },
  {
    name: "action-code",
    description: "Code-specialized execution: write, modify, debug code.",
    candidates: [
      // Primary: Mistral Large — strongest Mistral model, free on the
      // Experiment plan, reliable function calling (verified live 2026-06).
      // Override the model with MISTRAL_MODEL (e.g. mistral-small-latest).
      { providerId: "mistral:large" },
      // Safety net: Gemma 4. Flash deliberately not included — preserves
      // Flash quota for orchestration/reasoning/perception where it matters.
      // Agentic tool sessions also insert groq/cerebras here (see
      // buildDefaultRoles toolCapable) so tool turns degrade to another
      // function-caller before reaching Gemma.
      ...GEMMA_FALLBACK,
    ],
    systemPromptTemplate:
      "You are the code-action agent. Produce complete, working code. " +
      "When building UI or web pages, make them polished and production-quality: " +
      "thoughtful layout, real CSS styling, sensible typography and spacing, " +
      "responsive design, and meaningful sample content — never bare-bones, " +
      "unstyled placeholders. Create every file the task needs (separate HTML, " +
      "CSS, and JS files when appropriate). Don't stop at a skeleton; finish the " +
      "job. No prose unless asked.",
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
      { providerId: "cerebras:gpt-oss-120b" },
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
    //   2. cerebras:gpt-oss-120b — fast, 1 M tok/day, fine for short JSON
    //      categorization.
    //   3. gemma:2 / gemma:1 — last-resort fallback if the reserved
    //      slot AND Cerebras are both exhausted.
    name: "mindmap-categorize",
    description:
      "Convert an assistant reply into the structured JSON the mindmap burst needs (sections/files/targets/phases). Detail-preserving, no paraphrasing.",
    candidates: [
      { providerId: "gemma:3" },
      { providerId: "cerebras:gpt-oss-120b" },
      { providerId: "gemma:2" },
      { providerId: "gemma:1" },
    ],
    systemPromptTemplate:
      "You categorize an assistant reply into a JSON shape. Preserve every detail. Return ONLY valid JSON. No prose, no markdown fences.",
  },
  {
    // Internal multimodal role: chat turns that include pasted/attached images
    // are auto-forced here (see ChatSession.send). Hybrid mode prepends the
    // local reasoning model; Gemini remains the multimodal fallback. This role
    // is not user-selectable or offered to the orchestrator planner (excluded
    // from rosterDescription), so it only serves image turns.
    name: "vision",
    description:
      "Answer questions about attached images. Multimodal; used automatically when a turn includes images.",
    candidates: [
      { providerId: "gemini:1" },
      { providerId: "gemini:2" },
    ],
    systemPromptTemplate:
      "You are a helpful assistant. The user has shared one or more images. " +
      "Look at the image(s) and answer their question clearly and concisely. " +
      "If they did not ask a specific question, describe what the image shows.",
  },
];
