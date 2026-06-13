import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the directory of config.ts (either src/ or dist/src/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type EnvFileReport = {
  path: string;
  parsedKeys: string[];
  appliedBlankKeys: string[];
  error?: string;
};

type EnvLoadReport = {
  cwd: string;
  moduleDir: string;
  files: EnvFileReport[];
};

const envLoadReport: EnvLoadReport = {
  cwd: process.cwd(),
  moduleDir: __dirname,
  files: [],
};

// Load environment variables from the nearest project .env. We search from
// both cwd and this module's directory so CLI, tsx, compiled dist, and
// process managers all land on the same file. dotenv deliberately does not
// override existing environment variables; for this local app, an empty shell
// variable should not mask a populated .env value, so blank values are filled
// from the parsed file.
loadProjectEnv();

function loadProjectEnv(): void {
  const seen = new Set<string>();
  for (const envPath of explicitEnvPaths()) {
    loadEnvFile(envPath, seen);
  }
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) loadEnvFile(envPath, seen);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

function explicitEnvPaths(): string[] {
  return [process.env.MULTI_AGENT_ENV, process.env.DOTENV_CONFIG_PATH]
    .map((p) => (p ?? "").trim())
    .filter((p): p is string => p.length > 0);
}

function loadEnvFile(envPath: string, seen: Set<string>): void {
  if (seen.has(envPath)) return;
  seen.add(envPath);

  if (!existsSync(envPath)) {
    envLoadReport.files.push({
      path: envPath,
      parsedKeys: [],
      appliedBlankKeys: [],
      error: "file not found",
    });
    return;
  }

  const result = dotenv.config({ path: envPath });
  const fileReport: EnvFileReport = {
    path: envPath,
    parsedKeys: Object.keys(result.parsed ?? {}).sort(),
    appliedBlankKeys: [],
    ...(result.error && { error: result.error.message }),
  };
  for (const [key, value] of Object.entries(result.parsed ?? {})) {
    if ((process.env[key] ?? "").trim() === "") {
      process.env[key] = value;
      fileReport.appliedBlankKeys.push(key);
    }
  }
  fileReport.appliedBlankKeys.sort();
  envLoadReport.files.push(fileReport);
}

export function getEnvLoadReport(): EnvLoadReport {
  return {
    cwd: envLoadReport.cwd,
    moduleDir: envLoadReport.moduleDir,
    files: envLoadReport.files.map((f) => ({
      path: f.path,
      parsedKeys: [...f.parsedKeys],
      appliedBlankKeys: [...f.appliedBlankKeys],
      ...(f.error && { error: f.error }),
    })),
  };
}

import { GeminiProvider } from "./providers/gemini.js";
import { GroqProvider } from "./providers/groq.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { CerebrasProvider } from "./providers/cerebras.js";
import { MistralProvider } from "./providers/mistral.js";
import { OllamaProvider } from "./providers/ollama.js";
import type { Provider } from "./provider.js";
import type { ProviderConfig } from "./pool.js";
import {
  OPENROUTER_REASONING_PROVIDER_ID,
  readReasoningModelOverride,
} from "./models/reasoning-model-overrides.js";

/**
 * Local Ollama models we wire by default when --local is enabled.
 * Provider id format: `ollama:<short-name>` (so the role registry can
 * reference them in candidate chains). Keys are the role they primarily
 * serve so the role-builder knows which to slot where.
 *
 * `numCtx` is the per-model context window in tokens. Ollama's daemon
 * default of 2048 is too small for our prompts, but forcing a huge
 * window on 32B models can exhaust VRAM/RAM because KV cache grows
 * with context. The default pair is intentionally 14B + 14B so both
 * local roles can use a useful 32K context on consumer hardware. Users
 * can opt up to larger models with OLLAMA_REASONING_MODEL /
 * OLLAMA_CODER_MODEL and tune memory with per-role *_NUM_CTX vars.
 *
 * `requestTimeoutMs` is intentionally long for local 32B models: a
 * cold model load can be slow, and waiting is better than skipping
 * local reasoning just because it took a few minutes.
 */
export const LOCAL_OLLAMA_MODELS = {
  reasoning: {
    providerId: "ollama:qwen3.5-9b",
    model: "qwen3.5:9b",
    numCtx: 32_768,
    requestTimeoutMs: 15 * 60_000,
    modelEnv: "OLLAMA_REASONING_MODEL",
    numCtxEnv: "OLLAMA_REASONING_NUM_CTX",
  },
  "action-code": {
    providerId: "ollama:qwen2.5-coder",
    model: "qwen2.5-coder:14b",
    numCtx: 32_768,
    requestTimeoutMs: 10 * 60_000,
    modelEnv: "OLLAMA_CODER_MODEL",
    numCtxEnv: "OLLAMA_CODER_NUM_CTX",
  },
} as const;

/**
 * Per-provider best-guess daily request budgets used to populate the
 * sidebar's quota bars. These are conservative estimates of free-tier
 * limits as of mid-2026 — actual quotas vary by account class and
 * occasionally by Google/OpenRouter policy changes. Override per-deploy
 * by passing `estimatedDailyBudget` explicitly when constructing
 * a provider config.
 *
 * Sources:
 *   gemini: 20 RPD/project on the legacy free tier (CONFIRMED May 2026
 *           against this project's accounts). Google's docs sometimes
 *           quote 1500 — that's the upgraded/paid number, NOT what a
 *           fresh free project actually gets.
 *   groq:   ~1000 RPD account-wide on free tier
 *   openrouter: ~50 RPD shared across all free models
 *   cerebras: ~1440 RPD (1 RPM rate cap × 24h, the soft daily cap)
 *   mistral: 500 RPD placeholder (Experiment plan is token-based, no
 *            documented hard RPD limit; this just keeps the gauge useful)
 */
/**
 * Build the locally-hosted Ollama providers used by the hybrid mode.
 * Each is registered with a unique provider id so the role registry
 * can target them individually (e.g. `ollama:qwen3.5-9b` for reasoning,
 * `ollama:qwen2.5-coder` for action-code). The base URL defaults to
 * http://localhost:11434 but can be overridden via OLLAMA_HOST env var
 * (useful if Ollama runs on another machine on the LAN).
 *
 * Models live in [[LOCAL_OLLAMA_MODELS]]. To swap which local model
 * fills a role, edit that table; the role registry's `local` overlay
 * picks them up automatically.
 */
export function loadOllamaProviders(opts?: {
  baseUrl?: string;
  numCtx?: number;
  requestTimeoutMs?: number;
}): Provider[] {
  const baseUrl = opts?.baseUrl ?? (process.env.OLLAMA_HOST ?? "http://localhost:11434");
  // Per-model numCtx is baked into LOCAL_OLLAMA_MODELS. opts.numCtx and
  // OLLAMA_NUM_CTX set the global value; role-specific *_NUM_CTX vars win
  // when mixing model sizes, e.g. 32B reasoner + 14B coder.
  // OLLAMA_REQUEST_TIMEOUT_MS can override local-model patience globally.
  const envCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
  const envTimeout = process.env.OLLAMA_REQUEST_TIMEOUT_MS
    ? Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS)
    : undefined;
  const globalOverride = opts?.numCtx ?? (Number.isFinite(envCtx) && envCtx! > 0 ? envCtx! : undefined);
  const timeoutOverride =
    opts?.requestTimeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout! > 0 ? envTimeout! : undefined);
  return Object.values(LOCAL_OLLAMA_MODELS).map((m) => {
    const roleCtx = process.env[m.numCtxEnv] ? Number(process.env[m.numCtxEnv]) : undefined;
    const numCtx =
      (Number.isFinite(roleCtx) && roleCtx! > 0 ? roleCtx! : undefined) ??
      globalOverride ??
      m.numCtx;
    return new OllamaProvider({
      id: m.providerId,
      model: process.env[m.modelEnv]?.trim() || m.model,
      baseUrl,
      numCtx,
      requestTimeoutMs: timeoutOverride ?? m.requestTimeoutMs,
    });
  });
}

const DEFAULT_BUDGETS: Record<string, number> = {
  // Gemini 3.5 Flash on Studio free tier — CONFIRMED via this project's
  // accounts (May 2026): 20 RPD, 5 RPM, 250k TPM per project. Google's
  // headline 1500 RPD/project is the upgraded-tier number; newer free
  // projects ship with 20. Override per-deploy via `estimatedDailyBudget`
  // if your project actually has the upgraded cap.
  gemini: 20,
  // Gemma 4 31B-it on the SAME Google project — separate per-model quota
  // pool, ~14,400 RPD on free tier. The big safety net.
  gemma: 14400,
  groq: 1000,
  openrouter: 50,
  cerebras: 2400,  // live-verified May 2026: x-ratelimit-limit-requests-day=2400 on gpt-oss-120b
  mistral: 500,
  // Local Ollama models — no daily cap. Display gauge as 9999 so the
  // sidebar shows them as effectively unlimited without special-casing.
  ollama: 9999,
};

/**
 * Per-minute request caps. Used to drive the live RPM gauge and to warn
 * when the user is about to trip the per-minute window (which is a much
 * faster recovery than RPD — minute, not 24h).
 *
 * Free-tier numbers as of mid-2026 (will drift; override per-deploy via
 * `estimatedRpmCap` on the provider config):
 *   gemini:    5 RPM per project on Studio free tier (confirmed May 2026
 *              against this project's accounts; the "15 RPM" number some
 *              docs quote applies to upgraded/paid tiers)
 *   gemma:     30 RPM (Gemma's per-model pool, distinct from Flash)
 *   groq:      30 RPM account-wide
 *   openrouter: 20 RPM on `:free` models (shared pool)
 *   cerebras:   5 RPM (live-verified May 2026 on gpt-oss-120b; was incorrectly set to 30)
 *   mistral:   60 RPM (1 RPS soft limit on Experiment plan)
 */
const DEFAULT_RPM: Record<string, number> = {
  gemini: 5,
  gemma: 30,
  groq: 30,
  openrouter: 20,
  cerebras: 5,
  mistral: 60,
  // Local Ollama — bounded only by the machine; pick a generous cap so
  // the RPM gauge effectively shows headroom rather than throttling.
  ollama: 999,
};

function budgetFor(providerId: string): number {
  const prefix = providerId.split(":")[0] ?? "";
  return DEFAULT_BUDGETS[prefix] ?? 500;
}

function rpmCapFor(providerId: string): number {
  const prefix = providerId.split(":")[0] ?? "";
  return DEFAULT_RPM[prefix] ?? 30;
}

/**
 * Fallback cooldown per provider — used ONLY when a rate-limit response
 * arrives without a Retry-After header. Real cooldowns from the wire
 * always take precedence. Per-provider tuning matters because the per-
 * minute reset window differs (OpenRouter free is ~10s; Gemini is ~60s).
 */
const DEFAULT_COOLDOWN_MS: Record<string, number> = {
  gemini: 60_000,
  gemma: 60_000,
  groq: 60_000,
  openrouter: 10_000,
  cerebras: 60_000,
  mistral: 60_000,
  // Local Ollama — never rate-limits, never cools. The short value
  // here is harmless because isRateLimitError always returns false.
  ollama: 1_000,
};

function defaultCooldownFor(providerId: string): number {
  const prefix = providerId.split(":")[0] ?? "";
  return DEFAULT_COOLDOWN_MS[prefix] ?? 60_000;
}

/**
 * Discover all GEMINI_KEY_N env vars and build a provider per non-empty entry.
 * Scales by adding GEMINI_KEY_3, _4, etc. — no code change needed.
 */
export function loadGeminiProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const providers: Provider[] = [];
  const seen = new Set<string>();

  for (const [name, raw] of Object.entries(process.env)) {
    const m = name.match(/^GEMINI_KEY_(\d+)$/);
    if (!m) continue;
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    providers.push(
      new GeminiProvider({
        // Neutral label: the N matches GEMINI_KEY_N. Whether each slot is a
        // separate Google account, a separate Cloud project under one account,
        // or a mix is a deployment choice — the router treats them identically.
        id: `gemini:${m[1]}`,
        apiKey: value,
        ...(opts?.model && { model: opts.model }),
      }),
    );
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  return providers;
}

/**
 * Build a Gemma provider per GEMINI_KEY_N — same key, different model on
 * the same Google Cloud project = a SEPARATE per-model RPD quota pool on
 * Google AI Studio's free tier. Gemma 4 31B-it has ~14,400 RPD vs Gemini
 * 3.5 Flash's ~20-1,500 RPD, so adding these slots gives every role a
 * huge low-priority safety net for "all Flash keys cooled" days.
 *
 * Default model: `gemma-4-31b-it`. (Gemma 3 — `gemma-3-27b-it` — was
 * retired from AI Studio by May 2026: it returns a hard 404 on
 * generateContent and no longer appears in ListModels. The current
 * Gemma 4 slugs are `gemma-4-31b-it` (dense, the 27B's successor) and
 * `gemma-4-26b-a4b-it` (MoE, ~4B active — faster, lighter). We default
 * to the 31B for the safety-net role's JSON-following quality; override
 * via `opts.model` for the MoE variant or any future Gemma slug.)
 */
export function loadGemmaProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const providers: Provider[] = [];
  const seen = new Set<string>();
  const model = opts?.model ?? "gemma-4-31b-it";

  for (const [name, raw] of Object.entries(process.env)) {
    const m = name.match(/^GEMINI_KEY_(\d+)$/);
    if (!m) continue;
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    providers.push(
      new GeminiProvider({
        id: `gemma:${m[1]}`,
        apiKey: value,
        model,
      }),
    );
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  return providers;
}

/**
 * Load Groq provider from env. Returns [] if GROQ_KEY is unset, so the rest
 * of the system gracefully degrades to Gemini-only fallback for any role
 * that listed groq:* as primary.
 */
export function loadGroqProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.GROQ_KEY ?? "").trim();
  if (!key) return [];
  return [
    new GroqProvider({
      id: "groq:llama-70b",
      apiKey: key,
      ...(opts?.model && { model: opts.model }),
    }),
  ];
}

/**
 * Load OpenRouter provider from env. Returns [] if OPENROUTER_KEY is unset.
 * Defaults to Qwen3-Next 80B MoE (free tier) — 262K context, used as the
 * primary online reasoner. Override with `opts.model` for any other slug.
 */
export function loadOpenRouterProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.OPENROUTER_KEY ?? "").trim();
  if (!key) return [];
  return [
    new OpenRouterProvider({
      id: OPENROUTER_REASONING_PROVIDER_ID,
      apiKey: key,
      appName: "multi-agent",
      appUrl: "https://github.com/c888michael-sys/multi-agent",
      ...(opts?.model
        ? { model: opts.model }
        : { modelResolver: () => readReasoningModelOverride().model }),
    }),
  ];
}

/**
 * Load Cerebras provider from env. Returns [] if CEREBRAS_KEY is unset.
 * Defaults to gpt-oss-120b — currently available on this Cerebras account.
 */
export function loadCerebrasProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.CEREBRAS_KEY ?? "").trim();
  if (!key) return [];
  return [
    new CerebrasProvider({
      id: "cerebras:gpt-oss-120b",
      apiKey: key,
      ...(opts?.model && { model: opts.model }),
    }),
  ];
}

/**
 * Load Mistral provider from env. Returns [] if MISTRAL_KEY is unset.
 * Defaults to mistral-large-latest — Mistral's strongest model, free on the
 * Experiment plan and reliable at function calling (verified live 2026-06).
 * Override the model via MISTRAL_MODEL (e.g. mistral-small-latest if Large's
 * rate limits become a problem, or codestral-latest for code-completion).
 */
export function loadMistralProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.MISTRAL_KEY ?? "").trim();
  if (!key) return [];
  const model = opts?.model ?? ((process.env.MISTRAL_MODEL ?? "").trim() || "mistral-large-latest");
  return [
    new MistralProvider({
      id: "mistral:large",
      apiKey: key,
      model,
    }),
  ];
}

/** Load every provider whose key is present in env. Used by the CLI's router setup. */
export function loadAllProvidersFromEnv(): Provider[] {
  return [
    ...loadGeminiProvidersFromEnv(),
    ...loadGemmaProvidersFromEnv(),
    ...loadGroqProvidersFromEnv(),
    ...loadOpenRouterProvidersFromEnv(),
    ...loadCerebrasProvidersFromEnv(),
    ...loadMistralProvidersFromEnv(),
  ];
}

/**
 * Same as loadAllProvidersFromEnv but wraps each provider in a
 * ProviderConfig that carries `estimatedDailyBudget` AND `estimatedRpmCap`
 * so the pool can compute remaining quota for both the RPD bar (daily,
 * resets at UTC midnight) and the RPM gauge (rolling 60s window).
 */
export function loadAllProviderConfigsFromEnv(): ProviderConfig[] {
  return loadAllProvidersFromEnv().map((provider) => ({
    provider,
    estimatedDailyBudget: budgetFor(provider.id),
    estimatedRpmCap: rpmCapFor(provider.id),
    defaultCooldownMs: defaultCooldownFor(provider.id),
  }));
}
