import { describe, it, expect } from "vitest";
import { Router } from "../src/router.js";
import { ConservationPolicy } from "../src/conservation.js";
import { FakeProvider } from "./fixtures.js";

describe("ConservationPolicy", () => {
  it("does nothing when no providers have budget info", () => {
    const a = new FakeProvider("a", []);
    const r = new Router([a]); // no estimatedDailyBudget
    const p = new ConservationPolicy(r);

    const status = p.tick();
    expect(status.aggregateRemainingPct).toBeNull();
    expect(status.mode).toBe("round-robin"); // untouched
  });

  it("switches to serial when aggregate remaining drops below threshold", async () => {
    const a = new FakeProvider("a", [
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
    ]);
    const b = new FakeProvider("b", [
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
      { kind: "ok", text: "x" },
    ]);
    // Tiny budget so we cross threshold fast: 5 requests per provider.
    const r = new Router([
      { provider: a, estimatedDailyBudget: 5 },
      { provider: b, estimatedDailyBudget: 5 },
    ]);
    const policy = new ConservationPolicy(r, { thresholdPct: 25, releasePct: 50 });

    // Burn 4 of 5 on each (round-robin distributes so 4 calls => 2 each, then 4 more => 4 each)
    for (let i = 0; i < 8; i++) await r.complete("hi");
    const status = policy.tick();
    expect(status.aggregateRemainingPct).toBeLessThan(25);
    expect(status.mode).toBe("serial");
    expect(r.getMode()).toBe("serial");
  });

  it("recovers to round-robin only after the release threshold (hysteresis)", () => {
    const a = new FakeProvider("a", []);
    const b = new FakeProvider("b", []);
    const r = new Router(
      [
        { provider: a, estimatedDailyBudget: 100 },
        { provider: b, estimatedDailyBudget: 100 },
      ],
      { mode: "serial" }, // start in serial
    );
    const policy = new ConservationPolicy(r, { thresholdPct: 25, releasePct: 50 });

    // 80% remaining (above releasePct) → should switch back to round-robin
    const status = policy.tick();
    expect(status.aggregateRemainingPct).toBe(100);
    expect(status.mode).toBe("round-robin");
  });

  it("rejects misconfigured hysteresis (release <= threshold)", () => {
    const a = new FakeProvider("a", []);
    const r = new Router([a]);
    expect(() => new ConservationPolicy(r, { thresholdPct: 50, releasePct: 50 })).toThrow();
    expect(() => new ConservationPolicy(r, { thresholdPct: 50, releasePct: 30 })).toThrow();
  });
});

describe("Router pool extensions", () => {
  it("snapshot records success counts and remaining %", async () => {
    const a = new FakeProvider("a", [{ kind: "ok", text: "x" }]);
    const r = new Router([{ provider: a, estimatedDailyBudget: 10 }]);

    await r.complete("hi");
    const snap = r.snapshot();
    expect(snap[0]!.successCount).toBe(1);
    expect(snap[0]!.remainingPct).toBe(90);
  });

  it("serial mode reuses the first available provider instead of rotating", async () => {
    const a = new FakeProvider("a", [
      { kind: "ok", text: "a1" },
      { kind: "ok", text: "a2" },
      { kind: "ok", text: "a3" },
    ]);
    const b = new FakeProvider("b", [{ kind: "ok", text: "b1" }]);
    const r = new Router([a, b], { mode: "serial" });

    await r.complete("1");
    await r.complete("2");
    await r.complete("3");
    expect(a.calls).toHaveLength(3);
    expect(b.calls).toHaveLength(0); // never touched while a is healthy
  });
});
