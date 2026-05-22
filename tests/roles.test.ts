import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import {
  RoleResolver,
  UnknownRoleError,
  NoCandidatesAvailableError,
} from "../src/roles/resolver.js";
import type { RoleConfig } from "../src/roles/types.js";
import { FakeProvider, ToolFakeProvider } from "./fixtures.js";

describe("Router — providerIds constraint", () => {
  it("complete() with providerIds filter only considers matching providers", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "from-a" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "from-b" }]);
    const r = new Router([a, b], { maxRetryWaitMs: 0 });

    expect(await r.complete("hi", undefined, new Set(["b"]))).toBe("from-b");
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  it("complete() with providerIds and all matches rate-limited throws", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "would-have-worked" }]);
    const r = new Router([a, b], { maxRetryWaitMs: 0 });

    await expect(r.complete("hi", undefined, new Set(["a"]))).rejects.toThrow();
    expect(b.calls).toHaveLength(0);
  });

  it("registeredProviderIds returns all configured provider IDs", () => {
    const a = new FakeProvider("a", []);
    const b = new FakeProvider("b", []);
    const r = new Router([a, b]);
    expect(r.registeredProviderIds().sort()).toEqual(["a", "b"]);
  });
});

describe("RoleResolver", () => {
  const role = (
    name: RoleConfig["name"],
    candidateIds: string[],
    extras?: Partial<RoleConfig>,
  ): RoleConfig => ({
    name,
    description: `${name} role`,
    candidates: candidateIds.map((id) => ({ providerId: id })),
    ...extras,
  });

  it("routes a role call to its primary candidate", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "answer-from-a" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "answer-from-b" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [role("reasoning", ["b"])]);

    expect(await resolver.runRole("reasoning", "think")).toBe("answer-from-b");
    expect(a.calls).toHaveLength(0);
  });

  it("falls back to secondary candidate when primary rate-limits", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "fallback-worked" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [role("orchestration", ["a", "b"])]);

    expect(await resolver.runRole("orchestration", "do it")).toBe("fallback-worked");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("throws NoCandidatesAvailableError if none of role's candidates are registered", async () => {
    const a = new FakeProvider("a", []);
    const router = new Router([a]);
    const resolver = new RoleResolver(router, [role("reasoning", ["nonexistent"])]);

    await expect(resolver.runRole("reasoning", "x")).rejects.toBeInstanceOf(
      NoCandidatesAvailableError,
    );
  });

  it("throws UnknownRoleError for an unregistered role name", async () => {
    const a = new FakeProvider("a", []);
    const router = new Router([a]);
    const resolver = new RoleResolver(router, []);
    await expect(resolver.runRole("reasoning", "x")).rejects.toBeInstanceOf(UnknownRoleError);
  });

  it("applies the candidate's mode (e.g., thinking) to the call", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "ok" }]);
    const router = new Router([a], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      {
        name: "reasoning",
        description: "x",
        candidates: [{ providerId: "a", mode: { thinking: "high" } }],
      },
    ]);

    await resolver.runRole("reasoning", "deliberate");
    expect(a.calls[0]!.opts?.thinking).toBe("high");
  });

  it("caller opts override role mode for the same key", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "ok" }]);
    const router = new Router([a], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      {
        name: "reasoning",
        description: "x",
        candidates: [{ providerId: "a", mode: { thinking: "high" } }],
      },
    ]);

    await resolver.runRole("reasoning", "x", { thinking: "low" });
    expect(a.calls[0]!.opts?.thinking).toBe("low");
  });

  it("prepends the role's systemPromptTemplate to the user prompt", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "ok" }]);
    const router = new Router([a], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      {
        name: "perception",
        description: "x",
        candidates: [{ providerId: "a" }],
        systemPromptTemplate: "You are the perception agent.",
      },
    ]);

    await resolver.runRole("perception", "find facts");
    expect(a.calls[0]!.prompt).toContain("You are the perception agent.");
    expect(a.calls[0]!.prompt).toContain("find facts");
  });

  it("unsatisfiedRoles lists roles with no registered candidate provider", () => {
    const a = new FakeProvider("a", []);
    const router = new Router([a]);
    const resolver = new RoleResolver(router, [
      role("perception", ["a"]),
      role("reasoning", ["only-other-provider"]),
      role("action-code", ["a", "another-missing"]),
    ]);
    expect(resolver.unsatisfiedRoles()).toEqual(["reasoning"]);
  });

  it("rosterDescription marks unavailable roles", () => {
    const a = new FakeProvider("a", []);
    const router = new Router([a]);
    const resolver = new RoleResolver(router, [
      role("perception", ["a"]),
      role("reasoning", ["missing-provider"]),
    ]);
    const desc = resolver.rosterDescription();
    expect(desc).toContain("perception (a)");
    expect(desc).toContain("reasoning [UNAVAILABLE]");
  });
});

describe("RoleResolver — tool-use path", () => {
  it("runRoleWithTools routes to the role's candidate provider", async () => {
    const a = new ToolFakeProvider("a", [{ kind: "text", text: "tool-answer" }]);
    const router = new Router([a], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      {
        name: "action-code",
        description: "x",
        candidates: [{ providerId: "a" }],
      },
    ]);

    const result = await resolver.runRoleWithTools(
      "action-code",
      [{ kind: "user_text", text: "do" }],
      [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }],
    );
    expect(result).toEqual({ kind: "text", text: "tool-answer" });
    expect(a.toolCalls).toHaveLength(1);
  });
});
