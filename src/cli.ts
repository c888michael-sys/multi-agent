#!/usr/bin/env node
/**
 * multi-agent CLI.
 *
 * Commands:
 *   ask <prompt>                          single complete() call through the router
 *   agents <prompt>                       run a 3-agent (skeptic/advocate/pragmatist) controller
 *   usage                                 print current router snapshot (counts, cooldowns, % remaining)
 *
 * Flags for `agents`:
 *   --mode=parallel|specialist            default: parallel
 *   --trace                               print each sub-agent's output before synthesis
 *
 * Examples:
 *   npm run cli -- ask "What's 2+2?"
 *   npm run cli -- agents --mode=parallel --trace "Is X a good idea?"
 */
import { parseArgs } from "node:util";
import {
  Router,
  Agent,
  Controller,
  loadGeminiProvidersFromEnv,
  formatUsageReport,
  type ControllerMode,
} from "./index.js";

function buildRouter(): Router {
  const providers = loadGeminiProvidersFromEnv();
  if (providers.length === 0) {
    console.error("No GEMINI_KEY_N env vars set. Copy .env.example to .env and fill in keys.");
    process.exit(1);
  }
  return new Router(providers);
}

function buildDefaultAgents(router: Router): Agent[] {
  return [
    new Agent({
      id: "skeptic",
      role: "argues against, finds flaws",
      systemPrompt:
        "You are a skeptical reviewer. Find flaws, edge cases, and weak assumptions. Be brief — 2-3 short bullets.",
      router,
    }),
    new Agent({
      id: "advocate",
      role: "argues for, finds strengths",
      systemPrompt:
        "You are an enthusiastic advocate. Find genuine strengths and opportunities. Be brief — 2-3 short bullets.",
      router,
    }),
    new Agent({
      id: "pragmatist",
      role: "evaluates feasibility and cost",
      systemPrompt:
        "You are a pragmatic engineer. Focus on feasibility, cost, and what could go wrong. Be brief — 2-3 short bullets.",
      router,
    }),
  ];
}

async function cmdAsk(prompt: string): Promise<void> {
  const router = buildRouter();
  const out = await router.complete(prompt);
  console.log(out);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

async function cmdAgents(prompt: string, mode: ControllerMode, trace: boolean): Promise<void> {
  const router = buildRouter();
  const subs = buildDefaultAgents(router);
  const controller = new Controller({ router, subAgents: subs, mode });
  const result = await controller.runWithTrace(prompt);

  if (trace) {
    if (result.pickedAgentId) {
      console.error(`--- specialist picked: ${result.pickedAgentId} ---\n`);
    } else if (result.perAgent) {
      for (const p of result.perAgent) {
        console.error(`--- ${p.id} ---\n${p.output}\n`);
      }
      console.error("--- synthesis ---");
    }
  }
  console.log(result.finalOutput);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

function cmdUsage(): void {
  const router = buildRouter();
  console.log(formatUsageReport(router));
}

function printHelp(): void {
  console.log(`multi-agent CLI

Commands:
  ask <prompt>             single completion through the router
  agents <prompt>          orchestrate sub-agents (default: parallel, 3 agents)
  usage                    print router state (counts, cooldowns, % remaining)

Flags for 'agents':
  --mode=parallel|specialist   default: parallel
  --trace                      print per-agent outputs before synthesis

Examples:
  npm run cli -- ask "What's 2+2?"
  npm run cli -- agents --mode=parallel --trace "Is X a good idea?"
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "usage") {
    cmdUsage();
    return;
  }

  // ask and agents both consume flags + a single prompt arg.
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      mode: { type: "string", default: "parallel" },
      trace: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error(`Error: ${command} requires a prompt argument.\n`);
    printHelp();
    process.exit(2);
  }

  if (command === "ask") {
    await cmdAsk(prompt);
    return;
  }

  if (command === "agents") {
    const mode = values.mode as string;
    if (mode !== "parallel" && mode !== "specialist") {
      console.error(`Error: --mode must be 'parallel' or 'specialist' (got: ${mode})`);
      process.exit(2);
    }
    await cmdAgents(prompt, mode, Boolean(values.trace));
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(2);
}

main().catch((err) => {
  console.error("CLI error:", err);
  process.exit(1);
});
