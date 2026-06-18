import { describe, it, expect } from "vitest";
import { NvidiaProvider } from "../src/providers/nvidia.js";
import { OpenAICompatError } from "../src/providers/openai-compat.js";
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

describe("NvidiaProvider", () => {
  it("returns text on a successful response", async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: "from-nvidia" } }] });
    const p = new NvidiaProvider({ id: "nvidia:llama-70b", apiKey: "k", fetchImpl: f as typeof fetch });
    expect(await p.complete("hi")).toBe("from-nvidia");
  });

  it("defaults to meta/llama-3.3-70b-instruct and posts to integrate.api.nvidia.com", async () => {
    let calledUrl = "";
    let body: unknown;
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }] }, {}, (url, init) => {
      calledUrl = url;
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    });
    const p = new NvidiaProvider({ id: "nvidia:llama-70b", apiKey: "k", fetchImpl: f as typeof fetch });
    await p.complete("hi");
    expect(calledUrl).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect((body as { model: string }).model).toBe("meta/llama-3.3-70b-instruct");
  });

  it("honours an explicit model override", async () => {
    let body: any;
    const f = fakeFetch(200, { choices: [{ message: { content: "x" } }] }, {}, (_u, init) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    });
    const p = new NvidiaProvider({
      id: "nvidia:coder",
      apiKey: "k",
      model: "qwen/qwen2.5-coder-32b-instruct",
      fetchImpl: f as typeof fetch,
    });
    await p.complete("hi");
    expect(body.model).toBe("qwen/qwen2.5-coder-32b-instruct");
  });

  it("uses the OpenAI 'required' tool_choice dialect in completeWithTools", async () => {
    let body: any;
    const f = fakeFetch(200, { choices: [{ message: { content: "ok" } }] }, {}, (_u, init) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    });
    const p = new NvidiaProvider({ id: "nvidia:llama-70b", apiKey: "k", fetchImpl: f as typeof fetch });
    await p.completeWithTools([{ kind: "user_text", text: "make a file" }], sampleTools, {
      toolChoice: "required",
    });
    expect(body.tool_choice).toBe("required");
  });

  it("parses tool calls that omit the OpenAI type field", async () => {
    const f = fakeFetch(200, {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c1", function: { name: "write_file", arguments: '{"path":"a.txt"}' } },
            ],
          },
        },
      ],
    });
    const p = new NvidiaProvider({ id: "nvidia:llama-70b", apiKey: "k", fetchImpl: f as typeof fetch });
    const result = await p.completeWithTools([{ kind: "user_text", text: "go" }], sampleTools);
    expect(result.kind).toBe("calls");
    if (result.kind === "calls") {
      expect(result.calls[0]!.name).toBe("write_file");
      expect(result.calls[0]!.args).toEqual({ path: "a.txt" });
    }
  });

  it("throws OpenAICompatError on non-2xx and detects rate limits", async () => {
    const f = fakeFetch(429, "rate", { "retry-after": "8" });
    const p = new NvidiaProvider({ id: "nvidia:llama-70b", apiKey: "k", fetchImpl: f as typeof fetch });
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
