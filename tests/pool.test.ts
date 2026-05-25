// Targeted tests for the ProviderPool's snapshot fields — specifically the
// RPM sliding window, the RPD calc (success-only), and the cooldown
// countdown. The pool's pick/rotation behavior is exercised indirectly
// by the router tests; this file isolates the snapshot contract that the
// CLI and web sidebar rely on for "accurate" displays.

import { describe, it, expect } from "vitest";
import { ProviderPool } from "../src/pool.js";
import { FakeProvider } from "./fixtures.js";

describe("ProviderPool snapshot", () => {
  it("RPM counts requests in the last 60s and prunes older entries", () => {
    let t = 1_000_000;
    const pool = new ProviderPool(
      [{ provider: new FakeProvider("p:1", []), estimatedRpmCap: 15 }],
      { now: () => t },
    );

    // Three successes within ~10s — all should be in the window.
    pool.markSuccess(0);
    t += 3_000;
    pool.markSuccess(0);
    t += 3_000;
    pool.markSuccess(0);

    let snap = pool.snapshot();
    expect(snap[0]!.rpmCount).toBe(3);
    expect(snap[0]!.rpmCap).toBe(15);

    // Jump 90s forward — original entries should fall out of the window.
    t += 90_000;
    pool.markSuccess(0);
    snap = pool.snapshot();
    expect(snap[0]!.rpmCount).toBe(1);
  });

  it("RPM window includes rate-limited attempts (they hit the wire)", () => {
    let t = 2_000_000;
    const pool = new ProviderPool(
      [{ provider: new FakeProvider("p:1", []), estimatedRpmCap: 10 }],
      { now: () => t },
    );

    pool.markSuccess(0);
    t += 1_000;
    pool.markRateLimited(0, 30_000);
    t += 1_000;
    pool.markSuccess(0);

    const snap = pool.snapshot();
    expect(snap[0]!.rpmCount).toBe(3);
    expect(snap[0]!.successCount).toBe(2);
    expect(snap[0]!.rateLimitCount).toBe(1);
  });

  it("remainingPct uses SUCCESS COUNT only — rejected attempts don't deduct budget", () => {
    let t = 3_000_000;
    const pool = new ProviderPool(
      [{ provider: new FakeProvider("p:1", []), estimatedDailyBudget: 100 }],
      { now: () => t },
    );

    // 10 successes + 20 rejections.
    for (let i = 0; i < 10; i++) {
      pool.markSuccess(0);
      t += 100;
    }
    for (let i = 0; i < 20; i++) {
      pool.markRateLimited(0, 60_000);
      t += 100;
    }

    const snap = pool.snapshot();
    // 10/100 = 10% used, so 90% remaining (NOT 70% as the old calc
    // would have reported by mixing both counts).
    expect(snap[0]!.remainingPct).toBe(90);
    expect(snap[0]!.successCount).toBe(10);
    expect(snap[0]!.rateLimitCount).toBe(20);
  });

  it("cooldownMsRemaining reports milliseconds until the provider is back", () => {
    let t = 4_000_000;
    const pool = new ProviderPool([new FakeProvider("p:1", [])], { now: () => t });

    pool.markRateLimited(0, 45_000);

    let snap = pool.snapshot();
    expect(snap[0]!.cooldownMsRemaining).toBe(45_000);

    // Half the cooldown elapses.
    t += 22_500;
    snap = pool.snapshot();
    expect(snap[0]!.cooldownMsRemaining).toBe(22_500);

    // Fully expired.
    t += 25_000;
    snap = pool.snapshot();
    expect(snap[0]!.cooldownMsRemaining).toBe(0);
  });

  it("snapshot fields are present even when no caps are configured", () => {
    const pool = new ProviderPool([new FakeProvider("p:1", [])], { now: () => 1 });
    const snap = pool.snapshot();
    expect(snap[0]).toMatchObject({
      id: "p:1",
      rpmCount: 0,
      successCount: 0,
      rateLimitCount: 0,
      cooldownMsRemaining: 0,
      rpmSource: "estimated",
      rpdSource: "estimated",
    });
    expect(snap[0]!.rpmCap).toBeUndefined();
    expect(snap[0]!.estimatedDailyBudget).toBeUndefined();
    expect(snap[0]!.remainingPct).toBeUndefined();
  });

  it("snapshot prefers live quota from provider.getLastQuota() over local counters", () => {
    // FakeProvider doesn't expose getLastQuota; subclass to add one.
    const liveProvider = Object.assign(new FakeProvider("p:1", []), {
      getLastQuota() {
        return {
          rpmRemaining: 12,
          rpmCap: 30,
          rpdRemaining: 800,
          rpdCap: 1000,
          fetchedAt: 12345,
        };
      },
    });
    let t = 5_000_000;
    const pool = new ProviderPool(
      [{ provider: liveProvider, estimatedRpmCap: 99, estimatedDailyBudget: 99 }],
      { now: () => t },
    );

    // Do a couple of local marks too — live values must still win.
    pool.markSuccess(0);
    pool.markSuccess(0);
    pool.markSuccess(0);

    const snap = pool.snapshot();
    // Live: rpmCount = cap - remaining = 30 - 12 = 18 (overrides local count 3).
    expect(snap[0]!.rpmCount).toBe(18);
    expect(snap[0]!.rpmCap).toBe(30);
    expect(snap[0]!.rpmSource).toBe("live");
    // Live: rpdRemaining 800 / cap 1000 → 80% remaining (overrides local 3/99).
    expect(snap[0]!.estimatedDailyBudget).toBe(1000);
    expect(snap[0]!.remainingPct).toBe(80);
    expect(snap[0]!.rpdSource).toBe("live");
    expect(snap[0]!.liveQuotaFetchedAt).toBe(12345);
  });

  it("snapshot falls back to local counters when live quota is partial", () => {
    // Only rpmCap reported, no rpdCap — RPD should fall back to local count.
    const partialProvider = Object.assign(new FakeProvider("p:1", []), {
      getLastQuota() {
        return { rpmRemaining: 5, rpmCap: 10, fetchedAt: 1 };
      },
    });
    const pool = new ProviderPool(
      [{ provider: partialProvider, estimatedRpmCap: 99, estimatedDailyBudget: 200 }],
      { now: () => 6_000_000 },
    );
    pool.markSuccess(0);
    pool.markSuccess(0);

    const snap = pool.snapshot();
    expect(snap[0]!.rpmSource).toBe("live");
    expect(snap[0]!.rpmCount).toBe(5);  // from header (10 - 5)
    expect(snap[0]!.rpdSource).toBe("estimated");
    expect(snap[0]!.successCount).toBe(2);
    expect(snap[0]!.estimatedDailyBudget).toBe(200);
  });

  it("markRateLimited uses per-entry defaultCooldownMs when Retry-After is absent", () => {
    let t = 7_000_000;
    const pool = new ProviderPool(
      [{ provider: new FakeProvider("p:1", []), defaultCooldownMs: 10_000 }],
      { now: () => t },
    );
    pool.markRateLimited(0, null);

    const snap = pool.snapshot();
    // Per-entry default beat the global 60s.
    expect(snap[0]!.cooldownMsRemaining).toBe(10_000);
  });
});
