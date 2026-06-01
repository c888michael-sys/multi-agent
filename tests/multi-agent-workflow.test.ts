import { describe, it, expect } from "vitest";
import {
  parseMultiAgentPlan,
  parseCheckResult,
  brainstormingTasks,
  runMultiAgentWorkflow,
  type WorkflowProgress,
  type WorkflowRuntime,
} from "../src/agents/multi-agent-workflow.js";

describe("parseMultiAgentPlan", () => {
  it("parses a valid plan with research and checker", () => {
    const raw = JSON.stringify({
      needsResearch: true,
      researchPrompt: "find the latest CVEs",
      actions: [{ role: "action-code", prompt: "write the patch" }],
      useChecker: true,
      checkerPrompt: "verify no bugs remain",
      maxRepairAttempts: 2,
    });
    const plan = parseMultiAgentPlan(raw, "task");
    expect(plan.needsResearch).toBe(true);
    expect(plan.researchPrompt).toBe("find the latest CVEs");
    expect(plan.actions).toEqual([{ role: "action-code", prompt: "write the patch" }]);
    expect(plan.useChecker).toBe(true);
    expect(plan.checkerPrompt).toBe("verify no bugs remain");
    expect(plan.maxRepairAttempts).toBe(2);
  });

  it("strips markdown fences before parsing", () => {
    const raw = "```json\n" + JSON.stringify({
      needsResearch: false,
      researchPrompt: "",
      actions: [{ role: "action-structural", prompt: "format it" }],
      useChecker: false,
      checkerPrompt: "",
      maxRepairAttempts: 0,
    }) + "\n```";
    const plan = parseMultiAgentPlan(raw, "task");
    expect(plan.needsResearch).toBe(false);
    expect(plan.actions[0]?.role).toBe("action-structural");
  });

  it("falls back to action-structural on malformed JSON", () => {
    const plan = parseMultiAgentPlan("not json at all", "my task");
    expect(plan.actions).toEqual([{ role: "action-structural", prompt: "my task" }]);
    expect(plan.needsResearch).toBe(false);
    expect(plan.useChecker).toBe(false);
  });

  it("ignores action entries with invalid role names", () => {
    const raw = JSON.stringify({
      needsResearch: false,
      researchPrompt: "",
      actions: [
        { role: "evil-role", prompt: "do bad thing" },
        { role: "action-code", prompt: "do good thing" },
      ],
      useChecker: false,
      checkerPrompt: "",
      maxRepairAttempts: 0,
    });
    const plan = parseMultiAgentPlan(raw, "task");
    expect(plan.actions).toEqual([{ role: "action-code", prompt: "do good thing" }]);
  });

  it("clamps maxRepairAttempts to 0–3", () => {
    const make = (n: number) => parseMultiAgentPlan(
      JSON.stringify({ needsResearch: false, researchPrompt: "", actions: [{ role: "action-code", prompt: "x" }], useChecker: false, checkerPrompt: "", maxRepairAttempts: n }),
      "task",
    ).maxRepairAttempts;
    expect(make(-5)).toBe(0);
    expect(make(99)).toBe(3);
    expect(make(2)).toBe(2);
  });

  it("falls back to task as action-structural prompt when actions array is empty", () => {
    const raw = JSON.stringify({
      needsResearch: false,
      researchPrompt: "",
      actions: [],
      useChecker: false,
      checkerPrompt: "",
      maxRepairAttempts: 0,
    });
    const plan = parseMultiAgentPlan(raw, "fallback task");
    expect(plan.actions).toEqual([{ role: "action-structural", prompt: "fallback task" }]);
  });
});

describe("parseCheckResult", () => {
  it("returns ok=true for status ok", () => {
    const r = parseCheckResult(JSON.stringify({ status: "ok", issues: [], summary: "all good" }));
    expect(r.ok).toBe(true);
  });

  it("returns ok=true for status pass", () => {
    expect(parseCheckResult(JSON.stringify({ status: "pass", issues: [] })).ok).toBe(true);
  });

  it("returns ok=false for status issues", () => {
    const r = parseCheckResult(JSON.stringify({ status: "issues", issues: ["bug A", "bug B"] }));
    expect(r.ok).toBe(false);
    expect(r.issues).toContain("bug A");
  });

  it("falls back to text heuristic — 'no issues' phrase", () => {
    expect(parseCheckResult("Looks good, no issues found.").ok).toBe(true);
  });

  it("falls back to text heuristic — 'error' phrase returns false", () => {
    expect(parseCheckResult("There is an error in line 5.").ok).toBe(false);
  });

  it("returns ok=false for malformed JSON", () => {
    expect(parseCheckResult("definitely not json").ok).toBe(false);
  });
});

describe("brainstormingTasks", () => {
  it("returns four tasks for the four specialist roles", () => {
    const tasks = brainstormingTasks("some task");
    const roles = tasks.map((t) => t.role);
    expect(roles).toContain("perception");
    expect(roles).toContain("reasoning");
    expect(roles).toContain("action-code");
    expect(roles).toContain("action-structural");
    expect(tasks).toHaveLength(4);
  });

  it("includes the user task in every prompt", () => {
    const tasks = brainstormingTasks("hello world");
    for (const t of tasks) {
      expect(t.prompt).toContain("hello world");
    }
  });
});

describe("runMultiAgentWorkflow", () => {
  function makeRuntime(replies: Record<string, string>, events: WorkflowProgress[] = []): WorkflowRuntime {
    return {
      runRole: async (role, prompt) => {
        const key = `${role}:${prompt}`.slice(0, 60);
        for (const [k, v] of Object.entries(replies)) {
          if (key.startsWith(k) || role === k) return v;
        }
        return `output-of-${role}`;
      },
      onProgress: (evt) => events.push(evt),
    };
  }

  it("runs planning → actions → format and returns a finalOutput", async () => {
    const planJson = JSON.stringify({
      needsResearch: false,
      researchPrompt: "",
      actions: [{ role: "action-structural", prompt: "format it" }],
      useChecker: false,
      checkerPrompt: "",
      maxRepairAttempts: 0,
    });
    const events: WorkflowProgress[] = [];
    const runtime = makeRuntime({ reasoning: planJson, "action-structural": "formatted output" }, events);
    const trace = await runMultiAgentWorkflow("my task", runtime);

    expect(trace.finalOutput).toBe("formatted output");
    expect(trace.servedBy).toContain("reasoning");
    expect(trace.servedBy).toContain("action-structural");

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("plan-start");
    expect(kinds).toContain("plan");
    expect(kinds).toContain("role-start");
    expect(kinds).toContain("role-end");
    expect(kinds).toContain("token");
  });

  it("runs perception when needsResearch is true", async () => {
    const planJson = JSON.stringify({
      needsResearch: true,
      researchPrompt: "look this up",
      actions: [{ role: "action-code", prompt: "code it" }],
      useChecker: false,
      checkerPrompt: "",
      maxRepairAttempts: 0,
    });
    const events: WorkflowProgress[] = [];
    const runtime = makeRuntime({ reasoning: planJson }, events);
    const trace = await runMultiAgentWorkflow("task", runtime);

    expect(trace.servedBy).toContain("perception");
    const researchStart = events.find((e) => e.kind === "role-start" && e.role === "perception");
    expect(researchStart).toBeDefined();
  });

  it("runs checker and skips repair when result is ok", async () => {
    const planJson = JSON.stringify({
      needsResearch: false,
      researchPrompt: "",
      actions: [{ role: "action-code", prompt: "write it" }],
      useChecker: true,
      checkerPrompt: "verify",
      maxRepairAttempts: 2,
    });
    const checkOk = JSON.stringify({ status: "ok", issues: [] });
    const events: WorkflowProgress[] = [];
    const runtime = makeRuntime({ reasoning: planJson, "action-repetitive": checkOk }, events);
    const trace = await runMultiAgentWorkflow("task", runtime);

    expect(trace.servedBy).toContain("action-repetitive");
    // Reasoning should appear twice (plan + not repair, since check passed)
    const repairStarts = events.filter((e) => e.kind === "role-start" && e.phase === "repair");
    expect(repairStarts).toHaveLength(0);
  });
});
