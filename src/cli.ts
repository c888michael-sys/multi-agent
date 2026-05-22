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
  type CompleteOptions,
  type ThinkingLevel,
} from "./index.js";

const VALID_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function buildRouter(): Router {
  const providers = loadGeminiProvidersFromEnv();
  if (providers.length === 0) {
    console.error("No GEMINI_KEY_N env vars set. Copy .env.example to .env and fill in keys.");
    process.exit(1);
  }
  return new Router(providers);
}

function buildDefaultAgents(router: Router): Agent[] {
  // System prompts kept short. Lens, not format — match whatever output
  // shape the task expects, but apply the named perspective.
  return [
    new Agent({
      id: "skeptic",
      role: "argues against, finds flaws",
      systemPrompt:
        "Lens: skeptical reviewer. Look for flaws, edge cases, weak assumptions. Output only what the task asks for, through that lens. No preamble.",
      router,
    }),
    new Agent({
      id: "advocate",
      role: "argues for, finds strengths",
      systemPrompt:
        "Lens: enthusiastic advocate. Look for genuine strengths and opportunities. Output only what the task asks for, through that lens. No preamble.",
      router,
    }),
    new Agent({
      id: "pragmatist",
      role: "evaluates feasibility and cost",
      systemPrompt:
        "Lens: pragmatic engineer. Focus on feasibility, cost, what could go wrong in practice. Output only what the task asks for, through that lens. No preamble.",
      router,
    }),
  ];
}

async function cmdAsk(prompt: string, opts: CompleteOptions): Promise<void> {
  const router = buildRouter();
  const out = await router.complete(prompt, opts);
  console.log(out);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

async function cmdAgents(
  prompt: string,
  mode: ControllerMode,
  trace: boolean,
  opts: CompleteOptions,
): Promise<void> {
  const router = buildRouter();
  const subs = buildDefaultAgents(router);
  const controller = new Controller({ router, subAgents: subs, mode });
  const result = await controller.runWithTrace(prompt, opts);

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

Flags (both ask and agents):
  --serious                       enable extended reasoning (thinkingLevel=high)
  --thinking=minimal|low|medium|high
                                  finer-grained control over extended reasoning

Flags for 'agents':
  --mode=parallel|specialist      default: parallel
  --trace                         print per-agent outputs before synthesis

Examples:
  npm run cli -- ask "What's 2+2?"
  npm run cli -- ask --serious "Prove there are infinitely many primes."
  npm run cli -- agents --mode=parallel --trace "Is X a good idea?"
  npm run cli -- agents --serious "Design a cache invalidation strategy for X."
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
      serious: { type: "boolean", default: false },
      thinking: { type: "string" },
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

  // Resolve thinking level: explicit --thinking wins, --serious is shorthand for high.
  let thinking: ThinkingLevel | undefined;
  if (values.thinking !== undefined) {
    const t = values.thinking as string;
    if (!(VALID_THINKING as string[]).includes(t)) {
      console.error(`Error: --thinking must be one of ${VALID_THINKING.join("|")} (got: ${t})`);
      process.exit(2);
    }
    thinking = t as ThinkingLevel;
  } else if (values.serious) {
    thinking = "high";
  }
  const completeOpts: CompleteOptions = thinking !== undefined ? { thinking } : {};

  if (command === "ask") {
    await cmdAsk(prompt, completeOpts);
    return;
  }

  if (command === "agents") {
    const mode = values.mode as string;
    if (mode !== "parallel" && mode !== "specialist") {
      console.error(`Error: --mode must be 'parallel' or 'specialist' (got: ${mode})`);
      process.exit(2);
    }
    await cmdAgents(prompt, mode, Boolean(values.trace), completeOpts);
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
