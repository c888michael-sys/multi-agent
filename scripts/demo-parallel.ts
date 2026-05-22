/**
 * Demo: 3 sub-agents work the same task in parallel, controller synthesizes.
 * Uses ~4 real requests total (3 sub-agents + 1 synthesis).
 *
 * Run: npx tsx scripts/demo-parallel.ts
 */
import {
  Router,
  Agent,
  Controller,
  loadGeminiProvidersFromEnv,
  formatUsageReport,
} from "../src/index.js";

async function main() {
  const providers = loadGeminiProvidersFromEnv();
  if (providers.length === 0) {
    console.error("No GEMINI_KEY_N env vars set.");
    process.exit(1);
  }
  const router = new Router(providers);

  const subs = [
    new Agent({
      id: "skeptic",
      role: "argues against the proposal, finds weaknesses",
      systemPrompt:
        "You are a skeptical reviewer. Your job is to find flaws, edge cases, and weak assumptions in proposals. Be brief — 2-3 short bullet points.",
      router,
    }),
    new Agent({
      id: "advocate",
      role: "argues for the proposal, finds strengths",
      systemPrompt:
        "You are an enthusiastic advocate. Your job is to find genuine strengths and opportunities. Be brief — 2-3 short bullet points.",
      router,
    }),
    new Agent({
      id: "pragmatist",
      role: "evaluates feasibility and cost",
      systemPrompt:
        "You are a pragmatic engineer. Focus on feasibility, cost, and what could go wrong in practice. Be brief — 2-3 short bullet points.",
      router,
    }),
  ];

  const controller = new Controller({ router, subAgents: subs, mode: "parallel" });

  const task =
    "Proposal: a small Python script that automatically renames every file on the user's desktop to a UUID for 'organization.' Is this a good idea?";

  console.log("\n=== TASK ===");
  console.log(task);

  const trace = await controller.runWithTrace(task);

  console.log("\n=== PER-AGENT OUTPUTS ===");
  for (const p of trace.perAgent ?? []) {
    console.log(`\n[${p.id}]\n${p.output}`);
  }

  console.log("\n=== SYNTHESIS ===");
  console.log(trace.finalOutput);

  console.log("\n=== USAGE ===");
  console.log(formatUsageReport(router));
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
