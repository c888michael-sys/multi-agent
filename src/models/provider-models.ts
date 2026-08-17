import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OverrideProviderName } from "./reasoning-model-overrides.js";
import {
  listOpenRouterFreeTextModels,
  type OpenRouterFreeModelOption,
} from "./openrouter-models.js";
import { classifyModelBilling, type ModelBilling } from "./model-billing.js";

/** A model the user can pick for a role, normalized across providers. */
export interface ProviderModelOption {
  id: string;
  name: string;
  contextLength?: number;
  reasoningCapable?: boolean;
  created?: number;
  billing: ModelBilling;
}

export interface ListModelsResult {
  models: ProviderModelOption[];
  source: "live" | "cache" | "empty";
  fetchedAt: number | null;
  stale: boolean;
}

export const PROVIDER_MODELS_CACHE_VERSION = 2;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheDir(override?: string): string {
  return (
    override ??
    process.env.MULTI_AGENT_PROVIDER_MODELS_CACHE ??
    join(homedir(), ".multi-agent", "models-cache")
  );
}

function cachePath(provider: OverrideProviderName, dir?: string): string {
  return join(cacheDir(dir), `${provider}.json`);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOption(input: unknown, provider: OverrideProviderName): ProviderModelOption | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  const ctx = numeric(raw.contextLength);
  const created = numeric(raw.created);
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
    ...(ctx !== undefined ? { contextLength: ctx } : {}),
    ...(raw.reasoningCapable === true ? { reasoningCapable: true } : {}),
    ...(created !== undefined ? { created } : {}),
    billing: classifyModelBilling(provider, raw.id),
  };
}

function sortOptions(models: ProviderModelOption[]): ProviderModelOption[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function readCache(
  provider: OverrideProviderName,
  dir: string | undefined,
  now: number,
): { models: ProviderModelOption[]; fetchedAt: number; stale: boolean } | null {
  const path = cachePath(provider, dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      fetchedAt?: unknown;
      models?: unknown;
    };
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION) return null;
    const fetchedAt = numeric(parsed.fetchedAt) ?? 0;
    const models = Array.isArray(parsed.models)
      ? sortOptions(
          parsed.models
            .map((m) => normalizeOption(m, provider))
            .filter((m): m is ProviderModelOption => Boolean(m)),
        )
      : [];
    if (fetchedAt <= 0 || models.length === 0) return null;
    return { models, fetchedAt, stale: now - fetchedAt > CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function writeCache(
  provider: OverrideProviderName,
  models: ProviderModelOption[],
  dir: string | undefined,
  fetchedAt: number,
): void {
  const path = cachePath(provider, dir);
  mkdirSync(cacheDir(dir), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: PROVIDER_MODELS_CACHE_VERSION, fetchedAt, models }, null, 2)}\n`,
    "utf8",
  );
}

// ── per-provider live fetchers ───────────────────────────────────────────────

const OPENAI_COMPAT_MODELS_URL: Partial<Record<OverrideProviderName, string>> = {
  nvidia: "https://integrate.api.nvidia.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  cerebras: "https://api.cerebras.ai/v1/models",
};

/** GET /v1/models on an OpenAI-compatible provider → `{ data: [{ id, … }] }`. */
async function fetchOpenAICompatModels(
  provider: OverrideProviderName,
  url: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ProviderModelOption[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`models request failed: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  const data = Array.isArray(json.data) ? json.data : [];
  const out: ProviderModelOption[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id.trim()) continue;
    const ctx = numeric(m.context_length) ?? numeric(m.context_window) ?? numeric(m.max_context_length);
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name.trim() ? m.name : m.id,
      ...(ctx !== undefined ? { contextLength: ctx } : {}),
      ...(numeric(m.created) !== undefined ? { created: numeric(m.created)! } : {}),
      billing: classifyModelBilling(provider, m.id),
    });
  }
  return sortOptions(out);
}

/** Gemini ListModels via the public REST surface. Filters to generateContent. */
async function fetchGeminiModels(
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ProviderModelOption[]> {
  if (!apiKey) throw new Error("gemini model list requires a Gemini API key");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`models request failed: HTTP ${res.status}`);
  const json = (await res.json()) as { models?: unknown };
  const models = Array.isArray(json.models) ? json.models : [];
  const out: ProviderModelOption[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === "string" ? m.name : "";
    if (!name) continue;
    const methods = Array.isArray(m.supportedGenerationMethods)
      ? (m.supportedGenerationMethods as unknown[]).map((x) => String(x))
      : [];
    if (!methods.includes("generateContent")) continue;
    const id = name.replace(/^models\//, "");
    const ctx = numeric(m.inputTokenLimit);
    out.push({
      id,
      name: typeof m.displayName === "string" && m.displayName.trim() ? m.displayName : id,
      ...(ctx !== undefined ? { contextLength: ctx } : {}),
      billing: classifyModelBilling("gemini", id),
    });
  }
  return sortOptions(out);
}

/** Locally-installed Ollama models via /api/tags. No key needed. */
async function fetchOllamaModels(fetchImpl: typeof fetch): Promise<ProviderModelOption[]> {
  const baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const res = await fetchImpl(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags failed: HTTP ${res.status}`);
  const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
  const out: ProviderModelOption[] = [];
  for (const m of json.models ?? []) {
    const name = typeof m?.name === "string" ? m.name : "";
    if (name) out.push({ id: name, name, billing: classifyModelBilling("ollama", name) });
  }
  return sortOptions(out);
}

function fromOpenRouter(models: OpenRouterFreeModelOption[]): ProviderModelOption[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.contextLength,
    reasoningCapable: m.reasoningCapable,
    created: m.created,
    billing: classifyModelBilling("openrouter", m.id),
  }));
}

/**
 * List the models available for a provider, normalized for the per-role model
 * picker. OpenRouter reuses its dedicated free-tier fetcher (with rich
 * filtering); every other provider hits its model-list endpoint and is cached
 * per provider under ~/.multi-agent/models-cache/<provider>.json with a 12h TTL.
 */
export async function listModelsForProvider(
  provider: OverrideProviderName,
  opts?: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    refresh?: boolean;
    cacheDir?: string;
    now?: number;
  },
): Promise<ListModelsResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  // OpenRouter keeps its own richer cache + free-tier filtering.
  if (provider === "openrouter") {
    const r = await listOpenRouterFreeTextModels({
      ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts?.refresh ? { refresh: true } : {}),
    });
    return { models: fromOpenRouter(r.models), source: r.source, fetchedAt: r.fetchedAt, stale: r.stale };
  }

  const now = opts?.now ?? Date.now();
  // Resolve once so an environment change during an in-flight request cannot
  // make the read and write target different cache directories.
  const resolvedCacheDir = cacheDir(opts?.cacheDir);
  const cached = readCache(provider, resolvedCacheDir, now);
  if (cached && !opts?.refresh && !cached.stale) {
    return { ...cached, source: "cache" };
  }

  let models: ProviderModelOption[];
  try {
    if (provider === "gemini") {
      models = await fetchGeminiModels(opts?.apiKey, fetchImpl);
    } else if (provider === "ollama") {
      models = await fetchOllamaModels(fetchImpl);
    } else {
      const url = OPENAI_COMPAT_MODELS_URL[provider];
      if (!url) return { models: [], source: "empty", fetchedAt: null, stale: false };
      models = await fetchOpenAICompatModels(provider, url, opts?.apiKey, fetchImpl);
    }
  } catch (err) {
    if (cached) return { ...cached, source: "cache" };
    throw err;
  }

  const fetchedAt = Date.now();
  try {
    writeCache(provider, models, resolvedCacheDir, fetchedAt);
  } catch {
    // A cache persistence failure must not downgrade a successful live result.
  }
  return { models, source: "live", fetchedAt, stale: false };
}
