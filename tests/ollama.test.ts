import { describe, expect, it } from "vitest";
import { loadOllamaProviders } from "../src/config.js";
import { OllamaProvider } from "../src/providers/ollama.js";

describe("OllamaProvider", () => {
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

describe("loadOllamaProviders", () => {
  it("defaults hybrid mode to the smaller local model pair", () => {
    const oldReasoning = process.env.OLLAMA_REASONING_MODEL;
    const oldCoder = process.env.OLLAMA_CODER_MODEL;
    delete process.env.OLLAMA_REASONING_MODEL;
    delete process.env.OLLAMA_CODER_MODEL;
    try {
      const providers = loadOllamaProviders();
      expect(providers.find((p) => p.id === "ollama:deepseek-r1")?.model).toBe("deepseek-r1:14b");
      expect(providers.find((p) => p.id === "ollama:qwen2.5-coder")?.model).toBe("qwen2.5-coder:14b");
    } finally {
      if (oldReasoning === undefined) delete process.env.OLLAMA_REASONING_MODEL;
      else process.env.OLLAMA_REASONING_MODEL = oldReasoning;
      if (oldCoder === undefined) delete process.env.OLLAMA_CODER_MODEL;
      else process.env.OLLAMA_CODER_MODEL = oldCoder;
    }
  });

  it("allows per-role local model overrides from env", () => {
    const oldReasoning = process.env.OLLAMA_REASONING_MODEL;
    const oldCoder = process.env.OLLAMA_CODER_MODEL;
    process.env.OLLAMA_REASONING_MODEL = "deepseek-r1:32b";
    process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:32b";
    try {
      const providers = loadOllamaProviders();
      expect(providers.find((p) => p.id === "ollama:deepseek-r1")?.model).toBe("deepseek-r1:32b");
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
      expect((providers.find((p) => p.id === "ollama:deepseek-r1") as any)?.numCtx).toBe(16384);
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
