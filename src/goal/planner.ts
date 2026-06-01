import type { GoalStep } from "./goal-session.js";
import type { RoleName } from "../roles/types.js";

export interface PlannerResult {
  nextPrompt: string;
  done: boolean;
  summary?: string;
}

const FALLBACK_PROMPT = "Continue working toward the goal based on what has been done so far.";

/**
 * Builds the planning prompt sent to the reasoning role.
 * Pure function — exported for unit testing.
 */
export function buildPlannerPrompt(description: string, steps: GoalStep[]): string {
  const doneSteps = steps.filter((s) => s.status === "done");
  const stepsSection =
    doneSteps.length === 0
      ? "No steps taken yet."
      : doneSteps
          .map((s, i) => `${i + 1}. Prompt: ${s.prompt}\n   Result: ${(s.result ?? "").slice(0, 300)}`)
          .join("\n\n");

  return [
    `Goal: ${description}`,
    ``,
    `Completed steps so far:`,
    stepsSection,
    ``,
    `What is the single next concrete action to take toward this goal?`,
    `Reply ONLY with valid JSON (no prose, no fences):`,
    `{ "nextPrompt": "<what to ask or do next>", "done": <true if goal is fully achieved>, "summary": "<optional 1-sentence progress summary>" }`,
    `If the goal is fully achieved, set done:true and summarize the result in summary.`,
  ].join("\n");
}

/**
 * Parses the reasoning role's JSON response into a PlannerResult.
 * Handles code-fence wrapping and malformed output gracefully.
 * Pure function — exported for unit testing.
 */
export function parsePlannerResponse(raw: string): PlannerResult {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Find the first {...} block in case the model prefixes prose.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { nextPrompt: FALLBACK_PROMPT, done: false };

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const nextPrompt = typeof parsed.nextPrompt === "string" && parsed.nextPrompt.trim()
      ? parsed.nextPrompt.trim()
      : FALLBACK_PROMPT;
    const done = parsed.done === true;
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
    return { nextPrompt, done, summary };
  } catch {
    return { nextPrompt: FALLBACK_PROMPT, done: false };
  }
}

/** Minimal resolver shape the planner needs — avoids importing the full resolver class. */
export interface PlannerResolver {
  runRole(name: RoleName, prompt: string): Promise<string>;
}

/** Calls the reasoning role to decide the next step. */
export async function planNextStep(
  description: string,
  steps: GoalStep[],
  resolver: PlannerResolver,
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(description, steps);
  const raw = await resolver.runRole("reasoning", prompt);
  return parsePlannerResponse(raw);
}
