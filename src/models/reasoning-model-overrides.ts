import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const MODEL_OVERRIDES_VERSION = 2;
export const DEFAULT_OPENROUTER_REASONING_MODEL = "qwen/qwen3-next-80b-a3b-instruct:free";
export const OPENROUTER_REASONING_PROVIDER_ID = "openrouter:reasoning";
export const DEFAULT_MODEL_OVERRIDES_PATH = join(homedir(), ".multi-agent", "model-overrides.json");

/**
 * Providers a role can be pointed at via an override. Matches the provider-id
 * prefixes registered in src/config.ts (`gemini:1`, `groq:llama-70b`, …).
 */
export type OverrideProviderName =
  | "openrouter"
  | "nvidia"
  | "groq"
  | "cerebras"
  | "mistral"
  | "gemini"
  | "ollama";

export const OVERRIDE_PROVIDER_NAMES: readonly OverrideProviderName[] = [
  "openrouter",
  "nvidia",
  "groq",
  "cerebras",
  "mistral",
  "gemini",
  "ollama",
];

/**
 * Roles the user may re-point to a custom provider + model. `perception`
 * (needs Gemini's native Google-Search grounding) and the internal
 * `mindmap-categorize` role are intentionally excluded.
 */
export type CustomisableRole =
  | "reasoning"
  | "orchestration"
  | "action-code"
  | "action-structural"
  | "action-repetitive";

export const CUSTOMISABLE_ROLES: readonly CustomisableRole[] = [
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
];

/** A user's saved provider + model choice for one role. */
export interface RoleModelSelection {
  provider: OverrideProviderName;
  model: string;
  name?: string;
  contextLength?: number;
  reasoningCapable?: boolean;
  updatedAt?: string;
}

export interface RoleModelOverrideState {
  version: 2;
  roles: Partial<Record<CustomisableRole, RoleModelSelection>>;
}

// ── back-compat (reasoning-only, OpenRouter-only) ─────────────────────────────
// These types + functions keep the old `models reasoning …` CLI command and the
// `/api/reasoning-model(s)` endpoints working. Reasoning is now just one of the
// CUSTOMISABLE_ROLES; these shims operate on `roles.reasoning` when its provider
// is OpenRouter.

export interface ReasoningModelSelection {
  provider: "openrouter";
  model: string;
  name?: string;
  contextLength?: number;
  reasoningCapable?: boolean;
  updatedAt?: string;
}

export interface ReadReasoningModelSelection extends ReasoningModelSelection {
  isDefault: boolean;
}

function overridePath(path?: string): string {
  return path ?? process.env.MULTI_AGENT_MODEL_OVERRIDES ?? DEFAULT_MODEL_OVERRIDES_PATH;
}

function isCustomisableRole(value: unknown): value is CustomisableRole {
  return typeof value === "string" && (CUSTOMISABLE_ROLES as readonly string[]).includes(value);
}

function isOverrideProvider(value: unknown): value is OverrideProviderName {
  return typeof value === "string" && (OVERRIDE_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Validate + clean a raw selection from disk or an API body. Null if invalid. */
function normalizeSelection(input: unknown): RoleModelSelection | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<Record<keyof RoleModelSelection, unknown>>;
  if (!isOverrideProvider(raw.provider)) return null;
  if (typeof raw.model !== "string" || !raw.model.trim()) return null;
  return {
    provider: raw.provider,
    model: raw.model.trim(),
    ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
    ...(typeof raw.contextLength === "number" && Number.isFinite(raw.contextLength)
      ? { contextLength: raw.contextLength }
      : {}),
    ...(typeof raw.reasoningCapable === "boolean" ? { reasoningCapable: raw.reasoningCapable } : {}),
    ...(typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? { updatedAt: raw.updatedAt } : {}),
  };
}

/**
 * Read + migrate the overrides file into the v2 role map. Unknown/invalid
 * entries are dropped. A v1 file (`{version:1, reasoning:{…}}`) is migrated to
 * `roles.reasoning` (provider was always "openrouter" in v1).
 */
export function readAllRoleModelOverrides(
  path?: string,
): Partial<Record<CustomisableRole, RoleModelSelection>> {
  const target = overridePath(path);
  if (!existsSync(target)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as { version?: unknown; roles?: unknown; reasoning?: unknown };

  // v1 → v2 migration: a top-level `reasoning` selection becomes roles.reasoning.
  const rawRoles: Record<string, unknown> =
    obj.roles && typeof obj.roles === "object"
      ? (obj.roles as Record<string, unknown>)
      : obj.reasoning
        ? { reasoning: obj.reasoning }
        : {};

  const out: Partial<Record<CustomisableRole, RoleModelSelection>> = {};
  for (const [role, value] of Object.entries(rawRoles)) {
    if (!isCustomisableRole(role)) continue;
    const sel = normalizeSelection(value);
    if (sel) out[role] = sel;
  }
  return out;
}

/** The saved selection for one role, or null when no override is set. */
export function readRoleModelOverride(
  role: CustomisableRole,
  path?: string,
): RoleModelSelection | null {
  return readAllRoleModelOverrides(path)[role] ?? null;
}

function writeState(target: string, roles: Partial<Record<CustomisableRole, RoleModelSelection>>): void {
  mkdirSync(dirname(target), { recursive: true });
  const state: RoleModelOverrideState = { version: MODEL_OVERRIDES_VERSION, roles };
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Persist a provider + model choice for one role. Returns the normalized selection. */
export function writeRoleModelOverride(
  role: CustomisableRole,
  selection: Omit<RoleModelSelection, "updatedAt">,
  path?: string,
): RoleModelSelection {
  const target = overridePath(path);
  const roles = readAllRoleModelOverrides(path);
  const normalized: RoleModelSelection = {
    provider: selection.provider,
    model: selection.model.trim(),
    ...(selection.name ? { name: selection.name } : {}),
    ...(selection.contextLength !== undefined ? { contextLength: selection.contextLength } : {}),
    ...(selection.reasoningCapable !== undefined ? { reasoningCapable: selection.reasoningCapable } : {}),
    updatedAt: new Date().toISOString(),
  };
  roles[role] = normalized;
  writeState(target, roles);
  return normalized;
}

/** Remove the override for one role (revert to the default chain). */
export function clearRoleModelOverride(role: CustomisableRole, path?: string): void {
  const target = overridePath(path);
  const roles = readAllRoleModelOverrides(path);
  if (roles[role]) {
    delete roles[role];
    writeState(target, roles);
  }
}

// ── back-compat shims (reasoning, OpenRouter) ────────────────────────────────

function defaultReasoning(): ReadReasoningModelSelection {
  return {
    provider: "openrouter",
    model: DEFAULT_OPENROUTER_REASONING_MODEL,
    name: "Qwen3-Next 80B",
    contextLength: 262_144,
    reasoningCapable: true,
    isDefault: true,
  };
}

/**
 * The reasoning role's OpenRouter model, as the legacy callers expect. When
 * reasoning is overridden to a non-OpenRouter provider this returns the default
 * (the legacy OpenRouter-only surface can't represent another provider — the
 * generalized /api/role-model endpoints expose that).
 */
export function readReasoningModelOverride(path?: string): ReadReasoningModelSelection {
  const sel = readRoleModelOverride("reasoning", path);
  if (!sel || sel.provider !== "openrouter") return defaultReasoning();
  return {
    provider: "openrouter",
    model: sel.model,
    ...(sel.name ? { name: sel.name } : {}),
    ...(sel.contextLength !== undefined ? { contextLength: sel.contextLength } : {}),
    ...(sel.reasoningCapable !== undefined ? { reasoningCapable: sel.reasoningCapable } : {}),
    ...(sel.updatedAt ? { updatedAt: sel.updatedAt } : {}),
    isDefault: sel.model === DEFAULT_OPENROUTER_REASONING_MODEL,
  };
}

export function writeReasoningModelOverride(
  path: string | undefined,
  selection: Omit<ReasoningModelSelection, "provider" | "updatedAt">,
): ReadReasoningModelSelection {
  const written = writeRoleModelOverride("reasoning", { ...selection, provider: "openrouter" }, path);
  return { ...written, provider: "openrouter", isDefault: written.model === DEFAULT_OPENROUTER_REASONING_MODEL };
}

export function resetReasoningModelOverride(path?: string): ReadReasoningModelSelection {
  clearRoleModelOverride("reasoning", path);
  return defaultReasoning();
}
