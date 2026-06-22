import { describe, it, expect } from "vitest";
import {
  GroqProvider,
  GroqError,
  historyToOpenAIMessages,
  parseOpenAIToolResponse,
} from "../src/providers/groq.js";

/** Build a fake fetch that returns a scripted JSON response. */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const hdrs = new Headers(headers);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: hdrs,
    });
  };
}

describe("GroqProvider.complete", () => {
  it("returns the text from a successful response", async () => {
    const fetchImpl = fakeFetch(200, {
      choices: [{ message: { content: "hello-from-groq" } }],
    });
    const p = new GroqProvider({ id: "g", apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    expect(await p.complete("hi")).toBe("hello-from-groq");
  });

  it("throws GroqError with status on non-2xx response", async () => {
    const fetchImpl = fakeFetch(429, { error: { message: "rate_limit" } });
    const p = new GroqProvider({ id: "g", apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    await expect(p.complete("hi")).rejects.toBeInstanceOf(GroqError);
  });

  it("captures retry-after header on errors", async () => {
    const fetchImpl = fakeFetch(429, { error: "rate" }, { "retry-after": "12" });
    const p = new GroqProvider({ id: "g", apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    try {
      await p.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GroqError);
      expect(p.retryAfterMs(err)).toBe(12_000);
    }
  });
});

describe("GroqProvider.isRateLimitError", () => {
  const p = new GroqProvider({ id: "g", apiKey: "k" });

  it("classifies 429 via status field", () => {
    expect(p.isRateLimitError({ status: 429 })).toBe(true);
  });

  it("classifies via message keywords", () => {
    expect(p.isRateLimitError({ message: "rate_limit exceeded" })).toBe(true);
    expect(p.isRateLimitError({ message: "Quota exhausted" })).toBe(true);
  });

  it("rejects non-rate-limit errors", () => {
    expect(p.isRateLimitError({ status: 500 })).toBe(false);
    expect(p.isRateLimitError(new Error("invalid request"))).toBe(false);
  });
});

describe("historyToOpenAIMessages", () => {
  it("maps each conversation part to the OpenAI message shape", () => {
    const messages = historyToOpenAIMessages([
      { kind: "user_text", text: "hi" },
      {
        kind: "model_calls",
        calls: [{ name: "read", args: { path: "a.txt" }, toolCallId: "call_abc" }],
      },
      { kind: "tool_result", name: "read", result: "file content", toolCallId: "call_abc" },
      { kind: "model_text", text: "done" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "file content" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("emits the vision content array (text + image_url data URL) for an image turn", () => {
    const messages = historyToOpenAIMessages([
      {
        kind: "user_text",
        text: "describe this",
        images: [{ mimeType: "image/jpeg", dataBase64: "ZZZZ" }],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZZZ" } },
        ],
      },
    ]);
  });

  it("keeps plain-string content when a user turn has no images", () => {
    const messages = historyToOpenAIMessages([{ kind: "user_text", text: "hi" }]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("generates synthetic tool_call_ids when none provided", () => {
    const messages = historyToOpenAIMessages([
      { kind: "model_calls", calls: [{ name: "foo", args: {} }] },
      { kind: "tool_result", name: "foo", result: "ok" },
    ]);
    const first = messages[0] as { tool_calls: Array<{ id: string }> };
    const second = messages[1] as { tool_call_id: string };
    expect(first.tool_calls[0]!.id).toMatch(/^call_/);
    expect(second.tool_call_id).toMatch(/^call_/);
  });
});

describe("parseOpenAIToolResponse", () => {
  it("returns text when no tool_calls present", () => {
    expect(
      parseOpenAIToolResponse({
        choices: [{ message: { content: "hello" } }],
      }),
    ).toEqual({ kind: "text", text: "hello" });
  });

  it("returns calls when tool_calls are present, capturing toolCallId", () => {
    const result = parseOpenAIToolResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_xyz",
                type: "function",
                function: { name: "list_dir", arguments: '{"path":"."}' },
              },
            ],
          },
        },
      ],
    });
    expect(result).toEqual({
      kind: "calls",
      calls: [{ name: "list_dir", args: { path: "." }, toolCallId: "call_xyz" }],
    });
  });

  it("falls back to empty args on non-JSON arguments rather than throwing", () => {
    const result = parseOpenAIToolResponse({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: { name: "f", arguments: "{ not json" },
              },
            ],
          },
        },
      ],
    });
    expect(result).toEqual({ kind: "calls", calls: [{ name: "f", args: {}, toolCallId: "x" }] });
  });

  it("returns empty text when neither content nor tool_calls are present", () => {
    expect(parseOpenAIToolResponse({ choices: [{ message: {} }] })).toEqual({
      kind: "text",
      text: "",
    });
  });
});
