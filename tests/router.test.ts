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
    const r = new Router([a, b], { maxRetryWaitMs: 0 }); // opt out of backoff for this test

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
    const r = new Router([a, b], { maxRetryWaitMs: 0 });

    try {
      await r.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersExhaustedError);
      const ids = (err as AllProvidersExhaustedError).attempts.map((x) => x.providerId);
      expect(ids).toEqual(["a", "b"]);
    }
  });

  it("times out a stalled provider request and fails over", async () => {
    let signalAborted = false;
    const stalled = {
      id: "stalled",
      model: "fake-model",
      complete: (_prompt: string, opts?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            signalAborted = true;
          });
        }),
      isRateLimitError: () => false,
      retryAfterMs: () => null,
    };
    const fallback = new FakeProvider("fallback", [{ kind: "ok", text: "fallback ok" }]);
    const r = new Router([stalled, fallback], { requestTimeoutMs: 20 });

    await expect(r.complete("hi")).resolves.toBe("fallback ok");
    expect(signalAborted).toBe(true);
  });

  it("uses provider-specific request timeouts when supplied", async () => {
    let signalAborted = false;
    const stalled = {
      id: "slow-local",
      model: "fake-local-model",
      requestTimeoutMs: 60,
      complete: (_prompt: string, opts?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            signalAborted = true;
          });
        }),
      isRateLimitError: () => false,
      retryAfterMs: () => null,
    };
    const fallback = new FakeProvider("fallback", [{ kind: "ok", text: "fallback ok" }]);
    const r = new Router([stalled, fallback], { requestTimeoutMs: 10 });

    const started = Date.now();
    await expect(r.complete("hi")).resolves.toBe("fallback ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(signalAborted).toBe(true);
  });

  it("rejects promptly when the caller aborts a stalled provider request", async () => {
    const controller = new AbortController();
    let signalAborted = false;
    const stalled = {
      id: "stalled",
      model: "fake-model",
      complete: (_prompt: string, opts?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            signalAborted = true;
          });
        }),
      isRateLimitError: () => false,
      retryAfterMs: () => null,
    };
    const r = new Router([stalled], { requestTimeoutMs: 60_000 });

    const pending = r.complete("hi", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signalAborted).toBe(true);
  });
});

describe("Router — backoff retry when all providers cooled", () => {
  it("waits for earliestAvailable, then retries successfully", async () => {
    let now = 1_000_000;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      now += ms;
    };

    // Provider rate-limits with a 500ms retry-after, then succeeds on second attempt.
    const a = new FakeProvider("a", [
      { kind: "rate", retryAfterMs: 500 },
      { kind: "ok", text: "succeeded after wait" },
    ]);

    const r = new Router([a], {
      now: () => now,
      sleep,
      jitterMs: () => 0,
      maxRetryWaitMs: 60_000,
    });

    const result = await r.complete("hi");
    expect(result).toBe("succeeded after wait");
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(500); // exact recovery window, no jitter (mocked to 0)
    expect(a.calls).toHaveLength(2); // initial + retry
  });

  it("gives up and throws when total wait would exceed maxRetryWaitMs", async () => {
    let now = 1_000_000;
    const sleep = async (ms: number) => {
      now += ms;
    };

    // Provider stays rate-limited with a 90s recovery (longer than our cap).
    const a = new FakeProvider("a", [{ kind: "rate", retryAfterMs: 90_000 }]);
    const r = new Router([a], {
      now: () => now,
      sleep,
      jitterMs: () => 0,
      maxRetryWaitMs: 60_000,
    });

    await expect(r.complete("hi")).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(a.calls).toHaveLength(1); // didn't retry — knew wait would exceed cap
  });

  it("retries across all providers in the pool, eventually succeeding", async () => {
    let now = 1_000_000;
    const sleep = async (ms: number) => {
      now += ms;
    };

    // Both 429 with different recovery windows; b recovers first.
    const a = new FakeProvider("a", [
      { kind: "rate", retryAfterMs: 1000 },
      { kind: "ok", text: "a-recovered" },
    ]);
    const b = new FakeProvider("b", [
      { kind: "rate", retryAfterMs: 800 },
      { kind: "ok", text: "b-recovered" },
    ]);

    const r = new Router([a, b], {
      now: () => now,
      sleep,
      jitterMs: () => 0,
      maxRetryWaitMs: 60_000,
    });

    // After sleep(800), b is ready first and gets picked.
    expect(await r.complete("hi")).toBe("b-recovered");
  });

  it("respects maxRetryWaitMs=0 (legacy fail-fast behavior)", async () => {
    const a = new FakeProvider("a", [{ kind: "rate", retryAfterMs: 100 }]);
    const r = new Router([a], { maxRetryWaitMs: 0 });
    await expect(r.complete("hi")).rejects.toBeInstanceOf(AllProvidersExhaustedError);
  });

  it("retries when cooldown is at the cap boundary (previously gave up due to off-by-jitter)", async () => {
    let now = 1_000_000;
    const sleep = async (ms: number) => {
      now += ms;
    };
    // Cooldown 60s; cap 90s. Should comfortably retry.
    const a = new FakeProvider("a", [
      { kind: "rate", retryAfterMs: 60_000 },
      { kind: "ok", text: "recovered" },
    ]);
    const r = new Router([a], {
      now: () => now,
      sleep,
      jitterMs: () => 250,
      maxRetryWaitMs: 90_000,
    });
    expect(await r.complete("hi")).toBe("recovered");
  });
});
