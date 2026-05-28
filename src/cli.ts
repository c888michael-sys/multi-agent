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
  loadAllProviderConfigsFromEnv,
  formatUsageReport,
  attachConservationPolicy,
  FileStateStore,
  FileTools,
  BashTool,
  WebSearchTool,
  ToolRunner,
  RoleResolver,
  RoleOrchestrator,
  ChatSession,
  ChatRepl,
  listSessions,
  startWebServer,
  DEFAULT_ROLES,
  buildDefaultRoles,
  loadOllamaProviders,
  type ControllerMode,
  type CompleteOptions,
  type ThinkingLevel,
  type RoleName,
  type RoleEvent,
} from "./index.js";

/** Stderr warning printer for role-resolution events. */
function printRoleEvent(e: RoleEvent): void {
  switch (e.type) {
    case "fallback-within-role":
      console.error(
        `⚠ role '${e.role}': primary ${e.primaryProviderId} cooling, used backup ${e.usedProviderId}`,
      );
      break;
    case "cross-role-substitution":
      console.error(
        `⚠ role '${e.role}' exhausted; substituting from outside the role's candidate list (one of: ${e.usedProviderId}). Capabilities may be degraded.`,
      );
      break;
    case "role-exhausted":
      console.error(`⚠ role '${e.role}' fully exhausted — no provider could serve.`);
      break;
  }
}

const VALID_ROLES: RoleName[] = [
  "perception",
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
];

const VALID_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function buildRouter(opts?: { local?: boolean }): Router {
  const configs = loadAllProviderConfigsFromEnv();
  if (opts?.local) {
    for (const p of loadOllamaProviders()) {
      configs.push({ provider: p, estimatedDailyBudget: 9999, estimatedRpmCap: 999 });
    }
  }
  if (configs.length === 0) {
    console.error(
      "No provider keys configured. Set at least GEMINI_KEY_1 in .env (see .env.example).",
    );
    process.exit(1);
  }
  const router = new Router(configs, { stateStore: new FileStateStore() });
  // ConservationPolicy auto-ticks after every successful call. With
  // ProviderConfig budgets now wired, this drives the sidebar's quota
  // gauges and the round-robin → serial mode flip in real time.
  attachConservationPolicy(router);
  return router;
}

/** Roles registry for the run — local-aware when --local is set. */
function rolesFor(local: boolean) {
  return local ? buildDefaultRoles({ local: true }) : DEFAULT_ROLES;
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

async function cmdAsk(prompt: string, opts: CompleteOptions, local: boolean): Promise<void> {
  const router = buildRouter({ local });
  const out = await router.complete(prompt, opts);
  console.log(out);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

async function cmdAskRole(
  prompt: string,
  role: RoleName,
  opts: CompleteOptions,
  local: boolean,
): Promise<void> {
  const router = buildRouter({ local });
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: printRoleEvent });
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
  local: boolean,
): Promise<void> {
  const router = buildRouter({ local });
  const fileTools = new FileTools(resolvePath(workdir));
  const tools = fileTools.toolset();
  if (allowBash) {
    tools.push(new BashTool({ workdir: fileTools.workdir }).asTool());
  }
  // Web search is always registered. Uses Brave if BRAVE_SEARCH_KEY is in
  // env (free 2000 q/mo); falls back to DuckDuckGo Instant Answer (no key
  // needed, lower coverage) otherwise. Either way the model decides
  // whether to call it.
  tools.push(new WebSearchTool().tool());
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
  local: boolean,
): Promise<void> {
  const router = buildRouter({ local });
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

async function cmdChat(sessionId: string, powerful: boolean, local: boolean): Promise<void> {
  const router = buildRouter({ local });
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: printRoleEvent });
  const session = new ChatSession({ resolver, id: sessionId, powerful });
  const repl = new ChatRepl({ session, router });
  await repl.run();
}

async function cmdServe(port: number, local: boolean): Promise<void> {
  // Always register Ollama providers at boot so the web UI's per-request
  // `useLocal` toggle has something to route to. If the local daemon
  // isn't running, calls just fail with a fetch error — same shape as
  // any cloud provider with a bad key.
  const router = buildRouter({ local: true });
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: printRoleEvent });
  // Alternate-mode resolver: when CLI booted with --local, this is the
  // cloud-only resolver; without --local, this is the local-prepend
  // resolver. Either way, the web UI can ask for the other mode per
  // request via `useLocal` in the body.
  const localResolver = local
    ? resolver
    : new RoleResolver(router, rolesFor(true), { onEvent: printRoleEvent });
  const cloudResolver = local
    ? new RoleResolver(router, rolesFor(false), { onEvent: printRoleEvent })
    : resolver;
  const { url } = startWebServer({
    router,
    resolver,
    localResolver,
    cloudResolver,
    port,
  });
  console.log(`multi-agent web UI live at ${url}`);
  console.log(`open it in a browser. Ctrl+C to stop.`);
  // Keep the process alive — server holds the event loop. Wait forever.
  await new Promise<void>(() => {});
}

function cmdSessions(): void {
  const ids = listSessions();
  if (ids.length === 0) {
    console.log("(no sessions yet — start one with `npm run cli -- chat <name>`)");
    return;
  }
  for (const id of ids) console.log(id);
}

async function cmdTask(prompt: string, trace: boolean, opts: CompleteOptions, local: boolean): Promise<void> {
  const router = buildRouter({ local });
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: printRoleEvent });
  const unsat = resolver.unsatisfiedRoles();
  if (unsat.length > 0) {
    console.error(
      `Note: ${unsat.length} role(s) have no registered primary candidate; falling back to Gemini:\n  ${unsat.join(", ")}`,
    );
  }
  const orchestrator = new RoleOrchestrator({ resolver });
  const result = await orchestrator.runWithTrace(prompt, opts);

  if (trace) {
    console.error(`--- plan: ${result.plan.kind} ---`);
    if (result.plan.kind === "single") console.error(`role: ${result.plan.role}`);
    if (result.plan.kind === "parallel") {
      for (const t of result.plan.tasks) console.error(`  ${t.role}: ${t.prompt}`);
    }
    if (result.perRole) {
      for (const r of result.perRole) {
        console.error(`\n--- ${r.role} ---\n${r.output}`);
      }
      console.error(`\n--- synthesis ---`);
    }
  }
  console.log(result.finalOutput);
  console.error(`\n--- usage ---\n${formatUsageReport(router)}`);
}

function printHelp(): void {
  console.log(`multi-agent CLI

Commands:
  ask <prompt>             single completion through the router
  agents <prompt>          orchestrate fixed sub-agents (parallel/specialist modes)
  task <prompt>            roster-aware orchestrator picks roles automatically
  chat <session-name>      interactive multi-turn REPL with persistent history
                           (smart-routing on by default; orchestrator picks
                            direct/single specialist/parallel per turn)
  sessions                 list saved chat session names
  serve                    start the local web UI on http://localhost:<port>
                           (default 7421). Also exposed as: npm run web
  usage                    print router state (counts, cooldowns, % remaining)

Flags for 'task':
  --serious                       extended reasoning across all calls in the run
  --thinking=minimal|low|medium|high
  --trace                         print the plan + per-role outputs before synthesis

Flags for 'chat':
  --powerful                      start in powerful mode (Gemini thinking=high
                                  on every call this session). Also toggleable
                                  mid-session via /power.

Flags for 'serve':
  --port=<n>                      port to bind (default 7421)
  --local                         default the web UI into hybrid local-model mode
                                  (DeepSeek-R1 32B for reasoning, Qwen 2.5 Coder for
                                  action-code via Ollama at localhost:11434). The web
                                  UI can still toggle modes per request; this flag
                                  only sets the initial default.

Flag (any command — ask/agents/task/chat/serve):
  --local                         prepend the local Ollama providers to the role
                                  registry for this run (reasoning→ollama:deepseek-r1,
                                  action-code→ollama:qwen2.5-coder). Requires a running
                                  Ollama daemon with those models pulled. Cloud
                                  candidates remain in the chain as fallback.
                                  Override the daemon URL with OLLAMA_HOST in env.

Flags (both ask and agents):
  --serious                       enable extended reasoning (thinkingLevel=high)
  --thinking=minimal|low|medium|high
                                  finer-grained control over extended reasoning
  --search                        enable Google Search grounding (free tier: 5000/mo)
                                  appends a Sources block with cited URLs

Flags for 'ask' (tools — local file access is ON by default):
  --no-tools                      disable file tools for this call (pure-LLM, no fs access)
  --tools                         enable file tools (read_file, write_file, list_dir) — default
  --allow-bash                    additionally enable the bash tool (cmd.exe on Windows, /bin/sh elsewhere)
                                  no sandbox — runs anything you can run.
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

  if (command === "chat") {
    const { values: cv, positionals: cp } = parseArgs({
      args: argv.slice(1),
      options: {
        powerful: { type: "boolean", default: false },
        local: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const sessionId = cp[0];
    if (!sessionId) {
      console.error("Error: chat requires a session name. Example: npm run cli -- chat my-session");
      printHelp();
      process.exit(2);
    }
    await cmdChat(sessionId, Boolean(cv.powerful), Boolean(cv.local));
    return;
  }

  if (command === "sessions") {
    cmdSessions();
    return;
  }

  if (command === "serve") {
    const { values: sv } = parseArgs({
      args: argv.slice(1),
      options: {
        port: { type: "string", default: "7421" },
        local: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    const port = Number(sv.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      console.error(`Error: --port must be a valid port number (got: ${sv.port})`);
      process.exit(2);
    }
    await cmdServe(port, Boolean(sv.local));
    return;
  }

  if (command === "task") {
    const { values: tv, positionals: tp } = parseArgs({
      args: argv.slice(1),
      options: {
        trace: { type: "boolean", default: false },
        serious: { type: "boolean", default: false },
        thinking: { type: "string" },
        local: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const taskPrompt = tp.join(" ").trim();
    if (!taskPrompt) {
      console.error("Error: task requires a prompt argument.\n");
      printHelp();
      process.exit(2);
    }
    let thinking2: ThinkingLevel | undefined;
    if (tv.thinking !== undefined) {
      const t = tv.thinking as string;
      if (!(VALID_THINKING as string[]).includes(t)) {
        console.error(`Error: --thinking must be one of ${VALID_THINKING.join("|")} (got: ${t})`);
        process.exit(2);
      }
      thinking2 = t as ThinkingLevel;
    } else if (tv.serious) {
      thinking2 = "high";
    }
    const taskOpts: CompleteOptions = thinking2 !== undefined ? { thinking: thinking2 } : {};
    await cmdTask(taskPrompt, Boolean(tv.trace), taskOpts, Boolean(tv.local));
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
      // Local file access is ON by default for `ask` / `agents` / `task` —
      // the model can `read_file` / `write_file` / `list_dir` inside
      // `--workdir` (defaults to CWD). Use `--no-tools` to suppress.
      tools: { type: "boolean", default: true },
      "no-tools": { type: "boolean", default: false },
      "allow-bash": { type: "boolean", default: false },
      workdir: { type: "string" },
      role: { type: "string" },
      local: { type: "boolean", default: false },
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

  // --no-tools wins over the default-true --tools (explicit opt-out).
  const toolsEnabled = !values["no-tools"] && Boolean(values.tools);

  const localFlag = Boolean(values.local);
  if (command === "ask") {
    const roleArg = values.role as string | undefined;
    if (roleArg) {
      if (!(VALID_ROLES as string[]).includes(roleArg)) {
        console.error(`Error: --role must be one of ${VALID_ROLES.join("|")} (got: ${roleArg})`);
        process.exit(2);
      }
      await cmdAskRole(prompt, roleArg as RoleName, completeOpts, localFlag);
    } else if (toolsEnabled || values["allow-bash"]) {
      const workdir = (values.workdir as string | undefined) ?? process.cwd();
      await cmdAskWithTools(
        prompt,
        workdir,
        Boolean(values.trace),
        Boolean(values["allow-bash"]),
        completeOpts,
        localFlag,
      );
    } else {
      await cmdAsk(prompt, completeOpts, localFlag);
    }
    return;
  }

  if (command === "agents") {
    const mode = values.mode as string;
    if (mode !== "parallel" && mode !== "specialist") {
      console.error(`Error: --mode must be 'parallel' or 'specialist' (got: ${mode})`);
      process.exit(2);
    }
    await cmdAgents(prompt, mode, Boolean(values.trace), completeOpts, localFlag);
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
