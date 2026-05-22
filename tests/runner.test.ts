import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { ToolRunner } from "../src/tools/runner.js";
import type { Tool } from "../src/tools/types.js";
import { ToolFakeProvider } from "./fixtures.js";

function makeEchoTool(name = "echo"): Tool {
  return {
    name,
    description: "Returns its 'msg' arg verbatim.",
    parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    execute: async (args) => String(args.msg ?? ""),
  };
}

describe("ToolRunner", () => {
  it("returns model text immediately when no tool calls are emitted", async () => {
    const p = new ToolFakeProvider("p", [{ kind: "text", text: "hello world" }]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [makeEchoTool()] });

    const result = await runner.run("hi");
    expect(result.finalText).toBe("hello world");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("executes a tool call and feeds the result back, then returns final text", async () => {
    const p = new ToolFakeProvider("p", [
      { kind: "calls", calls: [{ name: "echo", args: { msg: "ping" } }] },
      { kind: "text", text: "got: ping" },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [makeEchoTool()] });

    const result = await runner.run("call echo with ping");
    expect(result.toolCalls).toEqual([{ name: "echo", args: { msg: "ping" }, result: "ping", ok: true }]);
    expect(result.finalText).toBe("got: ping");
    // The second prompt's history should include the user prompt, the model's call, and the tool result.
    const secondCallHistory = p.toolCalls[1]!.history;
    expect(secondCallHistory.map((h) => h.kind)).toEqual([
      "user_text",
      "model_calls",
      "tool_result",
    ]);
  });

  it("surfaces unknown tool names back to the model rather than throwing", async () => {
    const p = new ToolFakeProvider("p", [
      { kind: "calls", calls: [{ name: "nope", args: {} }] },
      { kind: "text", text: "recovered" },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [makeEchoTool()] });

    const result = await runner.run("do something");
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.result).toMatch(/unknown tool/);
    expect(result.finalText).toBe("recovered");
  });

  it("marks tool result ok=false when execute returns ERROR:", async () => {
    const failing: Tool = {
      name: "fail",
      description: "always errors",
      parameters: { type: "object", properties: {} },
      execute: async () => "ERROR: simulated failure",
    };
    const p = new ToolFakeProvider("p", [
      { kind: "calls", calls: [{ name: "fail", args: {} }] },
      { kind: "text", text: "handled" },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [failing] });

    const result = await runner.run("try the failing tool");
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.finalText).toBe("handled");
  });

  it("catches thrown errors from tool.execute and surfaces them as ERROR:", async () => {
    const throwing: Tool = {
      name: "boom",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const p = new ToolFakeProvider("p", [
      { kind: "calls", calls: [{ name: "boom", args: {} }] },
      { kind: "text", text: "ok" },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [throwing] });

    const result = await runner.run("trigger throw");
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.result).toBe("ERROR: kaboom");
  });

  it("truncates after maxIterations and reports it", async () => {
    // Provider keeps requesting tools indefinitely; runner should bail.
    const p = new ToolFakeProvider("p", [
      { kind: "calls", calls: [{ name: "echo", args: { msg: "1" } }] },
      { kind: "calls", calls: [{ name: "echo", args: { msg: "2" } }] },
      { kind: "calls", calls: [{ name: "echo", args: { msg: "3" } }] },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [makeEchoTool()], maxIterations: 2 });

    const result = await runner.run("loop forever");
    expect(result.truncated).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.finalText).toMatch(/truncated/);
  });

  it("executes multiple tool calls in a single model turn", async () => {
    const p = new ToolFakeProvider("p", [
      {
        kind: "calls",
        calls: [
          { name: "echo", args: { msg: "first" } },
          { name: "echo", args: { msg: "second" } },
        ],
      },
      { kind: "text", text: "did both" },
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const runner = new ToolRunner({ router, tools: [makeEchoTool()] });

    const result = await runner.run("do both");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.result).toBe("first");
    expect(result.toolCalls[1]!.result).toBe("second");
    expect(result.finalText).toBe("did both");
  });
});
