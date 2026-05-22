import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError } from "../src/errors.js";
import { FakeProvider } from "./fixtures.js";

describe("Router", () => {
  it("returns the first provider's response on success", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "hello from A" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "hello from B" }]);
    const r = new Router([a, b]);

    expect(await r.complete("hi")).toBe("hello from A");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it("rotates to next provider on 429", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "from B" }]);
    const r = new Router([a, b]);

    expect(await r.complete("hi")).toBe("from B");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("throws AllProvidersExhaustedError when every provider rate-limits", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "rate" }]);
    const r = new Router([a, b]);

    await expect(r.complete("hi")).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("does not retry non-rate-limit errors", async () => {
    const boom = new Error("invalid prompt");
    const a = new FakeProvider("a", [{ kind: "error", error: boom }]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "from B" }]);
    const r = new Router([a, b]);

    await expect(r.complete("hi")).rejects.toBe(boom);
    expect(b.calls).toHaveLength(0);
  });

  it("round-robins across calls when both providers are healthy", async () => {
    const a = new FakeProvider("a", [
      { kind: "ok", text: "a1" },
      { kind: "ok", text: "a2" },
    ]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "b1" }]);
    const r = new Router([a, b]);

    expect(await r.complete("1")).toBe("a1");
    expect(await r.complete("2")).toBe("b1");
    expect(await r.complete("3")).toBe("a2");
  });

  it("respects cooldown — skips a rate-limited provider until cooldown passes", async () => {
    let now = 1_000_000;
    const a = new FakeProvider("a", [
      { kind: "rate", retryAfterMs: 5000 },
      { kind: "ok", text: "a-after-cooldown" },
    ]);
    const b = new FakeProvider("b", [
      { kind: "ok", text: "b1" },
      { kind: "ok", text: "b2" },
    ]);
    const r = new Router([a, b], { now: () => now });

    // call 1: a 429s, falls through to b
    expect(await r.complete("1")).toBe("b1");

    // call 2: a still cooling, must go to b again
    now += 1000;
    expect(await r.complete("2")).toBe("b2");
    expect(a.calls).toHaveLength(1); // a not retried while cooling

    // call 3: cooldown expired, a is back in rotation
    now += 5000;
    expect(await r.complete("3")).toBe("a-after-cooldown");
  });

  it("throws when constructed with no providers", () => {
    expect(() => new Router([])).toThrow(NoProvidersConfiguredError);
  });

  it("AllProvidersExhaustedError lists every attempted provider id", async () => {
    const a = new FakeProvider("a", [{ kind: "rate" }]);
    const b = new FakeProvider("b", [{ kind: "rate" }]);
    const r = new Router([a, b]);

    try {
      await r.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersExhaustedError);
      const ids = (err as AllProvidersExhaustedError).attempts.map((x) => x.providerId);
      expect(ids).toEqual(["a", "b"]);
    }
  });
});
