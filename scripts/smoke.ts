/**
 * Smoke test: make ONE real round-trip against your configured keys.
 * Uses ~1 request from whichever account is picked first.
 *
 * Run: npm run smoke
 */
import { complete, loadGeminiProvidersFromEnv } from "../src/index.js";

async function main() {
  const providers = loadGeminiProvidersFromEnv();
  if (providers.length === 0) {
    console.error("No GEMINI_KEY_N env vars set. Copy .env.example to .env and fill in keys.");
    process.exit(1);
  }
  console.error(`Configured providers: ${providers.map((p) => p.id).join(", ")}`);
  const reply = await complete("Reply with exactly the word: pong");
  console.log(reply);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
