import type { Router } from "../router.js";
import type { CompleteOptions } from "../provider.js";
import { Agent } from "./agent.js";
import { CONTROLLER_PRIMING, buildRoutingPrompt, buildSynthesisPrompt } from "./prompts.js";

export type ControllerMode = "specialist" | "parallel";

export interface ControllerOptions {
  router: Router;
  subAgents: Agent[];
  mode: ControllerMode;
  /** Override the routing-decision prompt's system text. Mostly for tests. */
  controllerSystemPrompt?: string;
}

export interface RunTrace {
  mode: ControllerMode;
  pickedAgentId?: string;
  perAgent?: { id: string; output: string }[];
  finalOutput: string;
}

/**
 * The orchestrator. Two modes behind a runtime flag, per the build spec:
 *
 *  - specialist: controller picks ONE sub-agent for the task.
 *  - parallel:   all sub-agents do the task, controller synthesizes.
 *
 * Same call signature either way, so callers don't need to care.
 */
export class Controller {
  private readonly router: Router;
  private readonly subAgents: Agent[];
  private readonly subAgentsById: Map<string, Agent>;
  private readonly mode: ControllerMode;
  private readonly controllerSystem: string;

  constructor(opts: ControllerOptions) {
    if (opts.subAgents.length === 0) throw new Error("Controller requires at least one sub-agent");
    this.router = opts.router;
    this.subAgents = opts.subAgents;
    this.subAgentsById = new Map(opts.subAgents.map((a) => [a.id, a]));
    this.mode = opts.mode;
    this.controllerSystem = opts.controllerSystemPrompt ?? CONTROLLER_PRIMING;
  }

  async run(task: string, opts?: CompleteOptions): Promise<string> {
    return (await this.runWithTrace(task, opts)).finalOutput;
  }

  async runWithTrace(task: string, opts?: CompleteOptions): Promise<RunTrace> {
    if (this.mode === "specialist") return this.runSpecialist(task, opts);
    return this.runParallel(task, opts);
  }

  private async runSpecialist(task: string, opts?: CompleteOptions): Promise<RunTrace> {
    const roster = this.subAgents.map((a) => ({ id: a.id, role: a.role }));
    const routingPrompt = buildRoutingPrompt(task, roster);
    const decision = (await this.router.complete(routingPrompt, opts))
      .trim()
      .split(/\s|\n/)[0] ?? "";
    const picked = this.subAgentsById.get(decision);

    if (!picked) {
      // Controller couldn't / wouldn't pick. Fall back to first agent rather than erroring;
      // failure modes here are a tuning concern once real keys are in play.
      const fallback = this.subAgents[0]!;
      const output = await fallback.run(task, opts);
      return { mode: "specialist", pickedAgentId: fallback.id, finalOutput: output };
    }

    const output = await picked.run(task, opts);
    return { mode: "specialist", pickedAgentId: picked.id, finalOutput: output };
  }

  private async runParallel(task: string, opts?: CompleteOptions): Promise<RunTrace> {
    const settled = await Promise.allSettled(this.subAgents.map((a) => a.run(task, opts)));
    const perAgent: { id: string; output: string }[] = [];

    settled.forEach((res, i) => {
      const agent = this.subAgents[i]!;
      if (res.status === "fulfilled") {
        perAgent.push({ id: agent.id, output: res.value });
      } else {
        perAgent.push({ id: agent.id, output: `[error: ${String(res.reason)}]` });
      }
    });

    if (perAgent.length === 1) {
      // Synthesis adds no value with a single agent; pass through.
      return { mode: "parallel", perAgent, finalOutput: perAgent[0]!.output };
    }

    const synthesisPrompt = buildSynthesisPrompt(
      task,
      perAgent.map((p) => ({ id: p.id, text: p.output })),
    );
    const final = await this.router.complete(synthesisPrompt, opts);
    return { mode: "parallel", perAgent, finalOutput: final };
  }
}
