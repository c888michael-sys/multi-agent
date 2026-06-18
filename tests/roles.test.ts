import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import {
  RoleResolver,
  UnknownRoleError,
  NoCandidatesAvailableError,
} from "../src/roles/resolver.js";
import { buildDefaultRoles } from "../src/roles/default-registry.js";
import type { RoleConfig, RoleEvent } from "../src/roles/types.js";
import type { Provider } from "../src/provider.js";
import { FakeProvider, ToolFakeProvider } from "./fixtures.js";

/** Provider with a toggleable isActive(), mimicking an override slot. */
class ToggleProvider implements Provider {
  readonly model = "toggle-model";
  active = true;
  calls = 0;
  constructor(
    readonly id: string,
    private readonly text: string,
  ) {}
  async complete(): Promise<string> {
    this.calls++;
    return this.text;
  }
  isRateLimitError(): boolean {
    return false;
  }
  retryAfterMs(): number | null {
    return null;
  }
  isActive(): boolean {
    return this.active;
  }
}

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

  it("skips an inactive override slot and serves the next candidate; uses it once active", async () => {
    const ovr = new ToggleProvider("override:reasoning", "from-override");
    ovr.active = false;
    const real = new FakeProvider("openrouter:reasoning", [
      { kind: "ok", text: "from-default" },
      { kind: "ok", text: "from-default-2" },
    ]);
    const router = new Router([ovr, real], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      role("reasoning", ["override:reasoning", "openrouter:reasoning"]),
    ]);

    // Inactive override is skipped entirely — default serves, no fallback noise.
    expect(await resolver.runRole("reasoning", "x")).toBe("from-default");
    expect(ovr.calls).toBe(0);

    // Once active, the override slot wins as primary.
    ovr.active = true;
    expect(await resolver.runRole("reasoning", "x")).toBe("from-override");
    expect(ovr.calls).toBe(1);
  });

  it("does not borrow an inactive override slot via cross-role substitution", async () => {
    const otherOverride = new ToggleProvider("override:action-code", "should-not-be-used");
    otherOverride.active = false;
    const exhausted = new FakeProvider("primary", [{ kind: "rate" }]);
    const router = new Router([otherOverride, exhausted], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [role("reasoning", ["primary"])], {
      crossRoleFailover: true,
    });

    // reasoning's only candidate is rate-limited; the only foreign provider is an
    // inactive override slot, which must NOT be borrowed.
    await expect(resolver.runRole("reasoning", "x")).rejects.toThrow();
    expect(otherOverride.calls).toBe(0);
  });

  it("falls back to secondary candidate when primary is exhausted", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "fallback-worked" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [role("orchestration", ["a", "b"])]);

    expect(await resolver.runRole("orchestration", "do it")).toBe("fallback-worked");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("calls primary candidate first even when secondary is also available", async () => {
    // Regression: previous implementation built a multi-provider allowList,
    // letting the router's round-robin cursor pick the secondary first.
    const a = new FakeProvider("a", [{ kind: "ok", text: "from-a" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "from-b" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [role("orchestration", ["a", "b"])]);

    expect(await resolver.runRole("orchestration", "x")).toBe("from-a");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0); // primary preferred, secondary not used
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

describe("default role registry", () => {
  function candidateIds(roleName: RoleConfig["name"], local: boolean): string[] {
    return buildDefaultRoles({ local }).find((r) => r.name === roleName)!.candidates.map((c) => c.providerId);
  }

  it("prepends the override slot, then OpenRouter as the cloud reasoning primary", () => {
    expect(candidateIds("reasoning", false).slice(0, 6)).toEqual([
      "override:reasoning",
      "openrouter:reasoning",
      "gemini:1",
      "gemini:2",
      "gemma:1",
      "gemma:2",
    ]);
  });

  it("override slot is first; hybrid mode then prepends Ollama to reasoning and action-code", () => {
    // Customisable roles get the override slot at index 0 (inactive by default,
    // skipped by the resolver), then the local-prepend, then the cloud chain.
    expect(candidateIds("reasoning", true).slice(0, 2)).toEqual([
      "override:reasoning",
      "ollama:qwen3.5-9b",
    ]);
    expect(candidateIds("action-code", true).slice(0, 2)).toEqual([
      "override:action-code",
      "ollama:qwen2.5-coder",
    ]);
    expect(candidateIds("reasoning", false).slice(0, 2)).toEqual([
      "override:reasoning",
      "openrouter:reasoning",
    ]);

    // orchestration is customisable but not local — override slot then gemini:1.
    expect(candidateIds("orchestration", true).slice(0, 2)).toEqual([
      "override:orchestration",
      "gemini:1",
    ]);
    // mindmap-categorize is NOT customisable: no override slot, cloud chain only.
    expect(candidateIds("mindmap-categorize", true)[0]).toBe("gemini:1");
    expect(candidateIds("mindmap-categorize", true)).not.toContain("ollama:qwen2.5-coder");
    expect(candidateIds("mindmap-categorize", true)).not.toContain("override:mindmap-categorize");
  });

  it("mindmap categorization uses the same cloud/reserved chain in both modes", () => {
    expect(candidateIds("mindmap-categorize", true)).toEqual(candidateIds("mindmap-categorize", false));
  });
});

describe("RoleResolver — event emission and cross-role failover", () => {
  it("emits fallback-within-role when secondary candidate is used", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "from-b" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [
        {
          name: "reasoning",
          description: "x",
          candidates: [{ providerId: "a" }, { providerId: "b" }],
        },
      ],
      { onEvent: (e) => events.push(e) },
    );

    expect(await resolver.runRole("reasoning", "x")).toBe("from-b");
    expect(events).toEqual([
      { type: "fallback-within-role", role: "reasoning", primaryProviderId: "a", usedProviderId: "b" },
    ]);
  });

  it("does not emit fallback event when primary works", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "ok" }]);
    const router = new Router([a], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [{ name: "reasoning", description: "x", candidates: [{ providerId: "a" }] }],
      { onEvent: (e) => events.push(e) },
    );

    await resolver.runRole("reasoning", "x");
    expect(events).toEqual([]);
  });

  it("uses cross-role substitution when all role candidates exhausted", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "substituted-from-b" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [{ name: "perception", description: "x", candidates: [{ providerId: "a" }] }],
      { onEvent: (e) => events.push(e) },
    );

    const out = await resolver.runRole("perception", "x");
    expect(out).toBe("substituted-from-b");
    expect(events).toEqual([
      // usedProviderId now reflects the actual provider that served the call,
      // not a piped list of all eligible foreigns.
      { type: "cross-role-substitution", role: "perception", primaryProviderId: "a", usedProviderId: "b" },
    ]);
  });

  it("aggregates failed attempts from every tried candidate when role fully exhausts", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "rate" }]);
    const c = new FakeProvider("c", [{ kind: "rate" }]);
    const router = new Router([a, b, c], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [
        {
          name: "perception",
          description: "x",
          candidates: [{ providerId: "a" }, { providerId: "b" }, { providerId: "c" }],
        },
      ],
      { onEvent: (e) => events.push(e), crossRoleFailover: false },
    );

    try {
      await resolver.runRole("perception", "x");
      throw new Error("expected throw");
    } catch (err) {
      const { AllProvidersExhaustedError } = await import("../src/errors.js");
      expect(err).toBeInstanceOf(AllProvidersExhaustedError);
      const ids = (err as InstanceType<typeof AllProvidersExhaustedError>).attempts.map((x) => x.providerId);
      // All three should appear (the previous behavior only showed the last).
      expect(ids).toEqual(["a", "b", "c"]);
    }
  });

  it("emits role-exhausted and throws when crossRoleFailover is disabled", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "ignored" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [{ name: "perception", description: "x", candidates: [{ providerId: "a" }] }],
      { crossRoleFailover: false, onEvent: (e) => events.push(e) },
    );

    await expect(resolver.runRole("perception", "x")).rejects.toThrow();
    expect(events.some((e) => e.type === "role-exhausted")).toBe(true);
    expect(b.calls).toHaveLength(0); // foreign provider was NOT borrowed
  });

  it("emits role-exhausted when nothing in the pool can serve", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "rate" }]);
    const router = new Router([a, b], { maxRetryWaitMs: 0 });
    const events: RoleEvent[] = [];
    const resolver = new RoleResolver(
      router,
      [{ name: "perception", description: "x", candidates: [{ providerId: "a" }] }],
      { onEvent: (e) => events.push(e) },
    );

    await expect(resolver.runRole("perception", "x")).rejects.toThrow();
    expect(events.some((e) => e.type === "role-exhausted")).toBe(true);
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
