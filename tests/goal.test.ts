import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore, type GoalSession } from "../src/goal/goal-session.js";
import { buildPlannerPrompt, parsePlannerResponse } from "../src/goal/planner.js";
import { runGoalLoop, type GoalProgress } from "../src/goal/runner.js";
import { AllProvidersExhaustedError } from "../src/errors.js";

// ── GoalStore ────────────────────────────────────────────────────────────────

describe("GoalStore", () => {
  let dir: string;
  let store: GoalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goal-store-"));
    store = new GoalStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves and loads a goal session", () => {
    const session: GoalSession = {
      goalId: "goal_abc",
      description: "Do something useful",
      steps: [],
      status: "running",
      createdAt: 1000,
      updatedAt: 1000,
    };
    store.save(session);
    const loaded = store.load("goal_abc");
    expect(loaded).toEqual(session);
  });

  it("returns null for unknown goalId", () => {
    expect(store.load("goal_missing")).toBeNull();
  });

  it("lists all saved sessions", () => {
    const a: GoalSession = { goalId: "goal_a", description: "A", steps: [], status: "running", createdAt: 1, updatedAt: 1 };
    const b: GoalSession = { goalId: "goal_b", description: "B", steps: [], status: "done", createdAt: 2, updatedAt: 2 };
    store.save(a);
    store.save(b);
    const list = store.list();
    expect(list).toHaveLength(2);
    const ids = list.map((s) => s.goalId).sort();
    expect(ids).toEqual(["goal_a", "goal_b"]);
  });

  it("deletes a goal session and returns true", () => {
    const session: GoalSession = { goalId: "goal_del", description: "Delete me", steps: [], status: "done", createdAt: 1, updatedAt: 1 };
    store.save(session);
    expect(store.delete("goal_del")).toBe(true);
    expect(store.load("goal_del")).toBeNull();
  });

  it("returns false when deleting a non-existent goal", () => {
    expect(store.delete("goal_nope")).toBe(false);
  });

  it("overwrites an existing session on save", () => {
    const session: GoalSession = { goalId: "goal_upd", description: "Old", steps: [], status: "running", createdAt: 1, updatedAt: 1 };
    store.save(session);
    const updated = { ...session, description: "New", status: "done" as const, updatedAt: 2 };
    store.save(updated);
    expect(store.load("goal_upd")?.description).toBe("New");
  });
});

// ── buildPlannerPrompt ───────────────────────────────────────────────────────

describe("buildPlannerPrompt", () => {
  it("includes goal description", () => {
    const prompt = buildPlannerPrompt("Build a rocket", []);
    expect(prompt).toContain("Build a rocket");
  });

  it("mentions no steps taken when steps is empty", () => {
    const prompt = buildPlannerPrompt("Do X", []);
    expect(prompt).toMatch(/no steps|0 steps|none/i);
  });

  it("includes completed step summaries", () => {
    const prompt = buildPlannerPrompt("Do X", [
      { prompt: "step one prompt", result: "step one result", status: "done" },
      { prompt: "step two prompt", result: "step two result", status: "done" },
    ]);
    expect(prompt).toContain("step one prompt");
    expect(prompt).toContain("step two result");
    expect(prompt).toContain("step two prompt");
  });

  it("asks for a single next action as JSON", () => {
    const prompt = buildPlannerPrompt("goal", []);
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toContain("nextPrompt");
    expect(prompt).toContain("done");
  });
});

// ── parsePlannerResponse ─────────────────────────────────────────────────────

describe("parsePlannerResponse", () => {
  it("parses valid JSON with nextPrompt and done:false", () => {
    const result = parsePlannerResponse('{"nextPrompt":"do step 1","done":false}');
    expect(result.nextPrompt).toBe("do step 1");
    expect(result.done).toBe(false);
  });

  it("parses done:true with optional summary", () => {
    const result = parsePlannerResponse('{"nextPrompt":"final","done":true,"summary":"All done!"}');
    expect(result.done).toBe(true);
    expect(result.summary).toBe("All done!");
  });

  it("handles JSON wrapped in code fences", () => {
    const raw = "```json\n{\"nextPrompt\":\"step\",\"done\":false}\n```";
    const result = parsePlannerResponse(raw);
    expect(result.nextPrompt).toBe("step");
  });

  it("falls back to a default step on malformed JSON", () => {
    const result = parsePlannerResponse("not json at all");
    expect(result.done).toBe(false);
    expect(typeof result.nextPrompt).toBe("string");
    expect(result.nextPrompt.length).toBeGreaterThan(0);
  });

  it("falls back when JSON lacks required fields", () => {
    const result = parsePlannerResponse('{"something":"else"}');
    expect(result.done).toBe(false);
    expect(result.nextPrompt.length).toBeGreaterThan(0);
  });
});

// ── runGoalLoop ──────────────────────────────────────────────────────────────

describe("runGoalLoop", () => {
  it("runs steps until planner says done and emits correct events", async () => {
    let plannerCallCount = 0;
    const events: GoalProgress[] = [];

    // Mock resolver: first planNextStep → step 1 needed; second → done
    const mockResolver = {
      runRole: vi.fn(async (_role: string, prompt: string) => {
        if (prompt.includes("next concrete action")) {
          plannerCallCount++;
          if (plannerCallCount === 1) return '{"nextPrompt":"execute step 1","done":false}';
          return '{"nextPrompt":"","done":true,"summary":"Finished"}';
        }
        // Step execution
        return "step 1 result";
      }),
    };

    const session: GoalSession = {
      goalId: "goal_test1",
      description: "Do a thing",
      steps: [],
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await runGoalLoop(session, mockResolver as any, {
      onProgress: (e) => events.push(e),
      sleep: async () => {},
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("goal-step-start");
    expect(kinds).toContain("goal-step-done");
    expect(kinds).toContain("goal-done");

    const done = events.find((e) => e.kind === "goal-done") as Extract<GoalProgress, { kind: "goal-done" }>;
    expect(done.summary).toBe("Finished");
    expect(done.stepCount).toBe(1);
  });

  it("emits quota-wait event and retries when AllProvidersExhaustedError is thrown", async () => {
    const events: GoalProgress[] = [];
    let plannerCallCount = 0;
    let stepCallCount = 0;

    const mockResolver = {
      runRole: vi.fn(async (_role: string, prompt: string) => {
        if (prompt.includes("next concrete action")) {
          plannerCallCount++;
          if (plannerCallCount === 1) return '{"nextPrompt":"do step","done":false}';
          return '{"nextPrompt":"","done":true,"summary":"Done after retry"}';
        }
        // Step execution: first attempt throws quota error, second succeeds
        stepCallCount++;
        if (stepCallCount === 1) throw new AllProvidersExhaustedError([]);
        return "step result after retry";
      }),
    };

    const session: GoalSession = {
      goalId: "goal_quota",
      description: "Quota test",
      steps: [],
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const sleepCalls: number[] = [];
    await runGoalLoop(session, mockResolver as any, {
      onProgress: (e) => events.push(e),
      quotaWaitMs: 100,
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    const waitEvents = events.filter((e) => e.kind === "quota-wait");
    expect(waitEvents).toHaveLength(1);
    const waitEvt = waitEvents[0] as Extract<GoalProgress, { kind: "quota-wait" }>;
    expect(waitEvt.waitMs).toBe(100);
    expect(waitEvt.resumeAt).toBeGreaterThan(0);

    // Should have slept the quota wait duration
    expect(sleepCalls).toContain(100);
  });

  it("resumes from already-completed steps", async () => {
    const events: GoalProgress[] = [];
    let plannerCallCount = 0;

    const mockResolver = {
      runRole: vi.fn(async (_role: string, prompt: string) => {
        if (prompt.includes("next concrete action")) {
          plannerCallCount++;
          if (plannerCallCount === 1) return '{"nextPrompt":"step 2","done":false}';
          return '{"nextPrompt":"","done":true,"summary":"Resumed and done"}';
        }
        return "step 2 result";
      }),
    };

    // Session already has one completed step
    const session: GoalSession = {
      goalId: "goal_resume",
      description: "Resume test",
      steps: [
        { prompt: "step 1 already done", result: "result 1", status: "done", startedAt: 1, finishedAt: 2 },
      ],
      status: "paused",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await runGoalLoop(session, mockResolver as any, {
      onProgress: (e) => events.push(e),
      sleep: async () => {},
    });

    // Planner should receive the existing step in its context
    const plannerCall = (mockResolver.runRole as any).mock.calls.find(
      ([_r, p]: [string, string]) => p.includes("next concrete action") || p.includes("Completed steps")
    );
    expect(plannerCall).toBeTruthy();

    const doneEvt = events.find((e) => e.kind === "goal-done") as Extract<GoalProgress, { kind: "goal-done" }>;
    expect(doneEvt.stepCount).toBe(2); // 1 pre-existing + 1 new
  });

  it("emits goal-error and stops on unexpected errors", async () => {
    const events: GoalProgress[] = [];

    const mockResolver = {
      runRole: vi.fn(async () => {
        throw new Error("unexpected API failure");
      }),
    };

    const session: GoalSession = {
      goalId: "goal_err",
      description: "Error test",
      steps: [],
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await runGoalLoop(session, mockResolver as any, {
      onProgress: (e) => events.push(e),
      sleep: async () => {},
    });

    const errEvt = events.find((e) => e.kind === "goal-error") as Extract<GoalProgress, { kind: "goal-error" }>;
    expect(errEvt).toBeTruthy();
    expect(errEvt.error).toContain("unexpected API failure");
    expect(session.status).toBe("failed");
  });

  it("sets session.status to failed when step execution throws a non-quota error", async () => {
    const events: GoalProgress[] = [];
    let plannerCalled = false;

    const mockResolver = {
      runRole: vi.fn(async (_role: string, prompt: string) => {
        if (prompt.includes("next concrete action")) {
          if (!plannerCalled) {
            plannerCalled = true;
            return '{"nextPrompt":"do the step","done":false}';
          }
        }
        // Step execution always throws a non-quota error
        throw new Error("step execution failure");
      }),
    };

    const session: GoalSession = {
      goalId: "goal_step_err",
      description: "Step error test",
      steps: [],
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await runGoalLoop(session, mockResolver as any, {
      onProgress: (e) => events.push(e),
      sleep: async () => {},
    });

    const errEvt = events.find((e) => e.kind === "goal-error") as Extract<GoalProgress, { kind: "goal-error" }>;
    expect(errEvt).toBeTruthy();
    expect(errEvt.error).toContain("step execution failure");
    expect(session.status).toBe("failed");
  });
});
