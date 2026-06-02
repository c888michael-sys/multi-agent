import { describe, it, expect } from "vitest";
import { MistralProvider } from "../src/providers/mistral.js";
import { OpenAICompatError, toolChoiceValue } from "../src/providers/openai-compat.js";
import type { ToolDeclaration } from "../src/tools/types.js";

const sampleTools: ToolDeclaration[] = [
  {
    name: "write_file",
    description: "write a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

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

describe("MistralProvider", () => {
  it("returns text on a successful response", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "from-mistral" } }] });
    const p = new MistralProvider({
      id: "mistral:codestral",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    expect(await p.complete("hi")).toBe("from-mistral");
  });

  it("defaults to codestral-latest and posts to api.mistral.ai", async () => {
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
    const p = new MistralProvider({
      id: "mistral:codestral",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect(calledUrl).toBe("https://api.mistral.ai/v1/chat/completions");
    expect((body as { model: string }).model).toBe("codestral-latest");
  });

  it("maps toolChoice 'required' to Mistral's 'any' in completeWithTools", async () => {
    let body: any;
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "ok" } }] },
      {},
      (_url, init) => { body = init?.body ? JSON.parse(init.body as string) : undefined; },
    );
    const p = new MistralProvider({ id: "mistral:codestral", apiKey: "k", fetchImpl: f as typeof fetch });
    await p.completeWithTools([{ kind: "user_text", text: "make a file" }], sampleTools, {
      toolChoice: "required",
    });
    expect(body.tool_choice).toBe("any");
  });

  it("omits tool_choice when unset (defaults to auto)", async () => {
    let body: any;
    const f = fakeFetch(
      200,
      { choices: [{ message: { content: "ok" } }] },
      {},
      (_url, init) => { body = init?.body ? JSON.parse(init.body as string) : undefined; },
    );
    const p = new MistralProvider({ id: "mistral:codestral", apiKey: "k", fetchImpl: f as typeof fetch });
    await p.completeWithTools([{ kind: "user_text", text: "hi" }], sampleTools);
    expect(body.tool_choice).toBeUndefined();
  });

  it("toolChoiceValue maps required per dialect", () => {
    expect(toolChoiceValue("required", "mistral")).toBe("any");
    expect(toolChoiceValue("required", "openai")).toBe("required");
    expect(toolChoiceValue("auto", "mistral")).toBe("auto");
    expect(toolChoiceValue("none", "openai")).toBe("none");
    expect(toolChoiceValue(undefined, "openai")).toBeUndefined();
  });

  it("throws OpenAICompatError on non-2xx", async () => {
    const f = fakeFetch(429, "rate", { "retry-after": "8" });
    const p = new MistralProvider({
      id: "mistral:codestral",
      apiKey: "k",
      fetchImpl: f as typeof fetch,
    });
    try {
      await p.complete("hi");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAICompatError);
      expect(p.isRateLimitError(err)).toBe(true);
      expect(p.retryAfterMs(err)).toBe(8_000);
    }
  });
});
