import { describe, expect, it } from "vitest";
import { loadOllamaProviders } from "../src/config.js";
import { OllamaProvider, parseInlineToolCalls } from "../src/providers/ollama.js";
import type { ToolDeclaration } from "../src/tools/types.js";

describe("OllamaProvider", () => {
  it("forwards attached images as Ollama base64 image payloads", async () => {
    let requestBody: any;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ message: { content: "I can see it" } });
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider({
      id: "ollama:qwen",
      model: "qwen3.8:latest",
      fetchImpl,
    });

    await expect(provider.completeChat([
      {
        kind: "user_text",
        text: "What is in this image?",
        images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }],
      },
    ])).resolves.toBe("I can see it");
    expect(requestBody.messages).toEqual([
      { role: "user", content: "What is in this image?", images: ["aGVsbG8="] },
    ]);
  });

  it("forwards caller cancellation with the default unbounded deadline", async () => {
    let underlyingRequestAborted = false;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          underlyingRequestAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      })) as unknown as typeof fetch;
    const provider = new OllamaProvider({
      id: "ollama:qwen",
      model: "qwen3.8:latest",
      fetchImpl,
    });
    const controller = new AbortController();

    const pending = provider.complete("keep thinking", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingRequestAborted).toBe(true);
    expect(provider.requestTimeoutMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("retries with an installed same-family tag when the configured tag 404s", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });

      if (url.endsWith("/api/chat") && body.model === "deepseek-r1:32b") {
        return new Response(JSON.stringify({ error: "model 'deepseek-r1:32b' not found" }), {
          status: 404,
        });
      }
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [{ name: "deepseek-r1:32b-qwen-distill-q4_K_M" }],
        });
      }
      if (url.endsWith("/api/chat") && body.model === "deepseek-r1:32b-qwen-distill-q4_K_M") {
        return Response.json({ message: { content: "local answer" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({
      id: "ollama:deepseek-r1",
      model: "deepseek-r1:32b",
      fetchImpl,
    });

    await expect(provider.complete("ping")).resolves.toBe("local answer");
    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:11434/api/chat",
      "http://localhost:11434/api/tags",
      "http://localhost:11434/api/chat",
    ]);
    expect(calls[2]!.body.model).toBe("deepseek-r1:32b-qwen-distill-q4_K_M");
  });

  it("uses the same installed-tag retry for streaming chat calls", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });

      if (url.endsWith("/api/chat") && body.model === "deepseek-r1:32b") {
        return new Response(JSON.stringify({ error: "model 'deepseek-r1:32b' not found" }), {
          status: 404,
        });
      }
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [{ name: "deepseek-r1:32b-qwen-distill-q4_K_M" }],
        });
      }
      if (url.endsWith("/api/chat") && body.model === "deepseek-r1:32b-qwen-distill-q4_K_M") {
        return new Response(
          [
            JSON.stringify({ message: { content: "local " }, done: false }),
            JSON.stringify({ message: { content: "stream" }, done: true }),
          ].join("\n") + "\n",
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({
      id: "ollama:deepseek-r1",
      model: "deepseek-r1:32b",
      fetchImpl,
    });

    const tokens: string[] = [];
    const result = await provider.completeChatStream(
      [{ kind: "user_text", text: "ping" }],
      undefined,
      (text) => tokens.push(text),
    );

    expect(result).toBe("local stream");
    expect(tokens).toEqual(["local ", "stream"]);
    expect(calls[2]!.body.model).toBe("deepseek-r1:32b-qwen-distill-q4_K_M");
  });

  it("parses inline tool calls when the model emits them in completeWithTools content", async () => {
    // qwen2.5-coder emits the call as JSON text in `content`, not in `tool_calls`.
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/api/chat")) {
        return Response.json({
          message: {
            content: '{\n  "name": "bash",\n  "arguments": {\n    "command": "mkdir testing_website"\n  }\n}',
            tool_calls: [],
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({
      id: "ollama:qwen2.5-coder",
      model: "qwen2.5-coder:14b",
      fetchImpl,
    });

    const tools: ToolDeclaration[] = [
      {
        name: "bash",
        description: "run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ];
    const result = await provider.completeWithTools([{ kind: "user_text", text: "make a folder" }], tools);
    expect(result.kind).toBe("calls");
    if (result.kind === "calls") {
      expect(result.calls).toEqual([{ name: "bash", args: { command: "mkdir testing_website" } }]);
    }
  });

  it("does not alias a requested 14b model to an installed 32b model", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });

      if (url.endsWith("/api/chat") && body.model === "qwen2.5-coder:14b") {
        return new Response(JSON.stringify({ error: "model 'qwen2.5-coder:14b' not found" }), {
          status: 404,
        });
      }
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [{ name: "qwen2.5-coder:32b" }],
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({
      id: "ollama:qwen2.5-coder",
      model: "qwen2.5-coder:14b",
      fetchImpl,
    });

    await expect(provider.complete("ping")).rejects.toThrow(/qwen2\.5-coder:14b/);
    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:11434/api/chat",
      "http://localhost:11434/api/tags",
    ]);
  });
});

describe("parseInlineToolCalls", () => {
  const offered = new Set(["bash", "read_file"]);

  it("parses a bare {name, arguments} object", () => {
    const calls = parseInlineToolCalls('{"name":"bash","arguments":{"command":"ls"}}', offered);
    expect(calls).toEqual([{ name: "bash", args: { command: "ls" } }]);
  });

  it("parses a fenced ```json block", () => {
    const calls = parseInlineToolCalls('```json\n{"name":"bash","arguments":{"command":"ls"}}\n```', offered);
    expect(calls).toEqual([{ name: "bash", args: { command: "ls" } }]);
  });

  it("accepts the {name, parameters} and {tool, args} shapes", () => {
    expect(parseInlineToolCalls('{"name":"bash","parameters":{"command":"pwd"}}', offered)).toEqual([
      { name: "bash", args: { command: "pwd" } },
    ]);
    expect(parseInlineToolCalls('{"tool":"read_file","args":{"path":"a.txt"}}', offered)).toEqual([
      { name: "read_file", args: { path: "a.txt" } },
    ]);
  });

  it("parses an OpenAI-style {function:{name,arguments}} with stringified args", () => {
    const calls = parseInlineToolCalls('{"function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}', offered);
    expect(calls).toEqual([{ name: "bash", args: { command: "ls" } }]);
  });

  it("ignores JSON that names a tool we did not offer", () => {
    expect(parseInlineToolCalls('{"name":"rm_rf","arguments":{}}', offered)).toEqual([]);
  });

  it("returns [] for plain prose with no tool JSON", () => {
    expect(parseInlineToolCalls("To make a folder, run mkdir testing_website.", offered)).toEqual([]);
  });

  it("parses an array of calls", () => {
    const calls = parseInlineToolCalls(
      '[{"name":"bash","arguments":{"command":"ls"}},{"name":"read_file","arguments":{"path":"a"}}]',
      offered,
    );
    expect(calls).toEqual([
      { name: "bash", args: { command: "ls" } },
      { name: "read_file", args: { path: "a" } },
    ]);
  });

  it("does not choke on braces inside string literals", () => {
    const calls = parseInlineToolCalls('{"name":"bash","arguments":{"command":"echo {hi}"}}', offered);
    expect(calls).toEqual([{ name: "bash", args: { command: "echo {hi}" } }]);
  });
});

describe("loadOllamaProviders", () => {
  it("defaults hybrid mode to the smaller local model pair", () => {
    const oldReasoning = process.env.OLLAMA_REASONING_MODEL;
    const oldCoder = process.env.OLLAMA_CODER_MODEL;
    const oldTimeout = process.env.OLLAMA_REQUEST_TIMEOUT_MS;
    delete process.env.OLLAMA_REASONING_MODEL;
    delete process.env.OLLAMA_CODER_MODEL;
    delete process.env.OLLAMA_REQUEST_TIMEOUT_MS;
    try {
      const providers = loadOllamaProviders();
      expect(providers.find((p) => p.id === "ollama:qwen3.5-9b")?.model).toBe("qwen3.5:9b");
      expect(providers.find((p) => p.id === "ollama:qwen2.5-coder")?.model).toBe("qwen2.5-coder:14b");
      expect(providers.every((p) => p.requestTimeoutMs === Number.POSITIVE_INFINITY)).toBe(true);
    } finally {
      if (oldReasoning === undefined) delete process.env.OLLAMA_REASONING_MODEL;
      else process.env.OLLAMA_REASONING_MODEL = oldReasoning;
      if (oldCoder === undefined) delete process.env.OLLAMA_CODER_MODEL;
      else process.env.OLLAMA_CODER_MODEL = oldCoder;
      if (oldTimeout === undefined) delete process.env.OLLAMA_REQUEST_TIMEOUT_MS;
      else process.env.OLLAMA_REQUEST_TIMEOUT_MS = oldTimeout;
    }
  });

  it("allows an explicit finite local generation deadline", () => {
    const oldTimeout = process.env.OLLAMA_REQUEST_TIMEOUT_MS;
    process.env.OLLAMA_REQUEST_TIMEOUT_MS = "1234";
    try {
      expect(loadOllamaProviders().every((p) => p.requestTimeoutMs === 1234)).toBe(true);
    } finally {
      if (oldTimeout === undefined) delete process.env.OLLAMA_REQUEST_TIMEOUT_MS;
      else process.env.OLLAMA_REQUEST_TIMEOUT_MS = oldTimeout;
    }
  });

  it("allows per-role local model overrides from env", () => {
    const oldReasoning = process.env.OLLAMA_REASONING_MODEL;
    const oldCoder = process.env.OLLAMA_CODER_MODEL;
    process.env.OLLAMA_REASONING_MODEL = "qwen3.5:32b";
    process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:32b";
    try {
      const providers = loadOllamaProviders();
      expect(providers.find((p) => p.id === "ollama:qwen3.5-9b")?.model).toBe("qwen3.5:32b");
      expect(providers.find((p) => p.id === "ollama:qwen2.5-coder")?.model).toBe("qwen2.5-coder:32b");
    } finally {
      if (oldReasoning === undefined) delete process.env.OLLAMA_REASONING_MODEL;
      else process.env.OLLAMA_REASONING_MODEL = oldReasoning;
      if (oldCoder === undefined) delete process.env.OLLAMA_CODER_MODEL;
      else process.env.OLLAMA_CODER_MODEL = oldCoder;
    }
  });

  it("lets role-specific context override the global context", () => {
    const oldGlobal = process.env.OLLAMA_NUM_CTX;
    const oldReasoningCtx = process.env.OLLAMA_REASONING_NUM_CTX;
    const oldCoderCtx = process.env.OLLAMA_CODER_NUM_CTX;
    process.env.OLLAMA_NUM_CTX = "8192";
    process.env.OLLAMA_REASONING_NUM_CTX = "16384";
    process.env.OLLAMA_CODER_NUM_CTX = "32768";
    try {
      const providers = loadOllamaProviders();
      expect((providers.find((p) => p.id === "ollama:qwen3.5-9b") as any)?.numCtx).toBe(16384);
      expect((providers.find((p) => p.id === "ollama:qwen2.5-coder") as any)?.numCtx).toBe(32768);
    } finally {
      if (oldGlobal === undefined) delete process.env.OLLAMA_NUM_CTX;
      else process.env.OLLAMA_NUM_CTX = oldGlobal;
      if (oldReasoningCtx === undefined) delete process.env.OLLAMA_REASONING_NUM_CTX;
      else process.env.OLLAMA_REASONING_NUM_CTX = oldReasoningCtx;
      if (oldCoderCtx === undefined) delete process.env.OLLAMA_CODER_NUM_CTX;
      else process.env.OLLAMA_CODER_NUM_CTX = oldCoderCtx;
    }
  });
});
