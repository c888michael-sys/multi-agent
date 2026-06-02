import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const MODEL_OVERRIDES_VERSION = 1;
export const DEFAULT_OPENROUTER_REASONING_MODEL = "qwen/qwen3-next-80b-a3b-instruct:free";
export const OPENROUTER_REASONING_PROVIDER_ID = "openrouter:reasoning";
export const DEFAULT_MODEL_OVERRIDES_PATH = join(homedir(), ".multi-agent", "model-overrides.json");

export interface ReasoningModelSelection {
  provider: "openrouter";
  model: string;
  name?: string;
  contextLength?: number;
  reasoningCapable?: boolean;
  updatedAt?: string;
}

export interface ReasoningModelOverrideState {
  version: 1;
  reasoning: ReasoningModelSelection;
}

export interface ReadReasoningModelSelection extends ReasoningModelSelection {
  isDefault: boolean;
}

function defaultState(): ReasoningModelOverrideState {
  return {
    version: MODEL_OVERRIDES_VERSION,
    reasoning: {
      provider: "openrouter",
      model: DEFAULT_OPENROUTER_REASONING_MODEL,
      name: "Qwen3-Next 80B",
      contextLength: 262_144,
      reasoningCapable: true,
    },
  };
}

function overridePath(path?: string): string {
  return path ?? process.env.MULTI_AGENT_MODEL_OVERRIDES ?? DEFAULT_MODEL_OVERRIDES_PATH;
}

function normalizeSelection(input: unknown): ReasoningModelSelection | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<Record<keyof ReasoningModelSelection, unknown>>;
  if (raw.provider !== "openrouter") return null;
  if (typeof raw.model !== "string" || !raw.model.trim()) return null;
  return {
    provider: "openrouter",
    model: raw.model.trim(),
    ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
    ...(typeof raw.contextLength === "number" && Number.isFinite(raw.contextLength)
      ? { contextLength: raw.contextLength }
      : {}),
    ...(typeof raw.reasoningCapable === "boolean" ? { reasoningCapable: raw.reasoningCapable } : {}),
    ...(typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function readReasoningModelOverride(path?: string): ReadReasoningModelSelection {
  const target = overridePath(path);
  if (!existsSync(target)) {
    return { ...defaultState().reasoning, isDefault: true };
  }
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { reasoning?: unknown };
    const selection = normalizeSelection(parsed.reasoning);
    if (!selection) return { ...defaultState().reasoning, isDefault: true };
    return {
      ...selection,
      isDefault: selection.model === DEFAULT_OPENROUTER_REASONING_MODEL,
    };
  } catch {
    return { ...defaultState().reasoning, isDefault: true };
  }
}

export function writeReasoningModelOverride(
  path: string | undefined,
  selection: Omit<ReasoningModelSelection, "provider" | "updatedAt">,
): ReadReasoningModelSelection {
  const target = overridePath(path);
  const normalized: ReasoningModelSelection = {
    provider: "openrouter",
    model: selection.model.trim(),
    ...(selection.name ? { name: selection.name } : {}),
    ...(selection.contextLength !== undefined ? { contextLength: selection.contextLength } : {}),
    ...(selection.reasoningCapable !== undefined ? { reasoningCapable: selection.reasoningCapable } : {}),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ version: MODEL_OVERRIDES_VERSION, reasoning: normalized }, null, 2)}\n`,
    "utf8",
  );
  return { ...normalized, isDefault: normalized.model === DEFAULT_OPENROUTER_REASONING_MODEL };
}

export function resetReasoningModelOverride(path?: string): ReadReasoningModelSelection {
  const target = overridePath(path);
  const state = defaultState();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { ...state.reasoning, isDefault: true };
}
