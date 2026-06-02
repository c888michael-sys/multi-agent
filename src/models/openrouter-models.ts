import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface OpenRouterFreeModelOption {
  id: string;
  name: string;
  contextLength: number;
  created: number;
  reasoningCapable: boolean;
  description?: string;
}

type RawOpenRouterModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  created?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
    modality?: unknown;
  } | null;
  pricing?: Record<string, unknown> | null;
  supported_parameters?: unknown;
  expiration_date?: unknown;
};

type CacheFile = {
  version?: unknown;
  fetchedAt?: unknown;
  models?: unknown;
};

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=text";
export const OPENROUTER_FREE_MODELS_CACHE_VERSION = 1;
export const DEFAULT_OPENROUTER_MODELS_CACHE_PATH = join(
  homedir(),
  ".multi-agent",
  "openrouter-free-models.json",
);

const FREE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NON_REASONING_INPUTS = new Set(["audio"]);
const NON_TEXT_OUTPUTS = new Set(["audio", "image", "embeddings", "embedding"]);
const NON_REASONING_WORDS = /\b(audio|speech|transcription|transcribe|tts|image generator|image generation|embedding|rerank|moderation|classifier)\b/i;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.toLowerCase() : "")).filter(Boolean);
}

function numeric(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pricingIsZero(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return Number(value) === 0;
  return false;
}

function isFree(model: RawOpenRouterModel): boolean {
  const id = typeof model.id === "string" ? model.id : "";
  if (id.endsWith(":free")) return true;
  const pricing = model.pricing ?? {};
  return (
    pricingIsZero(pricing.prompt) &&
    pricingIsZero(pricing.completion) &&
    pricingIsZero(pricing.request) &&
    pricingIsZero(pricing.internal_reasoning)
  );
}

function hasTextOutput(model: RawOpenRouterModel): boolean {
  const outputs = stringArray(model.architecture?.output_modalities);
  if (outputs.length === 0) return false;
  if (!outputs.includes("text")) return false;
  return !outputs.some((m) => NON_TEXT_OUTPUTS.has(m) && m !== "text");
}

function hasReasoningSafeInput(model: RawOpenRouterModel): boolean {
  const inputs = stringArray(model.architecture?.input_modalities);
  return !inputs.some((m) => NON_REASONING_INPUTS.has(m));
}

function isExpired(model: RawOpenRouterModel): boolean {
  if (typeof model.expiration_date !== "string" || !model.expiration_date.trim()) return false;
  const expiresAt = Date.parse(model.expiration_date);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function looksLikeNonReasoningSpecialty(model: RawOpenRouterModel): boolean {
  const haystack = [
    typeof model.id === "string" ? model.id : "",
    typeof model.name === "string" ? model.name : "",
    typeof model.description === "string" ? model.description : "",
  ].join(" ");
  return NON_REASONING_WORDS.test(haystack);
}

function reasoningCapable(model: RawOpenRouterModel): boolean {
  const params = stringArray(model.supported_parameters);
  return params.includes("reasoning") || params.includes("include_reasoning");
}

function toOption(model: RawOpenRouterModel): OpenRouterFreeModelOption | null {
  if (typeof model.id !== "string" || !model.id.trim()) return null;
  if (!isFree(model)) return null;
  if (!hasTextOutput(model)) return null;
  if (!hasReasoningSafeInput(model)) return null;
  if (isExpired(model)) return null;
  if (looksLikeNonReasoningSpecialty(model)) return null;

  return {
    id: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    contextLength: numeric(model.context_length),
    created: numeric(model.created),
    reasoningCapable: reasoningCapable(model),
    ...(typeof model.description === "string" && model.description.trim()
      ? { description: model.description }
      : {}),
  };
}

function normalizeCachedOption(input: unknown): OpenRouterFreeModelOption | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<Record<keyof OpenRouterFreeModelOption, unknown>>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
    contextLength: numeric(raw.contextLength),
    created: numeric(raw.created),
    reasoningCapable: raw.reasoningCapable === true,
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: raw.description }
      : {}),
  };
}

export function filterFreeOpenRouterTextModels(rawModels: unknown): OpenRouterFreeModelOption[] {
  if (!Array.isArray(rawModels)) return [];
  const byId = new Map<string, OpenRouterFreeModelOption>();
  for (const raw of rawModels) {
    if (!raw || typeof raw !== "object") continue;
    const option = toOption(raw as RawOpenRouterModel);
    if (option) byId.set(option.id, option);
  }
  return sortOpenRouterReasoningOptions([...byId.values()]);
}

export function sortOpenRouterReasoningOptions(
  models: OpenRouterFreeModelOption[],
): OpenRouterFreeModelOption[] {
  return [...models].sort((a, b) => {
    if (a.reasoningCapable !== b.reasoningCapable) return a.reasoningCapable ? -1 : 1;
    if (a.contextLength !== b.contextLength) return b.contextLength - a.contextLength;
    if (a.created !== b.created) return b.created - a.created;
    return a.name.localeCompare(b.name);
  });
}

export function readCachedOpenRouterFreeModels(
  path = process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE || DEFAULT_OPENROUTER_MODELS_CACHE_PATH,
  now = Date.now(),
): { models: OpenRouterFreeModelOption[]; fetchedAt: number; stale: boolean } | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.version !== OPENROUTER_FREE_MODELS_CACHE_VERSION) return null;
    const fetchedAt = numeric(parsed.fetchedAt);
    const models = Array.isArray(parsed.models)
      ? sortOpenRouterReasoningOptions(
          parsed.models
            .map((m) => normalizeCachedOption(m))
            .filter((m): m is OpenRouterFreeModelOption => Boolean(m)),
        )
      : [];
    if (fetchedAt <= 0 || models.length === 0) return null;
    return { models, fetchedAt, stale: now - fetchedAt > FREE_CACHE_TTL_MS };
  } catch {
    return null;
  }
}

export function writeCachedOpenRouterFreeModels(
  models: OpenRouterFreeModelOption[],
  path = process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE || DEFAULT_OPENROUTER_MODELS_CACHE_PATH,
  fetchedAt = Date.now(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: OPENROUTER_FREE_MODELS_CACHE_VERSION,
        fetchedAt,
        models,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function fetchOpenRouterFreeTextModels(opts?: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
}): Promise<{ models: OpenRouterFreeModelOption[]; fetchedAt: number; source: "live" }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  const apiKey = opts?.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(OPENROUTER_MODELS_URL, { headers });
  if (!res.ok) throw new Error(`OpenRouter models request failed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  const models = filterFreeOpenRouterTextModels(json.data);
  const fetchedAt = Date.now();
  writeCachedOpenRouterFreeModels(models, opts?.cachePath, fetchedAt);
  return { models, fetchedAt, source: "live" };
}

export async function listOpenRouterFreeTextModels(opts?: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  refresh?: boolean;
}): Promise<{
  models: OpenRouterFreeModelOption[];
  fetchedAt: number | null;
  source: "live" | "cache" | "empty";
  stale: boolean;
}> {
  const cache = readCachedOpenRouterFreeModels(opts?.cachePath);
  if (cache && !opts?.refresh && !cache.stale) {
    return { ...cache, source: "cache" };
  }
  try {
    const live = await fetchOpenRouterFreeTextModels(opts);
    return { ...live, stale: false };
  } catch (err) {
    if (cache) return { ...cache, source: "cache" };
    throw err;
  }
}
