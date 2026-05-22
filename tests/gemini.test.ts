import { describe, it, expect } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.js";

describe("GeminiProvider.isRateLimitError", () => {
  const p = new GeminiProvider({ id: "x", apiKey: "dummy" });

  it("detects 429 via status field", () => {
    expect(p.isRateLimitError({ status: 429 })).toBe(true);
  });

  it("detects 429 via statusCode field", () => {
    expect(p.isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("detects 429 via response.status", () => {
    expect(p.isRateLimitError({ response: { status: 429 } })).toBe(true);
  });

  it("detects rate-limit message strings", () => {
    expect(p.isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
    expect(p.isRateLimitError(new Error("Rate limit exceeded"))).toBe(true);
    expect(p.isRateLimitError(new Error("Quota exceeded for model"))).toBe(true);
    expect(p.isRateLimitError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
  });

  it("ignores non-rate-limit errors", () => {
    expect(p.isRateLimitError(new Error("invalid api key"))).toBe(false);
    expect(p.isRateLimitError({ status: 500 })).toBe(false);
    expect(p.isRateLimitError(null)).toBe(false);
  });
});

describe("GeminiProvider.retryAfterMs", () => {
  const p = new GeminiProvider({ id: "x", apiKey: "dummy" });

  it("parses retry-after header in seconds", () => {
    expect(p.retryAfterMs({ headers: { "retry-after": "30" } })).toBe(30_000);
  });

  it("returns null when no retry-after info is present", () => {
    expect(p.retryAfterMs(new Error("nope"))).toBeNull();
  });
});
