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
  addProject,
  assertWithinAllowList,
  getActiveProject,
  listProjects,
  removeProject,
  resolveAllowList,
  setActiveProject,
  setPinnedFile,
  type Project,
} from "./project/store.js";
import {
  Router,
  Agent,
  Controller,
  loadAllProvidersFromEnv,
  loadAllProviderConfigsFromEnv,
  formatUsageReport,
  attachConservationPolicy,
  FileStateStore,
  InMemoryStateStore,
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
  buildWebRoles,
  loadOllamaProviders,
  getEnvLoadReport,
  type ControllerMode,
  type CompleteOptions,
  type ThinkingLevel,
  type RoleName,
  type RoleEvent,
  type RoutingMode,
} from "./index.js";
import { listOpenRouterFreeTextModels } from "./models/openrouter-models.js";
import { listModelsForProvider } from "./models/provider-models.js";
import {
  DEFAULT_OPENROUTER_REASONING_MODEL,
  readReasoningModelOverride,
  resetReasoningModelOverride,
  writeReasoningModelOverride,
  readAllRoleModelOverrides,
  readRoleModelOverride,
  writeRoleModelOverride,
  clearRoleModelOverride,
  CUSTOMISABLE_ROLES,
  OVERRIDE_PROVIDER_NAMES,
  type CustomisableRole,
  type OverrideProviderName,
} from "./models/reasoning-model-overrides.js";
import { apiKeyForOverrideProvider, isOverrideProviderConfigured } from "./config.js";

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
  "mindmap-categorize",
];

const VALID_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function buildRouter(opts?: { local?: boolean; persistentState?: boolean; maxRetryWaitMs?: number }): Router {
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
    printEnvDoctor();
    process.exit(1);
  }
  const stateStore =
    opts?.persistentState === false ? new InMemoryStateStore() : new FileStateStore();
  const router = new Router(configs, {
    stateStore,
    ...(opts?.maxRetryWaitMs !== undefined && { maxRetryWaitMs: opts.maxRetryWaitMs }),
  });
  // ConservationPolicy auto-ticks after every successful call. With
  // ProviderConfig budgets now wired, this drives the sidebar's quota
  // gauges and the round-robin → serial mode flip in real time.
  attachConservationPolicy(router);
  return router;
}

/** Roles registry for the run — local-aware when --local is set.
 * Always routes through buildDefaultRoles so the mindmap-categorize
 * cloud/reserved prepend applies in both modes, not just local. */
function rolesFor(local: boolean, toolCapable = false) {
  return buildDefaultRoles({ local, toolCapable });
}

function printEnvDoctor(): void {
  const report = getEnvLoadReport();
  const providers = loadAllProviderConfigsFromEnv().map((c) => c.provider.id);
  console.error("\n--- env doctor ---");
  console.error(`cwd: ${report.cwd}`);
  console.error(`moduleDir: ${report.moduleDir}`);
  if (report.files.length === 0) {
    console.error("env files found: none");
  } else {
    console.error("env files found:");
    for (const file of report.files) {
      console.error(`  - ${file.path}`);
      console.error(`    parsed keys: ${file.parsedKeys.length ? file.parsedKeys.join(", ") : "(none)"}`);
      console.error(`    filled blank env vars: ${file.appliedBlankKeys.length ? file.appliedBlankKeys.join(", ") : "(none)"}`);
      if (file.error) console.error(`    parse error: ${file.error}`);
    }
  }
  console.error(`registered providers: ${providers.length ? providers.join(", ") : "(none)"}`);
  console.error("--- end env doctor ---\n");
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
  console.error(
    mode === "parallel"
      ? `agents: running ${subs.length} agents in parallel, then synthesizing...`
      : "agents: choosing one specialist...",
  );
  const controller = new Controller({
    router,
    subAgents: subs,
    mode,
    onProgress: (event) => {
      switch (event.type) {
        case "agent-start":
          console.error(`agents: ${event.agentId} started`);
          break;
        case "agent-end":
          console.error(
            `agents: ${event.agentId} ${event.ok ? "done" : `failed (${event.error ?? "unknown error"})`}`,
          );
          break;
        case "synthesis-start":
          console.error("agents: synthesizing...");
          break;
        case "synthesis-end":
          console.error(`agents: synthesis ${event.ok ? "done" : "failed"}`);
          break;
      }
    },
  });
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

function cmdUsage(local: boolean): void {
  const router = buildRouter({ local });
  console.log(formatUsageReport(router));
}

function truncateOneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function routeMap(label: string, local: boolean): void {
  const router = buildRouter({ local, persistentState: false });
  const resolver = new RoleResolver(router, rolesFor(local));
  const snap = router.snapshot();
  const byId = new Map(snap.map((p) => [p.id, p]));
  const registeredIds = new Set(router.registeredProviderIds());
  const now = Date.now();

  console.log(`\n--- ${label} route map ---`);
  console.log(`registered providers: ${router.registeredProviderIds().join(", ")}`);
  for (const role of resolver.listRoles()) {
    const primary = role.candidates[0]?.providerId ?? "(none)";
    const registered = role.candidates.filter((c) => registeredIds.has(c.providerId));
    const ready = registered.find((c) => (byId.get(c.providerId)?.cooldownUntil ?? 0) <= now);
    const selected = ready?.providerId ?? registered[0]?.providerId ?? "(unavailable)";
    const selectedModel = byId.get(selected)?.model;
    let status = "primary";
    if (selected === "(unavailable)") status = "unavailable";
    else if (selected !== primary) status = "fallback-ready";
    else if (!ready && registered.length > 0) status = "primary-cooling";
    console.log(
      `${role.name.padEnd(19)} primary=${primary.padEnd(28)} selected=${selected.padEnd(28)}${selectedModel ? ` model=${selectedModel}` : ""} status=${status}`,
    );
  }
}

const MODELS_USAGE = [
  "usage:",
  "  models list                          show every role's provider + model override",
  "  models providers                     list selectable providers (and which are configured)",
  "  models models <provider> [--refresh] list a provider's available models",
  "  models set <role> <provider> <model> point a role at a provider + model",
  "  models clear <role>                  revert a role to its default chain",
  "  models reasoning <get|list|refresh|set|reset>   (back-compat, OpenRouter-only)",
  `roles: ${CUSTOMISABLE_ROLES.join(", ")}`,
  `providers: ${OVERRIDE_PROVIDER_NAMES.join(", ")}`,
].join("\n");

function isCustomisableRoleArg(value: string): value is CustomisableRole {
  return (CUSTOMISABLE_ROLES as readonly string[]).includes(value);
}

function isOverrideProviderArg(value: string): value is OverrideProviderName {
  return (OVERRIDE_PROVIDER_NAMES as readonly string[]).includes(value);
}

async function cmdModels(subArgs: string[]): Promise<void> {
  const sub = subArgs[0] ?? "list";

  if (sub === "list") {
    const overrides = readAllRoleModelOverrides();
    console.log("Per-role model routing:");
    for (const role of CUSTOMISABLE_ROLES) {
      const sel = overrides[role];
      const primary = DEFAULT_ROLES.find((r) => r.name === role)?.candidates[0]?.providerId ?? "?";
      if (sel) {
        console.log(`  ${role.padEnd(18)} → ${sel.provider}:${sel.model}`);
      } else {
        console.log(`  ${role.padEnd(18)} → (default: ${primary})`);
      }
    }
    return;
  }

  if (sub === "providers") {
    console.log("Selectable providers:");
    for (const provider of OVERRIDE_PROVIDER_NAMES) {
      const configured = isOverrideProviderConfigured(provider);
      console.log(`  ${provider.padEnd(11)} ${configured ? "configured" : "(no key)"}`);
    }
    return;
  }

  if (sub === "models") {
    const provider = subArgs[1] ?? "";
    if (!isOverrideProviderArg(provider)) {
      console.error(`unknown provider: ${provider || "(none)"}`);
      console.error(MODELS_USAGE);
      process.exit(2);
    }
    const refresh = subArgs.includes("--refresh");
    try {
      const result = await listModelsForProvider(provider, {
        apiKey: apiKeyForOverrideProvider(provider) ?? undefined,
        refresh,
      });
      console.log(
        `${provider} models (${result.source}${result.stale ? ", stale cache" : ""}): ${result.models.length}`,
      );
      for (const m of result.models) {
        const ctx = m.contextLength ? ` ctx=${m.contextLength}` : "";
        const reasoning = m.reasoningCapable ? " reasoning" : "";
        console.log(`  ${m.id}${reasoning}${ctx}`);
      }
    } catch (err) {
      console.error(`Error listing ${provider} models: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "set") {
    const [, role, provider, model] = subArgs;
    if (!role || !isCustomisableRoleArg(role)) {
      console.error(`unknown or non-customisable role: ${role || "(none)"}`);
      console.error(MODELS_USAGE);
      process.exit(2);
    }
    if (!provider || !isOverrideProviderArg(provider)) {
      console.error(`unknown provider: ${provider || "(none)"}`);
      console.error(MODELS_USAGE);
      process.exit(2);
    }
    if (!model) {
      console.error("usage: models set <role> <provider> <model>");
      process.exit(2);
    }
    if (!isOverrideProviderConfigured(provider)) {
      console.error(`Error: provider '${provider}' is not configured (missing API key).`);
      process.exit(1);
    }
    try {
      const result = await listModelsForProvider(provider, {
        apiKey: apiKeyForOverrideProvider(provider) ?? undefined,
      });
      const option = result.models.find((m) => m.id === model);
      if (!option) {
        console.error(`Error: '${model}' is not in ${provider}'s current model list.`);
        console.error(`Run \`models models ${provider} --refresh\` to update the list.`);
        process.exit(1);
      }
      const saved = writeRoleModelOverride(role, {
        provider,
        model: option.id,
        ...(option.name ? { name: option.name } : {}),
        ...(option.contextLength !== undefined ? { contextLength: option.contextLength } : {}),
        ...(option.reasoningCapable !== undefined ? { reasoningCapable: option.reasoningCapable } : {}),
      });
      console.log(`${role} set to ${saved.provider}:${saved.model}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "clear") {
    const role = subArgs[1] ?? "";
    if (!isCustomisableRoleArg(role)) {
      console.error(`unknown or non-customisable role: ${role || "(none)"}`);
      console.error(MODELS_USAGE);
      process.exit(2);
    }
    clearRoleModelOverride(role);
    const primary = DEFAULT_ROLES.find((r) => r.name === role)?.candidates[0]?.providerId ?? "?";
    console.log(`${role} reverted to its default chain (primary: ${primary})`);
    return;
  }

  // ── back-compat: `models reasoning <get|list|refresh|set|reset>` ────────────
  if (sub === "reasoning") {
    await cmdModelsReasoningLegacy(subArgs.slice(1));
    return;
  }

  console.error(`unknown models command: ${sub}`);
  console.error(MODELS_USAGE);
  process.exit(2);
}

/** Legacy OpenRouter-only reasoning subcommand, kept for back-compat. */
async function cmdModelsReasoningLegacy(args: string[]): Promise<void> {
  const action = args[0] ?? "get";
  if (action === "get") {
    const current = readReasoningModelOverride();
    console.log(`reasoning OpenRouter model: ${current.model}${current.isDefault ? " (default)" : ""}`);
    return;
  }

  if (action === "reset") {
    const current = resetReasoningModelOverride();
    console.log(`reasoning OpenRouter model reset to ${current.model}`);
    return;
  }

  if (action === "list" || action === "refresh") {
    const result = await listOpenRouterFreeTextModels({
      apiKey: (process.env.OPENROUTER_KEY ?? "").trim() || undefined,
      refresh: action === "refresh",
    });
    const current = readReasoningModelOverride();
    console.log(
      `OpenRouter free text models (${result.source}${result.stale ? ", stale cache" : ""}):`,
    );
    for (const model of result.models) {
      const marker = model.id === current.model ? "*" : " ";
      const reasoning = model.reasoningCapable ? " reasoning" : "";
      const ctx = model.contextLength > 0 ? ` ctx=${model.contextLength}` : "";
      console.log(`${marker} ${model.id}${reasoning}${ctx} - ${model.name}`);
    }
    return;
  }

  if (action === "set") {
    const modelId = args[1];
    if (!modelId) {
      console.error("usage: models reasoning set <openrouter-free-model-id>");
      process.exit(2);
    }
    const result = await listOpenRouterFreeTextModels({
      apiKey: (process.env.OPENROUTER_KEY ?? "").trim() || undefined,
    });
    const option = result.models.find((m) => m.id === modelId);
    if (!option) {
      console.error(`Error: '${modelId}' is not in the current OpenRouter free text-model list.`);
      console.error("Run `models reasoning refresh` to update the list.");
      process.exit(1);
    }
    const current = writeReasoningModelOverride(undefined, {
      model: option.id,
      name: option.name,
      contextLength: option.contextLength,
      reasoningCapable: option.reasoningCapable,
    });
    const fallback = DEFAULT_OPENROUTER_REASONING_MODEL === current.model ? " (default)" : "";
    console.log(`reasoning OpenRouter model set to ${current.model}${fallback}`);
    return;
  }

  console.error(`unknown models reasoning action: ${action}`);
  console.error("usage: models reasoning <get|list|refresh|set|reset>");
  process.exit(2);
}

async function printOllamaHealth(): Promise<void> {
  const baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const required = loadOllamaProviders().map((p) => ({ id: p.id, model: p.model }));
  console.log("\n--- ollama health ---");
  console.log(`baseUrl: ${baseUrl}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`status: FAIL (${res.status})`);
      console.log(`required: ${required.map((r) => `${r.id}=${r.model}`).join(", ")}`);
      return;
    }
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const installed = (json.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
    const missing = required.filter((r) => !installed.some((m) => m === r.model || m.startsWith(`${r.model}-`)));
    console.log(`status: ${missing.length === 0 ? "PASS" : "FAIL"}`);
    console.log(`required: ${required.map((r) => `${r.id}=${r.model}`).join(", ")}`);
    console.log(`installed: ${installed.join(", ") || "(none)"}`);
    console.log(`missing: ${missing.map((m) => `${m.id}=${m.model}`).join(", ") || "(none)"}`);
  } catch (err) {
    console.log(`status: FAIL (${(err as Error).message})`);
    console.log(`required: ${required.map((r) => `${r.id}=${r.model}`).join(", ")}`);
  }
}

async function printCerebrasHealth(): Promise<void> {
  const key = (process.env.CEREBRAS_KEY ?? "").trim();
  console.log("\n--- cerebras health ---");
  if (!key) {
    console.log("status: SKIP (CEREBRAS_KEY unset)");
    return;
  }
  try {
    const res = await fetch("https://api.cerebras.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`status: FAIL (${res.status})`);
      console.log(truncateOneLine(text));
      return;
    }
    const json = JSON.parse(text) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
    const hasDefault = models.includes("gpt-oss-120b");
    console.log(`status: ${hasDefault ? "PASS" : "WARN"}`);
    console.log(`models: ${models.join(", ") || "(none)"}`);
    if (!hasDefault) console.log("warning: expected gpt-oss-120b is not in the model list");
  } catch (err) {
    console.log(`status: FAIL (${(err as Error).message})`);
  }
}

function diagnosticPrompt(role: RoleName): string {
  if (role === "action-code") {
    return "Routing diagnostic. Return one JavaScript statement: console.log(\"OK\");";
  }
  if (role === "mindmap-categorize") {
    return 'Routing diagnostic. Return exactly this JSON: {"title":"OK","nodes":[]}';
  }
  return "Routing diagnostic. Reply with exactly: OK";
}

async function liveProbeMode(label: string, local: boolean): Promise<void> {
  console.log(`\n--- ${label} live role probes ---`);
  const router = buildRouter({ local });
  const events: RoleEvent[] = [];
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: (e) => events.push(e) });
  for (const role of VALID_ROLES) {
    const primary = resolver.resolveCandidate(role)?.providerId ?? "(unavailable)";
    const before = events.length;
    const started = Date.now();
    try {
      const reply = await resolver.runRole(role, diagnosticPrompt(role), {
        maxTokens: role === "reasoning" ? 256 : 128,
        temperature: 0,
      });
      const roleEvents = events.slice(before).filter((e) => e.role === role);
      const fallback = roleEvents.find(
        (e) => e.type === "fallback-within-role" || e.type === "cross-role-substitution",
      );
      const servedBy = fallback && "usedProviderId" in fallback ? fallback.usedProviderId : primary;
      const status = fallback ? "WARN fallback" : "PASS";
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `${status.padEnd(13)} ${role.padEnd(19)} primary=${primary.padEnd(28)} served=${servedBy.padEnd(28)} ${elapsed}s reply=${JSON.stringify(truncateOneLine(reply, 90))}`,
      );
    } catch (err) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `FAIL          ${role.padEnd(19)} primary=${primary.padEnd(28)} ${elapsed}s error=${truncateOneLine((err as Error).message, 160)}`,
      );
    }
  }
  console.log(`\n${formatUsageReport(router)}`);
}

async function cmdDiagnoseRouting(live: boolean): Promise<void> {
  const report = getEnvLoadReport();
  console.log("--- routing diagnostic ---");
  console.log(`cwd: ${report.cwd}`);
  console.log(`moduleDir: ${report.moduleDir}`);
  console.log(`env files: ${report.files.map((f) => f.path).join(", ") || "(none)"}`);
  routeMap("cloud", false);
  routeMap("hybrid-local", true);
  await printOllamaHealth();
  await printCerebrasHealth();
  if (!live) {
    console.log("\nLive probes skipped. Run `npm run cli -- diagnose-routing --live` to call every role.");
    return;
  }
  await liveProbeMode("cloud", false);
  await liveProbeMode("hybrid-local", true);
}

async function cmdChat(
  sessionId: string,
  powerful: boolean,
  startLocal: boolean,
  mode: RoutingMode,
  tools: ReturnType<FileTools["toolset"]>,
  workdir: string,
): Promise<void> {
  // Always register Ollama providers at startup so the /local toggle can
  // switch to hybrid mode at any point during the session without a restart.
  const router = buildRouter({ local: true });
  // When tools are active, reorder action-code to lead with function-calling
  // models (Codestral can't call tools and returns empty otherwise).
  const toolCapable = tools.length > 0;
  const cloudResolver = new RoleResolver(router, rolesFor(false, toolCapable), { onEvent: printRoleEvent });
  const localResolver = new RoleResolver(router, rolesFor(true, toolCapable), { onEvent: printRoleEvent });
  if (tools.length > 0) {
    const toolNames = tools.map((t) => t.name).join(", ");
    console.error(`tools enabled (${toolNames}). workdir: ${workdir}`);
    console.error(`(tool sessions route each turn directly through action-code's tool loop — ` +
      `the multi-agent/auto/brainstorming modes are bypassed so the model executes instead of describing)\n`);
  }
  if (startLocal) {
    console.error(`hybrid local mode ON — reasoning → ollama:qwen3.5-9b, action-code → ollama:qwen2.5-coder\n`);
  }
  const session = new ChatSession({
    resolver: cloudResolver,
    localResolver,
    useLocal: startLocal,
    id: sessionId,
    powerful,
    tools,
  });
  const repl = new ChatRepl({ session, router, mode });
  await repl.run();
}

async function cmdServe(
  port: number,
  local: boolean,
  projectRoot?: string,
  host = "127.0.0.1",
  chatOnly = false,
  shareChatPort?: number,
): Promise<void> {
  // Always register Ollama providers at boot so the web UI's per-request
  // `useLocal` toggle has something to route to. If the local daemon
  // isn't running, calls just fail with a fetch error — same shape as
  // any cloud provider with a bad key.
  // Browser turns already expose an explicit retry/countdown UI. Do not hold
  // an interactive request for up to 90 seconds retrying one isolated
  // candidate before trying the next healthy provider.
  const router = buildRouter({ local: true, maxRetryWaitMs: 0 });
  const resolver = new RoleResolver(router, buildWebRoles(local), { onEvent: printRoleEvent });
  // Alternate-mode resolver: when CLI booted with --local, this is the
  // cloud-only resolver; without --local, this is the local-prepend
  // resolver. Either way, the web UI can ask for the other mode per
  // request via `useLocal` in the body.
  const localResolver = local
    ? resolver
    : new RoleResolver(router, buildWebRoles(true), { onEvent: printRoleEvent });
  const cloudResolver = local
    ? new RoleResolver(router, buildWebRoles(false), { onEvent: printRoleEvent })
    : resolver;
  const { url } = startWebServer({
    router,
    resolver,
    localResolver,
    cloudResolver,
    defaultUseLocal: local,
    chatOnly,
    host,
    port,
    projectRoot,
  });
  console.log(`multi-agent web UI live at ${url}`);
  if (chatOnly) {
    console.log("chat-only mode: local files/tools/settings are blocked; sessions are memory-only");
  }
  if (shareChatPort !== undefined) {
    const { url: shareUrl } = startWebServer({
      router,
      resolver,
      localResolver,
      cloudResolver,
      defaultUseLocal: local,
      chatOnly: true,
      host: "127.0.0.1",
      port: shareChatPort,
      projectRoot,
    });
    console.log(`chat-only share target live at ${shareUrl}`);
    console.log(`proxy port ${shareChatPort} with Tailscale; keep port ${port} for this PC only`);
  }
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

async function cmdTask(
  prompt: string,
  trace: boolean,
  opts: CompleteOptions,
  local: boolean,
  mode: RoutingMode,
): Promise<void> {
  const router = buildRouter({ local });
  const resolver = new RoleResolver(router, rolesFor(local), { onEvent: printRoleEvent });
  const unsat = resolver.unsatisfiedRoles();
  if (unsat.length > 0) {
    console.error(
      `Note: ${unsat.length} role(s) have no registered primary candidate; falling back to Gemini:\n  ${unsat.join(", ")}`,
    );
  }
  const orchestrator = new RoleOrchestrator({ resolver });
  const result = await orchestrator.runWithTrace(prompt, opts, mode);

  if (trace) {
    console.error(`--- mode: ${mode} ---`);
    console.error(`--- plan: ${mode === "multi-agent" ? "multi-agent" : result.plan.kind} ---`);
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

function parseRoutingMode(value: unknown): RoutingMode {
  if (value === undefined || value === null || value === "multi-agent") return "multi-agent";
  if (value === "smart" || value === "auto") return "auto";
  if (value === "round-robin" || value === "brainstorming") return "brainstorming";
  console.error(
    `Error: --mode must be one of auto|multi-agent|brainstorming (got: ${String(value)})`,
  );
  process.exit(2);
}

function printHelp(): void {
  console.log(`multi-agent CLI

Commands:
  ask <prompt>             single completion through the router
  agents <prompt>          orchestrate fixed sub-agents (parallel/specialist modes)
  task <prompt>            multi-agent workflow (default) or another routing mode
  chat <session-name>      interactive multi-turn REPL with persistent history
                           (multi-agent mode by default)
  sessions                 list saved chat session names
  serve                    start the local web UI on http://127.0.0.1:<port>
                           (default 7421). Also exposed as: npm run web
  usage                    print router state (counts, cooldowns, % remaining)
  doctor                   print env/provider diagnostics without secret values
  diagnose-routing         print route maps, local/cloud health, and optional
                           live probes for every role
  project [subcommand]     manage projects (root folders). Subcommands:
    list                   list all projects (* = active)
    current                show active project details
    add <name> <path>      register a new project
    use <name|id>          switch the active project
    remove <name|id>       remove a project (last project cannot be removed)
    pin <rel-path>         pin a file in the active project (root-relative)
    unpin                  clear the pinned file
  models reasoning <cmd>   inspect or change the reasoning role's primary
                           OpenRouter free text model. Commands:
    get                    show selected reasoning model
    list                   show cached/live free text models
    refresh                refresh model list from OpenRouter
    set <model-id>         select a free OpenRouter text model
    reset                  restore Qwen3-Next default

Flags for 'task':
  --mode=auto|multi-agent|brainstorming
                                  default: multi-agent. auto lets the orchestrator
                                  choose a short route; brainstorming gathers
                                  multiple model perspectives in parallel.
  --serious                       extended reasoning across all calls in the run
  --thinking=minimal|low|medium|high
  --trace                         print the plan + per-role outputs before synthesis

Flags for 'chat':
  --mode=auto|multi-agent|brainstorming
                                  default: multi-agent
  --powerful                      start in powerful mode (Gemini thinking=high
                                  on every call this session). Also toggleable
                                  mid-session via /power.
  --allow-bash                    enable file tools (read_file, write_file,
                                  list_dir) plus bash_exec for this session.
                                  The model can read/write files and run shell
                                  commands inside --workdir.
  --workdir=<path>                scope file tools to this directory (default:
                                  active project root). Implies --allow-bash's
                                  file tools without bash exec.
  --no-tools                      disable all tools even when --allow-bash or
                                  --workdir are present.
  --local                         start in hybrid local mode (Ollama models for
                                  reasoning + action-code). Toggle at any point
                                  mid-session with /local.

Flags for 'diagnose-routing':
  --live                          actually call every role in cloud and hybrid mode.
                                  Omit for a cheap config-only diagnostic.

Flags for 'serve':
  --host=<address>                interface to bind (default 127.0.0.1). Keep the
                                  default when proxying privately with Tailscale Serve.
  --port=<n>                      port to bind (default 7421)
  --chat-only                     expose chat only: block projects, files, tools,
                                  artifacts, goals, saved sessions, and settings;
                                  keep conversation history in memory only
  --share-chat-port=<n>           also start a separate loopback-only, memory-only
                                  chat listener for Tailscale (for example 7422),
                                  while the main port keeps the full local UI
  --project=<name|id>             activate the named project before starting the server
                                  (sets it as the global active project)
  --local                         default the web UI into hybrid local-model mode
                                  (Qwen 3.5 9B for reasoning, Qwen 2.5 Coder 14B for
                                  action-code via Ollama at localhost:11434). The web
                                  UI can still toggle modes per request; this flag
                                  only sets the initial default.

Flag (any command — ask/agents/task/chat/serve):
  --local                         prepend the local Ollama providers to the role
                                  registry for this run (reasoning→ollama:qwen3.5-9b,
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
  --workdir=<path>                scope tools to this directory (default: active project root)
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

// ---------------------------------------------------------------------------
// project command helpers
// ---------------------------------------------------------------------------

function findProject(nameOrId: string, projects: Project[]): Project | undefined {
  return (
    projects.find((p) => p.id === nameOrId) ??
    projects.find((p) => p.name.toLowerCase() === nameOrId.toLowerCase())
  );
}

function printProjectList(storePath?: string): void {
  const projects = listProjects(storePath);
  const active = getActiveProject(storePath);
  for (const p of projects) {
    const marker = p.id === active.id ? "* " : "  ";
    const pin = p.pinnedFile ? ` [pinned: ${p.pinnedFile}]` : "";
    console.log(`${marker}${p.name} (${p.id}) — ${p.root}${pin}`);
  }
}

function cmdProject(subArgs: string[]): void {
  const sub = subArgs[0] ?? "list";
  switch (sub) {
    case "list":
      printProjectList();
      break;
    case "current": {
      const p = getActiveProject();
      const pin = p.pinnedFile ? `\npinned: ${p.pinnedFile}` : "";
      console.log(`${p.name} (${p.id})\nroot: ${p.root}${pin}`);
      break;
    }
    case "add": {
      const name = subArgs[1];
      const path = subArgs[2];
      if (!name || !path) {
        console.error("usage: project add <name> <path>");
        process.exit(2);
      }
      const absPath = resolvePath(path);
      try {
        const p = addProject({ name, root: absPath });
        console.log(`added project '${p.name}' (${p.id}) at ${p.root}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }
    case "use": {
      const nameOrId = subArgs[1];
      if (!nameOrId) {
        console.error("usage: project use <name|id>");
        process.exit(2);
      }
      const projects = listProjects();
      const found = findProject(nameOrId, projects);
      if (!found) {
        console.error(`Error: no project matching '${nameOrId}'`);
        process.exit(1);
      }
      setActiveProject(found.id);
      console.log(`active project → '${found.name}' (${found.root})`);
      break;
    }
    case "remove": {
      const nameOrId = subArgs[1];
      if (!nameOrId) {
        console.error("usage: project remove <name|id>");
        process.exit(2);
      }
      const projects = listProjects();
      const found = findProject(nameOrId, projects);
      if (!found) {
        console.error(`Error: no project matching '${nameOrId}'`);
        process.exit(1);
      }
      try {
        removeProject(found.id);
        console.log(`removed project '${found.name}'`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }
    case "pin": {
      const relPath = subArgs[1];
      if (!relPath) {
        console.error("usage: project pin <relative-path>");
        process.exit(2);
      }
      const active = getActiveProject();
      try {
        setPinnedFile(active.id, relPath);
        console.log(`pinned '${relPath}' for project '${active.name}'`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }
    case "unpin": {
      const active = getActiveProject();
      setPinnedFile(active.id, null);
      console.log(`unpinned file for project '${active.name}'`);
      break;
    }
    default:
      console.error(`unknown project subcommand: ${sub}`);
      console.error("valid subcommands: list, current, add, use, remove, pin, unpin");
      process.exit(2);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "project") {
    cmdProject(argv.slice(1));
    return;
  }

  if (command === "models") {
    await cmdModels(argv.slice(1));
    return;
  }

  if (command === "usage") {
    const { values: uv } = parseArgs({
      args: argv.slice(1),
      options: {
        local: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    cmdUsage(Boolean(uv.local));
    return;
  }

  if (command === "doctor") {
    printEnvDoctor();
    return;
  }

  if (command === "diagnose-routing") {
    const { values: dv } = parseArgs({
      args: argv.slice(1),
      options: {
        live: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    await cmdDiagnoseRouting(Boolean(dv.live));
    return;
  }

  if (command === "chat") {
    const { values: cv, positionals: cp } = parseArgs({
      args: argv.slice(1),
      options: {
        powerful: { type: "boolean", default: false },
        mode: { type: "string", default: "multi-agent" },
        local: { type: "boolean", default: false },
        "allow-bash": { type: "boolean", default: false },
        "no-tools": { type: "boolean", default: false },
        workdir: { type: "string" },
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
    const allowBash = Boolean(cv["allow-bash"]);
    const noTools = Boolean(cv["no-tools"]);
    const chatWorkdir = resolvePath((cv.workdir as string | undefined) ?? getActiveProject().root);
    const chatTools: ReturnType<FileTools["toolset"]> = [];
    // Tools are opt-in for chat (unlike `ask` which enables them by default).
    // --allow-bash enables read_file + write_file + list_dir + bash_exec.
    // --workdir alone enables the three file tools without bash.
    if (!noTools && (allowBash || cv.workdir !== undefined)) {
      const ft = new FileTools(chatWorkdir);
      chatTools.push(...ft.toolset());
      if (allowBash) chatTools.push(new BashTool({ workdir: ft.workdir }).asTool());
    }
    await cmdChat(sessionId, Boolean(cv.powerful), Boolean(cv.local), parseRoutingMode(cv.mode), chatTools, chatWorkdir);
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
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "7421" },
        local: { type: "boolean", default: false },
        "chat-only": { type: "boolean", default: false },
        "share-chat-port": { type: "string" },
        project: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
    const port = Number(sv.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      console.error(`Error: --port must be a valid port number (got: ${sv.port})`);
      process.exit(2);
    }
    const host = String(sv.host).trim();
    if (!host) {
      console.error("Error: --host must not be empty");
      process.exit(2);
    }
    const shareChatPort = sv["share-chat-port"] === undefined
      ? undefined
      : Number(sv["share-chat-port"]);
    if (shareChatPort !== undefined && (!Number.isFinite(shareChatPort) || shareChatPort < 1 || shareChatPort > 65535)) {
      console.error(`Error: --share-chat-port must be a valid port number (got: ${sv["share-chat-port"]})`);
      process.exit(2);
    }
    if (shareChatPort === port) {
      console.error("Error: --share-chat-port must differ from --port");
      process.exit(2);
    }
    if (shareChatPort !== undefined && Boolean(sv["chat-only"])) {
      console.error("Error: use either --chat-only or --share-chat-port, not both");
      process.exit(2);
    }
    if (shareChatPort !== undefined && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      console.error("Error: --share-chat-port requires the full UI to stay on a loopback --host");
      process.exit(2);
    }
    let serveRoot: string | undefined;
    if (sv.project) {
      const projects = listProjects();
      const found = findProject(sv.project as string, projects);
      if (!found) {
        console.error(`Error: no project matching '${sv.project}'`);
        process.exit(1);
      }
      setActiveProject(found.id);
      serveRoot = found.root;
    } else {
      serveRoot = getActiveProject().root;
    }
    await cmdServe(
      port,
      Boolean(sv.local),
      serveRoot,
      host,
      Boolean(sv["chat-only"]),
      shareChatPort,
    );
    return;
  }

  if (command === "task") {
    const { values: tv, positionals: tp } = parseArgs({
      args: argv.slice(1),
      options: {
        trace: { type: "boolean", default: false },
        serious: { type: "boolean", default: false },
        thinking: { type: "string" },
        mode: { type: "string", default: "multi-agent" },
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
    await cmdTask(
      taskPrompt,
      Boolean(tv.trace),
      taskOpts,
      Boolean(tv.local),
      parseRoutingMode(tv.mode),
    );
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
      const workdir = (values.workdir as string | undefined) ?? getActiveProject().root;
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
