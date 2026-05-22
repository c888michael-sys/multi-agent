/**
 * Verify each configured key independently. One real request per key.
 * Use after adding/rotating keys to confirm each one talks to the API.
 *
 * Run: npx tsx scripts/verify-keys.ts
 */
import { loadGeminiProvidersFromEnv } from "../src/index.js";

async function main() {
  const providers = loadGeminiProvidersFromEnv();
  if (providers.length === 0) {
    console.error("No GEMINI_KEY_N env vars set.");
    process.exit(1);
  }

  console.log(`Verifying ${providers.length} key(s)...\n`);
  let allOk = true;

  for (const p of providers) {
    process.stdout.write(`${p.id.padEnd(12)} ... `);
    try {
      const reply = await p.complete("Reply with exactly: ok");
      const text = reply.trim().toLowerCase();
      if (text.includes("ok")) {
        console.log(`✓ (reply: ${reply.trim().slice(0, 40)})`);
      } else {
        console.log(`✓ but unexpected reply: ${reply.trim().slice(0, 60)}`);
      }
    } catch (err) {
      console.log(`✗ ${(err as Error).message}`);
      allOk = false;
    }
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Verify failed:", err);
  process.exit(1);
});
