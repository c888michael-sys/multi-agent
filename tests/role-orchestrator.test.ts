import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { RoleResolver } from "../src/roles/resolver.js";
import { RoleOrchestrator, parsePlan } from "../src/agents/role-orchestrator.js";
import type { RoleConfig } from "../src/roles/types.js";
import { FakeProvider } from "./fixtures.js";

describe("parsePlan", () => {
  it("parses a direct plan", () => {
    expect(parsePlan('{"kind":"direct","answer":"hi"}')).toEqual({
      kind: "direct",
      answer: "hi",
    });
  });

  it("parses a single-role plan", () => {
    expect(parsePlan('{"kind":"single","role":"action-code","prompt":"write fizzbuzz"}')).toEqual({
      kind: "single",
      role: "action-code",
      prompt: "write fizzbuzz",
    });
  });

  it("parses a parallel plan with multiple tasks", () => {
    const plan = parsePlan(
      '{"kind":"parallel","tasks":[{"role":"perception","prompt":"a"},{"role":"reasoning","prompt":"b"}]}',
    );
    expect(plan).toEqual({
      kind: "parallel",
      tasks: [
        { role: "perception", prompt: "a" },
        { role: "reasoning", prompt: "b" },
      ],
    });
  });

  it("strips markdown code fences before parsing", () => {
    const wrapped = "```json\n" + '{"kind":"direct","answer":"x"}' + "\n```";
    expect(parsePlan(wrapped)).toEqual({ kind: "direct", answer: "x" });
  });

  it("falls back to action-structural-single on malformed JSON", () => {
    const plan = parsePlan("garbage not json");
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.role).toBe("action-structural");
      expect(plan.prompt).toBe("garbage not json");
    }
  });

  it("falls back on invalid role name in single plan", () => {
    const plan = parsePlan('{"kind":"single","role":"nonexistent","prompt":"x"}');
    expect(plan.kind).toBe("single");
    if (plan.kind === "single") {
      expect(plan.role).toBe("action-structural");
    }
  });

  it("filters invalid roles from parallel tasks; falls back if zero valid remain", () => {
    const plan = parsePlan(
      '{"kind":"parallel","tasks":[{"role":"bogus","prompt":"a"}]}',
    );
    expect(plan.kind).toBe("single"); // fallback
  });

  it("keeps valid parallel tasks even when some are invalid", () => {
    const plan = parsePlan(
      '{"kind":"parallel","tasks":[{"role":"bogus","prompt":"a"},{"role":"reasoning","prompt":"b"}]}',
    );
    expect(plan).toEqual({
      kind: "parallel",
      tasks: [{ role: "reasoning", prompt: "b" }],
    });
  });
});

describe("RoleOrchestrator", () => {
  function makeResolver(provider: FakeProvider, roles?: RoleConfig[]): RoleResolver {
    const router = new Router([provider], { maxRetryWaitMs: 0 });
    return new RoleResolver(
      router,
      roles ?? [
        {
          name: "orchestration",
          description: "decide",
          candidates: [{ providerId: "x" }],
        },
        {
          name: "perception",
          description: "perceive",
          candidates: [{ providerId: "x" }],
        },
        {
          name: "reasoning",
          description: "reason",
          candidates: [{ providerId: "x" }],
        },
        {
          name: "action-code",
          description: "code",
          candidates: [{ providerId: "x" }],
        },
        {
          name: "action-structural",
          description: "format",
          candidates: [{ providerId: "x" }],
        },
        {
          name: "action-repetitive",
          description: "bulk",
          candidates: [{ providerId: "x" }],
        },
      ],
    );
  }

  it("executes a direct plan without further calls", async () => {
    const p = new FakeProvider("x", [{ kind: "ok", text: '{"kind":"direct","answer":"hello"}' }]);
    const orch = new RoleOrchestrator({ resolver: makeResolver(p) });

    const result = await orch.runWithTrace("hi");
    expect(result.plan.kind).toBe("direct");
    expect(result.finalOutput).toBe("hello");
    expect(p.calls).toHaveLength(1); // only the plan call
  });

  it("executes a single-role plan with one role call", async () => {
    const p = new FakeProvider("x", [
      { kind: "ok", text: '{"kind":"single","role":"action-code","prompt":"write fib"}' },
      { kind: "ok", text: "def fib(n): ..." },
    ]);
    const orch = new RoleOrchestrator({ resolver: makeResolver(p) });

    const result = await orch.runWithTrace("write fib");
    expect(result.plan.kind).toBe("single");
    expect(result.finalOutput).toBe("def fib(n): ...");
    expect(p.calls).toHaveLength(2); // plan + role
  });

  it("executes a parallel plan and synthesizes the results", async () => {
    const p = new FakeProvider("x", [
      // 1. plan
      {
        kind: "ok",
        text: '{"kind":"parallel","tasks":[{"role":"perception","prompt":"facts"},{"role":"reasoning","prompt":"analyze"}]}',
      },
      // 2. perception result
      { kind: "ok", text: "facts: A, B, C" },
      // 3. reasoning result
      { kind: "ok", text: "analysis: X" },
      // 4. synthesis
      { kind: "ok", text: "final: X based on A, B, C" },
    ]);
    const orch = new RoleOrchestrator({
      resolver: makeResolver(p),
      dispatchStaggerMs: 0, // tests are fast
    });

    const result = await orch.runWithTrace("research X");
    expect(result.plan.kind).toBe("parallel");
    expect(result.perRole).toHaveLength(2);
    expect(result.finalOutput).toBe("final: X based on A, B, C");
    expect(p.calls).toHaveLength(4);
  });

  it("falls back to single action-structural call when planner emits garbage", async () => {
    const p = new FakeProvider("x", [
      { kind: "ok", text: "not json at all" }, // bad plan
      { kind: "ok", text: "structural answer" }, // single fallback
    ]);
    const orch = new RoleOrchestrator({ resolver: makeResolver(p) });

    const result = await orch.runWithTrace("do something");
    expect(result.plan.kind).toBe("single");
    expect(result.finalOutput).toBe("structural answer");
  });

  it("single-role parallel-mode short-circuits synthesis", async () => {
    const p = new FakeProvider("x", [
      {
        kind: "ok",
        text: '{"kind":"parallel","tasks":[{"role":"perception","prompt":"only"}]}',
      },
      { kind: "ok", text: "solo result" },
    ]);
    const orch = new RoleOrchestrator({
      resolver: makeResolver(p),
      dispatchStaggerMs: 0,
    });

    const result = await orch.runWithTrace("x");
    expect(result.finalOutput).toBe("solo result");
    expect(p.calls).toHaveLength(2); // plan + 1 role, no synthesis
  });
});
