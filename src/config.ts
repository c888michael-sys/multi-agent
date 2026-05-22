import "dotenv/config";
import { GeminiProvider } from "./providers/gemini.js";
import { GroqProvider } from "./providers/groq.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { CerebrasProvider } from "./providers/cerebras.js";
import type { Provider } from "./provider.js";

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

/** Load every provider whose key is present in env. Used by the CLI's router setup. */
export function loadAllProvidersFromEnv(): Provider[] {
  return [
    ...loadGeminiProvidersFromEnv(),
    ...loadGroqProvidersFromEnv(),
    ...loadOpenRouterProvidersFromEnv(),
    ...loadCerebrasProvidersFromEnv(),
  ];
}
