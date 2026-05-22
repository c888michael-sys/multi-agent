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
import { resolve as resolvePath } from "node:path";
import {
  Router,
  Agent,
  Controller,
  loadAllProvidersFromEnv,
  formatUsageReport,
  FileStateStore,
  FileTools,
  BashTool,
  ToolRunner,
  RoleResolver,
  DEFAULT_ROLES,
  type ControllerMode,
  type CompleteOptions,
  type ThinkingLevel,
  type RoleName,
} from "./index.js";

const VALID_ROLES: RoleName[] = [
  "perception",
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
];

const VALID_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function buildRouter(): Router {
  const providers = loadAllProvidersFromEnv();
  if (providers.length === 0) {
    console.error(
      "No provider keys configured. Set at least GEMINI_KEY_1 in .env (see .env.example).",
    );
    process.exit(1);
  }
  return new Router(providers, { stateStore: new FileStateStore() });
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

async function cmdAskRole(
  prompt: string,
  role: RoleName,
  opts: CompleteOptions,
): Promise<void> {
  const router = buildRouter();
  const resolver = new RoleResolver(router, DEFAULT_ROLES);
  const candidate = resolver.resolveCandidate(role);
  if (!candidate) {
    console.error(
      `Error: role '${role}' has no registered candidate providers.\n` +
        `Unsatisfied roles: ${resolver.unsatisfiedRoles().join(", ") || "(none)"}\n` +
        `\nRoster:\n${resolver.rosterDescription()}`,
    );
    process.exit(1);
  }
  console.error(`role '${role}' → ${candidate.providerId}`);
  const out = await resolver.runRole(role, prompt, opts);
  console.log(out);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

async function cmdAskWithTools(
  prompt: string,
  workdir: string,
  trace: boolean,
  allowBash: boolean,
  opts: CompleteOptions,
): Promise<void> {
  const router = buildRouter();
  const fileTools = new FileTools(resolvePath(workdir));
  const tools = fileTools.toolset();
  if (allowBash) {
    tools.push(new BashTool({ workdir: fileTools.workdir }).asTool());
  }
  const runner = new ToolRunner({ router, tools });

  const toolNames = tools.map((t) => t.name).join(", ");
  console.error(`tools enabled (${toolNames}). workdir: ${fileTools.workdir}\n`);
  const result = await runner.run(prompt, opts);

  if (trace) {
    for (const c of result.toolCalls) {
      const status = c.ok ? "✓" : "✗";
      console.error(`${status} ${c.name}(${JSON.stringify(c.args)})`);
      console.error(`   ${c.result.split("\n").slice(0, 3).join("\n   ")}\n`);
    }
    if (result.truncated) console.error("(truncated — hit maxIterations)");
    console.error("--- final ---");
  }
  console.log(result.finalText);
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
  --search                        enable Google Search grounding (free tier: 5000/mo)
                                  appends a Sources block with cited URLs

Flags for 'ask' (tools):
  --tools                         enable local file tools (read_file, write_file, list_dir)
  --allow-bash                    additionally enable the bash tool (cmd.exe on Windows, /bin/sh elsewhere)
                                  no sandbox — runs anything you can run. Implies --tools.
  --workdir=<path>                scope tools to this directory (default: cwd)
  --trace                         print each tool call and its result before the final answer

Flags for 'ask' (role routing):
  --role=<name>                   route through RoleResolver to the named role's primary provider.
                                  Valid: perception, reasoning, orchestration,
                                         action-code, action-structural, action-repetitive

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
      search: { type: "boolean", default: false },
      tools: { type: "boolean", default: false },
      "allow-bash": { type: "boolean", default: false },
      workdir: { type: "string" },
      role: { type: "string" },
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
  const completeOpts: CompleteOptions = {
    ...(thinking !== undefined && { thinking }),
    ...(values.search && { useSearch: true }),
  };

  if (command === "ask") {
    const roleArg = values.role as string | undefined;
    if (roleArg) {
      if (!(VALID_ROLES as string[]).includes(roleArg)) {
        console.error(`Error: --role must be one of ${VALID_ROLES.join("|")} (got: ${roleArg})`);
        process.exit(2);
      }
      await cmdAskRole(prompt, roleArg as RoleName, completeOpts);
    } else if (values.tools || values["allow-bash"]) {
      const workdir = (values.workdir as string | undefined) ?? process.cwd();
      await cmdAskWithTools(
        prompt,
        workdir,
        Boolean(values.trace),
        Boolean(values["allow-bash"]),
        completeOpts,
      );
    } else {
      await cmdAsk(prompt, completeOpts);
    }
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
