import type { RoleResolver } from "../roles/resolver.js";
import type { RoleName } from "../roles/types.js";
import type { CompleteOptions } from "../provider.js";

export interface RoleOrchestratorOptions {
  resolver: RoleResolver;
  /** Parallel-dispatch stagger between sub-task launches. Default 200ms. */
  dispatchStaggerMs?: number;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the orchestrator decided to do for this task. */
export type Plan =
  | { kind: "direct"; answer: string }
  | { kind: "single"; role: RoleName; prompt: string }
  | { kind: "parallel"; tasks: { role: RoleName; prompt: string }[] };

export interface RoleRunTrace {
  plan: Plan;
  perRole?: { role: RoleName; output: string }[];
  finalOutput: string;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The capstone of Stage 6. Given a free-form user task:
 *   1. Asks the orchestration role to produce a structured Plan.
 *   2. Executes the Plan — directly, via one role, or via several roles in parallel.
 *   3. Synthesizes per-role outputs into a final answer when applicable.
 *
 * Plans are returned as JSON from the orchestrator. Defensive parsing falls
 * back to a single action-structural call when the orchestrator's output is
 * malformed — better degraded service than a thrown error.
 */
export class RoleOrchestrator {
  private readonly resolver: RoleResolver;
  private readonly dispatchStaggerMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RoleOrchestratorOptions) {
    this.resolver = opts.resolver;
    this.dispatchStaggerMs = opts.dispatchStaggerMs ?? 200;
    this.sleep = opts.sleep ?? DEFAULT_SLEEP;
  }

  async run(task: string, opts?: CompleteOptions): Promise<string> {
    return (await this.runWithTrace(task, opts)).finalOutput;
  }

  async runWithTrace(task: string, opts?: CompleteOptions): Promise<RoleRunTrace> {
    const plan = await this.makePlan(task, opts);

    if (plan.kind === "direct") {
      return { plan, finalOutput: plan.answer };
    }

    if (plan.kind === "single") {
      const out = await this.resolver.runRole(plan.role, plan.prompt, opts);
      return { plan, finalOutput: out };
    }

    // parallel
    const perRole: { role: RoleName; output: string }[] = [];
    const dispatched = plan.tasks.map(async (t, i) => {
      if (i > 0 && this.dispatchStaggerMs > 0) await this.sleep(i * this.dispatchStaggerMs);
      try {
        return { role: t.role, output: await this.resolver.runRole(t.role, t.prompt, opts) };
      } catch (err) {
        return { role: t.role, output: `[error: ${(err as Error).message}]` };
      }
    });
    const settled = await Promise.all(dispatched);
    perRole.push(...settled);

    // Single-role-in-parallel doesn't need synthesis.
    if (perRole.length === 1) {
      return { plan, perRole, finalOutput: perRole[0]!.output };
    }

    const final = await this.synthesize(task, perRole, opts);
    return { plan, perRole, finalOutput: final };
  }

  /** Plan-generation: ask orchestration role for a structured plan as JSON. */
  private async makePlan(task: string, opts?: CompleteOptions): Promise<Plan> {
    const roster = this.resolver.rosterDescription();
    const prompt = `${PLAN_PROMPT_HEADER}

Available roles:
${roster}

User task:
${task}

${PLAN_PROMPT_FOOTER}`;
    const raw = await this.resolver.runRole("orchestration", prompt, opts);
    return parsePlan(raw);
  }

  /** Synthesis: ask orchestration role to integrate per-role outputs into one answer. */
  private async synthesize(
    task: string,
    results: { role: RoleName; output: string }[],
    opts?: CompleteOptions,
  ): Promise<string> {
    const blocks = results.map((r) => `<<<${r.role}\n${r.output}\n>>>`).join("\n");
    const prompt = `The user asked:
${task}

Several roles worked on parts of it. Their outputs:

${blocks}

Integrate these into a single coherent answer for the user. No preamble, no per-role labels in the output. Match the granularity the user asked for.`;
    return this.resolver.runRole("orchestration", prompt, opts);
  }
}

const PLAN_PROMPT_HEADER = `You are the orchestrator. Decide how to handle a user task by producing a JSON plan.`;

const PLAN_PROMPT_FOOTER = `Output EXACTLY one JSON object. Pick the shape that fits:

1) Trivial task you can answer yourself (no role lookup needed):
{ "kind": "direct", "answer": "<your answer>" }

2) One role handles everything:
{ "kind": "single", "role": "<role-name>", "prompt": "<focused prompt for that role>" }

3) Multiple roles work in parallel, you'll synthesize:
{ "kind": "parallel", "tasks": [
  { "role": "<role-name>", "prompt": "<focused prompt>" },
  ...
] }

Rules:
- Use "direct" for greetings, definitions, trivial answers — anything you confidently know without lookup.
- Use "single" when one role clearly fits (e.g., code → action-code; web fact → perception).
- Use "parallel" when multiple roles each contribute different angles (e.g., perception for facts + reasoning for analysis).
- Each sub-prompt should be self-contained and focused on what that specific role contributes.
- Output ONLY the JSON. No markdown fences, no commentary.`;

/**
 * Defensive JSON parser for orchestrator plans. Strips common markdown
 * artifacts, falls back to action-structural-single when malformed.
 */
export function parsePlan(raw: string): Plan {
  const fallback: Plan = {
    kind: "single",
    role: "action-structural",
    prompt: raw, // pass the original task description (or whatever we got) downstream
  };

  // Strip ```json or ``` fences if the model wrapped the JSON.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const p = parsed as Record<string, unknown>;
  if (p.kind === "direct" && typeof p.answer === "string") {
    return { kind: "direct", answer: p.answer };
  }
  if (
    p.kind === "single" &&
    typeof p.role === "string" &&
    typeof p.prompt === "string" &&
    isValidRoleName(p.role)
  ) {
    return { kind: "single", role: p.role as RoleName, prompt: p.prompt };
  }
  if (p.kind === "parallel" && Array.isArray(p.tasks)) {
    const tasks: { role: RoleName; prompt: string }[] = [];
    for (const t of p.tasks) {
      const obj = t as Record<string, unknown>;
      if (
        typeof obj.role === "string" &&
        typeof obj.prompt === "string" &&
        isValidRoleName(obj.role)
      ) {
        tasks.push({ role: obj.role as RoleName, prompt: obj.prompt });
      }
    }
    if (tasks.length > 0) return { kind: "parallel", tasks };
  }
  return fallback;
}

const VALID_ROLE_NAMES = new Set<RoleName>([
  "perception",
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
  "mindmap-categorize",
]);

function isValidRoleName(s: string): s is RoleName {
  return VALID_ROLE_NAMES.has(s as RoleName);
}
