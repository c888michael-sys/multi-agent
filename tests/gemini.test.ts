import { describe, it, expect } from "vitest";
import { GeminiProvider, appendSources } from "../src/providers/gemini.js";

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

describe("appendSources", () => {
  it("returns text unchanged when no groundingMetadata is present", () => {
    expect(appendSources("hi", {})).toBe("hi");
    expect(appendSources("hi", { candidates: [{}] })).toBe("hi");
  });

  it("appends a Sources block with unique URIs", () => {
    const response = {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://a.example", title: "A" } },
              { web: { uri: "https://b.example", title: "B" } },
              { web: { uri: "https://a.example", title: "A dup" } }, // deduped
            ],
          },
        },
      ],
    };
    const out = appendSources("the answer", response);
    expect(out).toContain("the answer");
    expect(out).toContain("Sources:");
    expect(out).toContain("[A](https://a.example)");
    expect(out).toContain("[B](https://b.example)");
    // Dup not repeated
    expect(out.match(/https:\/\/a\.example/g)).toHaveLength(1);
  });

  it("includes search queries when present", () => {
    const response = {
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["what is X", "X vs Y"],
            groundingChunks: [{ web: { uri: "https://x.com", title: "X" } }],
          },
        },
      ],
    };
    expect(appendSources("answer", response)).toContain("searched: what is X | X vs Y");
  });

  it("falls back to text on garbage response shape", () => {
    expect(appendSources("hi", null)).toBe("hi");
    expect(appendSources("hi", { candidates: "wrong type" })).toBe("hi");
  });

  it("uses URI as title when title is missing", () => {
    const response = {
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://x.com" } }] } }],
    };
    expect(appendSources("a", response)).toContain("[https://x.com](https://x.com)");
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
