import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import {
  FileStateStore,
  InMemoryStateStore,
  utcDay,
  emptyUsage,
  rollover,
} from "../src/state.js";
import { FakeProvider } from "./fixtures.js";

describe("state.ts unit helpers", () => {
  it("rollover keeps counters when day is unchanged", () => {
    const u = { successCount: 5, rateLimitCount: 2, cooldownUntil: 1234, lastResetUtcDay: "2026-05-22" };
    expect(rollover(u, "2026-05-22")).toBe(u); // same reference, untouched
  });

  it("rollover resets counters when day has changed; cooldown preserved", () => {
    const u = { successCount: 5, rateLimitCount: 2, cooldownUntil: 1234, lastResetUtcDay: "2026-05-22" };
    const r = rollover(u, "2026-05-23");
    expect(r.successCount).toBe(0);
    expect(r.rateLimitCount).toBe(0);
    expect(r.cooldownUntil).toBe(1234);
    expect(r.lastResetUtcDay).toBe("2026-05-23");
  });

  it("utcDay returns YYYY-MM-DD", () => {
    expect(utcDay(Date.UTC(2026, 4, 22, 23, 59, 0))).toBe("2026-05-22");
    expect(utcDay(Date.UTC(2026, 4, 23, 0, 1, 0))).toBe("2026-05-23");
  });

  it("emptyUsage carries the given day", () => {
    expect(emptyUsage("2026-05-22").lastResetUtcDay).toBe("2026-05-22");
  });
});

describe("Router with InMemoryStateStore", () => {
  it("persists counters across two Router instances backed by the same store", async () => {
    const store = new InMemoryStateStore();

    const a = new FakeProvider("a", [{ kind: "ok", text: "x" }]);
    const r1 = new Router([a], { stateStore: store, maxRetryWaitMs: 0 });
    await r1.complete("hi");

    // Second router instance sees the success carried over.
    const b = new FakeProvider("a", [{ kind: "ok", text: "y" }]); // same id
    const r2 = new Router([b], { stateStore: store, maxRetryWaitMs: 0 });
    expect(r2.snapshot()[0]!.successCount).toBe(1);

    await r2.complete("hi");
    expect(r2.snapshot()[0]!.successCount).toBe(2);
  });

  it("resets counters on UTC-day change", () => {
    const store = new InMemoryStateStore();
    store.save({
      a: { successCount: 10, rateLimitCount: 3, cooldownUntil: 0, lastResetUtcDay: "2026-05-21" },
    });

    const fakeNow = () => Date.UTC(2026, 4, 22, 12, 0, 0); // 2026-05-22 noon UTC
    const provider = new FakeProvider("a", []);
    const r = new Router([provider], { stateStore: store, now: fakeNow });

    const snap = r.snapshot()[0]!;
    expect(snap.successCount).toBe(0); // rolled over
    expect(snap.rateLimitCount).toBe(0); // rolled over

    // The persisted state has been rewritten with today's date.
    expect(store.load().a!.lastResetUtcDay).toBe("2026-05-22");
  });

  it("preserves cooldown across instances even after rollover", () => {
    const store = new InMemoryStateStore();
    const futureCooldown = Date.UTC(2026, 4, 23, 0, 0, 0); // tomorrow's midnight
    store.save({
      a: {
        successCount: 5,
        rateLimitCount: 1,
        cooldownUntil: futureCooldown,
        lastResetUtcDay: "2026-05-22",
      },
    });
    const fakeNow = () => Date.UTC(2026, 4, 22, 12, 0, 0);
    const provider = new FakeProvider("a", []);
    const r = new Router([provider], { stateStore: store, now: fakeNow });

    expect(r.snapshot()[0]!.cooldownUntil).toBe(futureCooldown);
  });
});

describe("FileStateStore", () => {
  let tmpDir: string;
  let path: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multiagent-state-"));
    path = join(tmpDir, "nested", "state.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns {} when the file doesn't exist", () => {
    const store = new FileStateStore(path);
    expect(store.load()).toEqual({});
  });

  it("creates the parent directory and writes JSON", () => {
    const store = new FileStateStore(path);
    store.save({ a: emptyUsage("2026-05-22") });
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.providers.a.lastResetUtcDay).toBe("2026-05-22");
  });

  it("round-trips state through save/load", () => {
    const store = new FileStateStore(path);
    const initial = {
      a: { successCount: 7, rateLimitCount: 1, cooldownUntil: 99999, lastResetUtcDay: "2026-05-22" },
    };
    store.save(initial);
    expect(store.load()).toEqual(initial);
  });

  it("falls back to {} on corrupt JSON instead of crashing", () => {
    const store = new FileStateStore(path);
    // Write garbage directly via save's directory creation, then overwrite.
    store.save({});
    require("node:fs").writeFileSync(path, "{ not valid json", "utf8");
    const originalErr = console.error;
    console.error = () => {}; // silence expected warning
    try {
      expect(store.load()).toEqual({});
    } finally {
      console.error = originalErr;
    }
  });
});
