import { AllProvidersExhaustedError } from "../errors.js";
import type { GoalSession, GoalStep } from "./goal-session.js";
import { planNextStep, type PlannerResolver } from "./planner.js";
import type { RoleName } from "../roles/types.js";

export type GoalProgress =
  | { kind: "goal-step-start"; stepIndex: number; prompt: string }
  | { kind: "goal-token"; text: string }
  | { kind: "goal-step-done"; stepIndex: number; result: string }
  | { kind: "goal-plan"; nextPrompt: string; stepIndex: number }
  | { kind: "quota-wait"; resumeAt: number; waitMs: number; providers: { id: string; resumeAt: number }[] }
  | { kind: "goal-done"; summary: string; stepCount: number }
  | { kind: "goal-error"; error: string };

export interface GoalRunnerOpts {
  onProgress: (evt: GoalProgress) => void;
  signal?: AbortSignal;
  /** How long to wait (ms) when quota is exhausted. Default 60_000. */
  quotaWaitMs?: number | (() => number);
  /** Override for tests. Default: global setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Safety cap — abort the loop after this many steps. Default 50. */
  maxSteps?: number;
  /** Optional: supply provider snapshots for the quota-wait event UI. */
  getProviderSnapshots?: () => { id: string; resumeAt: number }[];
}

/** Minimal resolver shape the runner needs. */
export interface RunnerResolver extends PlannerResolver {
  runRole(name: RoleName, prompt: string): Promise<string>;
}

function resolveWaitMs(opt: number | (() => number) | undefined): number {
  if (typeof opt === "function") return opt();
  return opt ?? 60_000;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the autonomous goal loop:
 *  1. Ask the reasoning role what the next step is.
 *  2. Execute that step via the resolver.
 *  3. On quota exhaustion: emit quota-wait, sleep, retry.
 *  4. Repeat until planner says done or maxSteps is reached.
 *
 * The session object is mutated in-place so callers (e.g. GoalStore) can
 * persist it after each step.
 */
export async function runGoalLoop(
  session: GoalSession,
  resolver: RunnerResolver,
  opts: GoalRunnerOpts,
): Promise<void> {
  const { onProgress, signal } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const maxSteps = opts.maxSteps ?? 50;

  const emit = (evt: GoalProgress) => onProgress(evt);

  try {
    while (true) {
      if (signal?.aborted) {
        emit({ kind: "goal-error", error: "aborted" });
        return;
      }
      if (session.steps.length >= maxSteps) {
        emit({ kind: "goal-error", error: `reached max step limit (${maxSteps})` });
        return;
      }

      // ── Plan next step ───────────────────────────────────────────────────
      let plan: Awaited<ReturnType<typeof planNextStep>>;
      try {
        plan = await planNextStep(session.description, session.steps, resolver);
      } catch (err) {
        if (err instanceof AllProvidersExhaustedError) {
          await handleQuotaWait(err, session, emit, sleep, opts);
          continue; // retry planning
        }
        session.status = "failed";
        emit({ kind: "goal-error", error: (err as Error).message ?? String(err) });
        return;
      }

      if (plan.done) {
        session.status = "done";
        emit({ kind: "goal-done", summary: plan.summary ?? "Goal complete.", stepCount: session.steps.length });
        return;
      }

      emit({ kind: "goal-plan", nextPrompt: plan.nextPrompt, stepIndex: session.steps.length });

      // ── Execute step (with quota-wait retry) ────────────────────────────
      const step: GoalStep = {
        prompt: plan.nextPrompt,
        status: "running",
        startedAt: Date.now(),
      };
      session.steps.push(step);
      const stepIndex = session.steps.length - 1;
      emit({ kind: "goal-step-start", stepIndex, prompt: plan.nextPrompt });

      let result: string;
      while (true) {
        try {
          result = await resolver.runRole("reasoning", plan.nextPrompt);
          break;
        } catch (err) {
          if (err instanceof AllProvidersExhaustedError) {
            await handleQuotaWait(err, session, emit, sleep, opts);
            continue; // retry execution
          }
          step.status = "failed";
          step.finishedAt = Date.now();
          session.status = "failed";
          emit({ kind: "goal-error", error: (err as Error).message ?? String(err) });
          return;
        }
      }

      step.result = result;
      step.status = "done";
      step.finishedAt = Date.now();
      emit({ kind: "goal-step-done", stepIndex, result });
    }
  } catch (err) {
    session.status = "failed";
    emit({ kind: "goal-error", error: (err as Error).message ?? String(err) });
  }
}

async function handleQuotaWait(
  _err: AllProvidersExhaustedError,
  session: GoalSession,
  emit: (evt: GoalProgress) => void,
  sleep: (ms: number) => Promise<void>,
  opts: GoalRunnerOpts,
): Promise<void> {
  const waitMs = resolveWaitMs(opts.quotaWaitMs);
  const resumeAt = Date.now() + waitMs;
  session.status = "paused";
  session.pausedUntil = resumeAt;
  const providers = opts.getProviderSnapshots?.() ?? [];
  emit({ kind: "quota-wait", resumeAt, waitMs, providers });
  await sleep(waitMs);
  session.status = "running";
  session.pausedUntil = undefined;
}
