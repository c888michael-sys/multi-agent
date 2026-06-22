import { describe, it, expect } from "vitest";
import {
  GeminiProvider,
  appendSources,
  historyToGeminiContents,
  parseToolResponse,
  parseGeminiRetryDelayMs,
} from "../src/providers/gemini.js";

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
    expect(p.isRateLimitError({ status: 503 })).toBe(true);
    expect(p.isRateLimitError(new Error("503 Service Unavailable: high demand"))).toBe(true);
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

describe("historyToGeminiContents", () => {
  it("maps each conversation part to the right Gemini Content shape", () => {
    const contents = historyToGeminiContents([
      { kind: "user_text", text: "hi" },
      { kind: "model_calls", calls: [{ name: "read", args: { path: "a.txt" } }] },
      { kind: "tool_result", name: "read", result: "file content" },
      { kind: "model_text", text: "done" },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read", response: { result: "file content" } } }],
      },
      { role: "model", parts: [{ text: "done" }] },
    ]);
  });

  it("appends inlineData parts for images on a user turn", () => {
    const contents = historyToGeminiContents([
      {
        kind: "user_text",
        text: "what is this?",
        images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
      },
    ]);
    expect(contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "what is this?" },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("re-attaches thoughtSignature on model_calls when present", () => {
    const contents = historyToGeminiContents([
      {
        kind: "model_calls",
        calls: [{ name: "read", args: { path: "a.txt" }, signature: "sig-xyz" }],
      },
    ]);
    expect(contents).toEqual([
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "read", args: { path: "a.txt" } },
            thoughtSignature: "sig-xyz",
          },
        ],
      },
    ]);
  });
});

describe("parseToolResponse", () => {
  it("returns text when response has only text parts", () => {
    const res = parseToolResponse({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    });
    expect(res).toEqual({ kind: "text", text: "hello" });
  });

  it("returns calls when response has function calls", () => {
    const res = parseToolResponse({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "read_file", args: { path: "x.txt" } } }],
          },
        },
      ],
    });
    expect(res).toEqual({
      kind: "calls",
      calls: [{ name: "read_file", args: { path: "x.txt" } }],
    });
  });

  it("captures thoughtSignature from each functionCall part", () => {
    const res = parseToolResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "list_dir", args: { path: "." } },
                thoughtSignature: "sig-abc",
              },
            ],
          },
        },
      ],
    });
    expect(res).toEqual({
      kind: "calls",
      calls: [{ name: "list_dir", args: { path: "." }, signature: "sig-abc" }],
    });
  });

  it("falls back to response.text() when parts are empty/missing", () => {
    const res = parseToolResponse({ text: () => "fallback" });
    expect(res).toEqual({ kind: "text", text: "fallback" });
  });

  it("concatenates multiple text parts", () => {
    const res = parseToolResponse({
      candidates: [{ content: { parts: [{ text: "ab" }, { text: "cd" }] } }],
    });
    expect(res).toEqual({ kind: "text", text: "abcd" });
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

  it("parses embedded RetryInfo JSON from a Gemini 429 message", () => {
    // Realistic shape — same array the SDK serializes into the error
    // message text on quota-exceeded.
    const msg =
      `[429 Too Many Requests] You exceeded your current quota. ` +
      `Please retry in 35.908251991s. ` +
      `[{"@type":"type.googleapis.com/google.rpc.Help","links":[]},` +
      `{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"35s"}]`;
    const err = new Error(msg);
    expect(p.retryAfterMs(err)).toBe(35_000);
  });

  it("falls back to the English 'retry in X.Ys' phrase when JSON isn't there", () => {
    const err = new Error("Quota exceeded. Please retry in 12.5s.");
    expect(p.retryAfterMs(err)).toBe(12_500);
  });
});

describe("parseGeminiRetryDelayMs (unit)", () => {
  it("returns null for empty / unrelated messages", () => {
    expect(parseGeminiRetryDelayMs("")).toBeNull();
    expect(parseGeminiRetryDelayMs("some other error")).toBeNull();
  });

  it("parses RetryInfo with seconds units", () => {
    const msg = `prefix [{"@type":"google.rpc.RetryInfo","retryDelay":"45s"}] suffix`;
    expect(parseGeminiRetryDelayMs(msg)).toBe(45_000);
  });

  it("parses RetryInfo with millisecond units", () => {
    const msg = `[{"@type":"google.rpc.RetryInfo","retryDelay":"1500ms"}]`;
    expect(parseGeminiRetryDelayMs(msg)).toBe(1_500);
  });

  it("parses RetryInfo with fractional seconds", () => {
    const msg = `[{"@type":"google.rpc.RetryInfo","retryDelay":"2.5s"}]`;
    expect(parseGeminiRetryDelayMs(msg)).toBe(2_500);
  });

  it("ignores malformed JSON and falls through to English", () => {
    const msg = `Please retry in 7s. (broken json [{not valid)`;
    expect(parseGeminiRetryDelayMs(msg)).toBe(7_000);
  });
});
