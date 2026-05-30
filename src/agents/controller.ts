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
  /**
   * Stagger parallel-mode sub-agent dispatches by N ms (with jitter) instead
   * of firing all at the same wall-clock millisecond. Spreads load across
   * the per-minute RPM/TPM window. Default 300. 0 disables (fully parallel).
   */
  dispatchStaggerMs?: number;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests. */
  jitterMs?: () => number;
  /** Optional progress hook for CLI/UI callers that need visible liveness. */
  onProgress?: (event: ControllerProgressEvent) => void;
}

export interface RunTrace {
  mode: ControllerMode;
  pickedAgentId?: string;
  perAgent?: { id: string; output: string }[];
  finalOutput: string;
}

export type ControllerProgressEvent =
  | { type: "agent-start"; agentId: string }
  | { type: "agent-end"; agentId: string; ok: boolean; error?: string }
  | { type: "synthesis-start" }
  | { type: "synthesis-end"; ok: boolean };

/**
 * The orchestrator. Two modes behind a runtime flag, per the build spec:
 *
 *  - specialist: controller picks ONE sub-agent for the task.
 *  - parallel:   all sub-agents do the task, controller synthesizes.
 *
 * Same call signature either way, so callers don't need to care.
 */
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_JITTER = () => Math.floor(Math.random() * 200); // 0–199 ms

export class Controller {
  private readonly router: Router;
  private readonly subAgents: Agent[];
  private readonly subAgentsById: Map<string, Agent>;
  private readonly mode: ControllerMode;
  private readonly controllerSystem: string;
  private readonly dispatchStaggerMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly onProgress: (event: ControllerProgressEvent) => void;

  constructor(opts: ControllerOptions) {
    if (opts.subAgents.length === 0) throw new Error("Controller requires at least one sub-agent");
    this.router = opts.router;
    this.subAgents = opts.subAgents;
    this.subAgentsById = new Map(opts.subAgents.map((a) => [a.id, a]));
    this.mode = opts.mode;
    this.controllerSystem = opts.controllerSystemPrompt ?? CONTROLLER_PRIMING;
    this.dispatchStaggerMs = opts.dispatchStaggerMs ?? 300;
    this.sleep = opts.sleep ?? DEFAULT_SLEEP;
    this.jitter = opts.jitterMs ?? DEFAULT_JITTER;
    this.onProgress = opts.onProgress ?? (() => {});
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
    // Stagger dispatches so 3 agents don't all hit the per-minute RPM/TPM
    // window in the same wall-clock millisecond. They still run concurrently —
    // just not perfectly synchronously.
    const dispatched = this.subAgents.map(async (agent, i) => {
      if (i > 0 && this.dispatchStaggerMs > 0) {
        await this.sleep(i * this.dispatchStaggerMs + this.jitter());
      }
      this.onProgress({ type: "agent-start", agentId: agent.id });
      try {
        const output = await agent.run(task, opts);
        this.onProgress({ type: "agent-end", agentId: agent.id, ok: true });
        return output;
      } catch (err) {
        this.onProgress({ type: "agent-end", agentId: agent.id, ok: false, error: String(err) });
        throw err;
      }
    });
    const settled = await Promise.allSettled(dispatched);
    const perAgent: { id: string; output: string }[] = [];

    settled.forEach((res, i) => {
      const agent = this.subAgents[i]!;
      if (res.status === "fulfilled") {
        perAgent.push({ id: agent.id, output: res.value });
      } else {
        perAgent.push({ id: agent.id, output: `[error: ${String(res.reason)}]` });
      }
    });

    if (perAgent.every((p) => p.output.startsWith("[error:"))) {
      throw new Error(
        [
          "All parallel agents failed before synthesis:",
          ...perAgent.map((p) => `- ${p.id}: ${p.output}`),
        ].join("\n"),
      );
    }

    if (perAgent.length === 1) {
      // Synthesis adds no value with a single agent; pass through.
      return { mode: "parallel", perAgent, finalOutput: perAgent[0]!.output };
    }

    const synthesisPrompt = buildSynthesisPrompt(
      task,
      perAgent.map((p) => ({ id: p.id, text: p.output })),
    );
    this.onProgress({ type: "synthesis-start" });
    try {
      const final = await this.router.complete(synthesisPrompt, opts);
      this.onProgress({ type: "synthesis-end", ok: true });
      return { mode: "parallel", perAgent, finalOutput: final };
    } catch (err) {
      this.onProgress({ type: "synthesis-end", ok: false });
      throw err;
    }
  }
}
