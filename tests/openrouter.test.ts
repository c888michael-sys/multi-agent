import { describe, it, expect } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
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

describe("OpenRouterProvider.complete", () => {
  it("returns text from a successful response", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "from-router" } }] });
    const p = new OpenRouterProvider({
      id: "openrouter:test",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    expect(await p.complete("hi")).toBe("from-router");
  });

  it("hits the /chat/completions endpoint on the configured baseUrl", async () => {
    let calledUrl = "";
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "x" } }] },
      {},
      (url) => {
        calledUrl = url;
      },
    );
    const p = new OpenRouterProvider({
      id: "x",
      apiKey: "k",
      baseUrl: "https://custom.example/v1",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect(calledUrl).toBe("https://custom.example/v1/chat/completions");
  });

  it("sends attribution headers when appName / appUrl are provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "x" } }] },
      {},
      (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
      },
    );
    const p = new OpenRouterProvider({
      id: "x",
      apiKey: "k",
      appName: "test-app",
      appUrl: "https://example.test",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect(capturedHeaders?.["HTTP-Referer"]).toBe("https://example.test");
    expect(capturedHeaders?.["X-Title"]).toBe("test-app");
  });

  it("defaults to qwen3-next-80b model", async () => {
    let sentBody: unknown;
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "x" } }] },
      {},
      (_url, init) => {
        sentBody = init?.body ? JSON.parse(init.body as string) : undefined;
      },
    );
    const p = new OpenRouterProvider({
      id: "openrouter:qwen3-next-80b",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect((sentBody as { model: string }).model).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
  });

  it("throws OpenAICompatError on non-2xx response", async () => {
    const f = fakeFetch(429, { error: "rate" }, { "retry-after": "30" });
    const p = new OpenRouterProvider({
      id: "x",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    try {
      await p.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAICompatError);
      expect(p.isRateLimitError(err)).toBe(true);
      expect(p.retryAfterMs(err)).toBe(30_000);
    }
  });
});
