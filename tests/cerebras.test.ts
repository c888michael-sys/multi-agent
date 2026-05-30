import { describe, it, expect } from "vitest";
import { CerebrasProvider } from "../src/providers/cerebras.js";
import { OpenAICompatError } from "../src/providers/openai-compat.js";

function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  captureRequest?: (url: string, init?: RequestInit) => void,
) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (captureRequest) captureRequest(String(url), init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: new Headers(headers),
    });
  };
}

describe("CerebrasProvider", () => {
  it("returns text on a successful response", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "from-cerebras" } }] });
    const p = new CerebrasProvider({
      id: "cerebras:gpt-oss-120b",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    expect(await p.complete("hi")).toBe("from-cerebras");
  });

  it("defaults to gpt-oss-120b and posts to api.cerebras.ai", async () => {
    let calledUrl = "";
    let body: unknown;
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "x" } }] },
      {},
      (url, init) => {
        calledUrl = url;
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      },
    );
    const p = new CerebrasProvider({
      id: "cerebras:gpt-oss-120b",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect(calledUrl).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect((body as { model: string }).model).toBe("gpt-oss-120b");
  });

  it("throws OpenAICompatError on non-2xx response", async () => {
    const f = fakeFetch(429, "rate", { "retry-after": "5" });
    const p = new CerebrasProvider({
      id: "cerebras:gpt-oss-120b",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    try {
      await p.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAICompatError);
      expect(p.isRateLimitError(err)).toBe(true);
      expect(p.retryAfterMs(err)).toBe(5_000);
    }
  });
});
