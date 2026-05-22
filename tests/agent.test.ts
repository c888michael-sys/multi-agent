import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { Agent } from "../src/agents/agent.js";
import { FakeProvider } from "./fixtures.js";

describe("Agent", () => {
  it("composes system prompt + user input and returns router output", async () => {
    const p = new FakeProvider("p", [{ kind: "ok", text: "answer-from-fake" }]);
    const router = new Router([p]);
    const a = new Agent({
      id: "researcher",
      role: "finds facts",
      systemPrompt: "You are a researcher.",
      router,
    });

    const out = await a.run("What is 2+2?");
    expect(out).toBe("answer-from-fake");
    expect(p.calls[0]!.prompt).toContain("You are a researcher.");
    expect(p.calls[0]!.prompt).toContain("What is 2+2?");
  });
});
