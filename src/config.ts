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
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const envPath = join(dir, ".env");
      if (!seen.has(envPath) && existsSync(envPath)) {
        seen.add(envPath);
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
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
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

/**
 * Local Ollama models we wire by default when --local is enabled.
 * Provider id format: `ollama:<short-name>` (so the role registry can
 * reference them in candidate chains). Keys are the role they primarily
 * serve so the role-builder knows which to slot where.
 *
 * `numCtx` is the per-model context window in tokens, in addition to
 * Ollama's daemon default of 2048 (which is far too small for our use
 * — even the categorize prefetch wants several thousand). Set to the
 * model's native maximum so we never truncate; OLLAMA_NUM_CTX env var
 * still globally overrides if the machine can't allocate that much VRAM:
 *   - deepseek-r1:32b native context = 128 K (131072). We default to
 *     65 K (65536) — runs on a single 40 GB-class GPU with KV cache,
 *     bump via OLLAMA_NUM_CTX=131072 if you have the memory.
 *   - qwen2.5-coder native context = 32 K (32768). We use the full window.
 */
export const LOCAL_OLLAMA_MODELS = {
  reasoning: { providerId: "ollama:deepseek-r1", model: "deepseek-r1:32b", numCtx: 65536 },
  "action-code": { providerId: "ollama:qwen2.5-coder", model: "qwen2.5-coder:latest", numCtx: 32768 },
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
 * can target them individually (e.g. `ollama:deepseek-r1` for reasoning,
 * `ollama:qwen2.5-coder` for action-code). The base URL defaults to
 * http://localhost:11434 but can be overridden via OLLAMA_HOST env var
 * (useful if Ollama runs on another machine on the LAN).
 *
 * Models live in [[LOCAL_OLLAMA_MODELS]]. To swap which local model
 * fills a role, edit that table; the role registry's `local` overlay
 * picks them up automatically.
 */
export function loadOllamaProviders(opts?: { baseUrl?: string; numCtx?: number }): Provider[] {
  const baseUrl = opts?.baseUrl ?? (process.env.OLLAMA_HOST ?? "http://localhost:11434");
  // Per-model numCtx baked into LOCAL_OLLAMA_MODELS (each at its native
  // max). `opts.numCtx` is a hard override for all local models; the
  // OLLAMA_NUM_CTX env var is the user-facing knob for memory-constrained
  // hardware — set it to e.g. 8192 to fit the 32 B reasoning model on
  // smaller GPUs without disabling local mode entirely.
  const envCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
  const globalOverride = opts?.numCtx ?? (Number.isFinite(envCtx) && envCtx! > 0 ? envCtx! : undefined);
  return Object.values(LOCAL_OLLAMA_MODELS).map((m) => {
    const numCtx = globalOverride ?? m.numCtx;
    return new OllamaProvider({
      id: m.providerId,
      model: m.model,
      baseUrl,
      numCtx,
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
  // Gemma 3 27B-it on the SAME Google project — separate per-model quota
  // pool, ~14,400 RPD on free tier. The big safety net.
  gemma: 14400,
  groq: 1000,
  openrouter: 50,
  cerebras: 1440,
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
 *   cerebras:  30 RPM
 *   mistral:   60 RPM (1 RPS soft limit on Experiment plan)
 */
const DEFAULT_RPM: Record<string, number> = {
  gemini: 5,
  gemma: 30,
  groq: 30,
  openrouter: 20,
  cerebras: 30,
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
 * Google AI Studio's free tier. Gemma 3 27B-it has ~14,400 RPD vs Gemini
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
 * Defaults to DeepSeek V4 Flash (free variant). R1 free was retired by
 * OpenRouter — V4 Flash is the current best free reasoning option in the
 * same family. Override with `opts.model` for any other OpenRouter slug.
 */
export function loadOpenRouterProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.OPENROUTER_KEY ?? "").trim();
  if (!key) return [];
  return [
    new OpenRouterProvider({
      id: "openrouter:deepseek-v4-flash",
      apiKey: key,
      appName: "multi-agent",
      appUrl: "https://github.com/c888michael-sys/multi-agent",
      ...(opts?.model && { model: opts.model }),
    }),
  ];
}

/**
 * Load Cerebras provider from env. Returns [] if CEREBRAS_KEY is unset.
 * Defaults to llama3.1-8b — fastest free option, ideal for bulk repetitive work.
 */
export function loadCerebrasProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.CEREBRAS_KEY ?? "").trim();
  if (!key) return [];
  return [
    new CerebrasProvider({
      id: "cerebras:llama3-8b",
      apiKey: key,
      ...(opts?.model && { model: opts.model }),
    }),
  ];
}

/**
 * Load Mistral provider from env. Returns [] if MISTRAL_KEY is unset.
 * Defaults to codestral-latest — code-specialized for the action-code role.
 */
export function loadMistralProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.MISTRAL_KEY ?? "").trim();
  if (!key) return [];
  return [
    new MistralProvider({
      id: "mistral:codestral",
      apiKey: key,
      ...(opts?.model && { model: opts.model }),
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
