import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { Agent } from "../src/agents/agent.js";
import { Controller } from "../src/agents/controller.js";
import { FakeProvider, type Reply } from "./fixtures.js";

/**
 * Helpers: build a router whose single fake provider returns scripted replies
 * in order. The first call goes to whichever consumer asks first.
 */
function routerWithScript(replies: Reply[]) {
  const p = new FakeProvider("p", replies);
  return { router: new Router([p]), provider: p };
}

describe("Controller — specialist mode", () => {
  it("routes to the agent the controller picks", async () => {
    // Replies in order: routing decision -> researcher's answer
    const { router, provider } = routerWithScript([
      { kind: "ok", text: "researcher" }, // routing
      { kind: "ok", text: "the answer is 4" }, // researcher
    ]);
    const researcher = new Agent({
      id: "researcher",
      role: "facts",
      systemPrompt: "facts agent",
      router,
    });
    const writer = new Agent({
      id: "writer",
      role: "prose",
      systemPrompt: "writer agent",
      router,
    });
    const c = new Controller({ router, subAgents: [researcher, writer], mode: "specialist" });

    const trace = await c.runWithTrace("What is 2+2?");
    expect(trace.mode).toBe("specialist");
    expect(trace.pickedAgentId).toBe("researcher");
    expect(trace.finalOutput).toBe("the answer is 4");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.prompt).toContain("AVAILABLE SUB-AGENTS");
  });

  it("falls back to first agent when controller pick doesn't match", async () => {
    const { router } = routerWithScript([
      { kind: "ok", text: "NONE" }, // routing returns NONE
      { kind: "ok", text: "fallback answer" }, // first agent answers
    ]);
    const a = new Agent({ id: "a", role: "r", systemPrompt: "a", router });
    const b = new Agent({ id: "b", role: "r", systemPrompt: "b", router });
    const c = new Controller({ router, subAgents: [a, b], mode: "specialist" });

    const trace = await c.runWithTrace("anything");
    expect(trace.pickedAgentId).toBe("a");
    expect(trace.finalOutput).toBe("fallback answer");
  });
});

describe("Controller — parallel mode", () => {
  it("calls all sub-agents and synthesizes their outputs", async () => {
    // 3 sub-agents each emit a reply, then controller synthesizes -> 4 total replies
    const { router, provider } = routerWithScript([
      { kind: "ok", text: "agent-1 says X" },
      { kind: "ok", text: "agent-2 says Y" },
      { kind: "ok", text: "agent-3 says X" },
      { kind: "ok", text: "synthesis: X wins" },
    ]);
    const subs = ["a1", "a2", "a3"].map(
      (id) => new Agent({ id, role: "thinker", systemPrompt: `you are ${id}`, router }),
    );
    const c = new Controller({ router, subAgents: subs, mode: "parallel" });

    const trace = await c.runWithTrace("which: X or Y?");
    expect(trace.mode).toBe("parallel");
    expect(trace.perAgent).toHaveLength(3);
    expect(trace.perAgent!.map((p) => p.output)).toEqual([
      "agent-1 says X",
      "agent-2 says Y",
      "agent-3 says X",
    ]);
    expect(trace.finalOutput).toBe("synthesis: X wins");

    // Last call to provider was the synthesis prompt; it should include all 3 outputs
    // and the token-efficient sentinels.
    const synthesisPrompt = provider.calls[3]!.prompt;
    expect(synthesisPrompt).toContain("<<<a1");
    expect(synthesisPrompt).toContain("<<<a2");
    expect(synthesisPrompt).toContain("<<<a3");
    expect(synthesisPrompt).toContain(">>>");
  });

  it("includes failed agents in the trace as [error: ...] but still synthesizes", async () => {
    const { router } = routerWithScript([
      { kind: "ok", text: "a1 says X" },
      { kind: "error", error: new Error("a2 blew up") },
      { kind: "ok", text: "synthesis ignoring a2" },
    ]);
    const subs = ["a1", "a2"].map(
      (id) => new Agent({ id, role: "thinker", systemPrompt: id, router }),
    );
    const c = new Controller({ router, subAgents: subs, mode: "parallel" });

    const trace = await c.runWithTrace("task");
    expect(trace.perAgent![1]!.output).toContain("[error:");
    expect(trace.finalOutput).toBe("synthesis ignoring a2");
  });

  it("passes through single-agent output without a synthesis call", async () => {
    const { router, provider } = routerWithScript([{ kind: "ok", text: "solo answer" }]);
    const solo = new Agent({ id: "solo", role: "r", systemPrompt: "x", router });
    const c = new Controller({ router, subAgents: [solo], mode: "parallel" });

    const trace = await c.runWithTrace("task");
    expect(trace.finalOutput).toBe("solo answer");
    expect(provider.calls).toHaveLength(1); // no extra synthesis call
  });
});

describe("Controller — construction", () => {
  it("throws if given no sub-agents", () => {
    const { router } = routerWithScript([]);
    expect(() => new Controller({ router, subAgents: [], mode: "specialist" })).toThrow();
  });
});
