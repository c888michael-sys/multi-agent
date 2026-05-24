import "dotenv/config";
import { GeminiProvider } from "./providers/gemini.js";
import { GroqProvider } from "./providers/groq.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { CerebrasProvider } from "./providers/cerebras.js";
import { MistralProvider } from "./providers/mistral.js";
import type { Provider } from "./provider.js";
import type { ProviderConfig } from "./pool.js";

/**
 * Per-provider best-guess daily request budgets used to populate the
 * sidebar's quota bars. These are conservative estimates of free-tier
 * limits as of mid-2026 — actual quotas vary by account class and
 * occasionally by Google/OpenRouter policy changes. Override per-deploy
 * by passing `estimatedDailyBudget` explicitly when constructing
 * a provider config.
 *
 * Sources:
 *   gemini: ~1500 RPD per project on Studio free tier
 *   groq:   ~1000 RPD account-wide on free tier
 *   openrouter: ~50 RPD shared across all free models
 *   cerebras: ~1440 RPD (1 RPM rate cap × 24h, the soft daily cap)
 *   mistral: 500 RPD placeholder (Experiment plan is token-based, no
 *            documented hard RPD limit; this just keeps the gauge useful)
 */
const DEFAULT_BUDGETS: Record<string, number> = {
  gemini: 1500,
  groq: 1000,
  openrouter: 50,
  cerebras: 1440,
  mistral: 500,
};

function budgetFor(providerId: string): number {
  const prefix = providerId.split(":")[0] ?? "";
  return DEFAULT_BUDGETS[prefix] ?? 500;
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
 * Defaults to DeepSeek R1 (full 671B) free variant.
 */
export function loadOpenRouterProvidersFromEnv(opts?: { model?: string }): Provider[] {
  const key = (process.env.OPENROUTER_KEY ?? "").trim();
  if (!key) return [];
  return [
    new OpenRouterProvider({
      id: "openrouter:deepseek-v4",
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
    ...loadGroqProvidersFromEnv(),
    ...loadOpenRouterProvidersFromEnv(),
    ...loadCerebrasProvidersFromEnv(),
    ...loadMistralProvidersFromEnv(),
  ];
}

/**
 * Same as loadAllProvidersFromEnv but wraps each provider in a
 * ProviderConfig that carries `estimatedDailyBudget` so the pool can
 * compute remainingPct for the sidebar's quota gauges.
 */
export function loadAllProviderConfigsFromEnv(): ProviderConfig[] {
  return loadAllProvidersFromEnv().map((provider) => ({
    provider,
    estimatedDailyBudget: budgetFor(provider.id),
  }));
}
