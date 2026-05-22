import "dotenv/config";
import { GeminiProvider } from "./providers/gemini.js";
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
        id: `gemini:account${m[1]}`,
        apiKey: value,
        ...(opts?.model && { model: opts.model }),
      }),
    );
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  return providers;
}
