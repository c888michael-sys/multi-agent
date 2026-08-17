import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listModelsForProvider } from "../src/models/provider-models.js";
import { classifyModelBilling } from "../src/models/model-billing.js";

function jsonFetch(payload: unknown, capture?: (url: string) => void) {
  return async (url: string | URL | Request): Promise<Response> => {
    if (capture) capture(String(url));
    return new Response(JSON.stringify(payload), { status: 200, headers: new Headers() });
  };
}

describe("listModelsForProvider", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function cacheDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "multi-agent-models-cache-"));
    dirs.push(dir);
    return dir;
  }

  it("maps an OpenAI-compatible /v1/models response (nvidia)", async () => {
    let calledUrl = "";
    const f = jsonFetch(
      {
        data: [
          { id: "meta/llama-3.3-70b-instruct", context_length: 131072, created: 100 },
          { id: "qwen/qwen2.5-coder-32b-instruct", context_window: 32768 },
        ],
      },
      (u) => { calledUrl = u; },
    );
    const result = await listModelsForProvider("nvidia", {
      apiKey: "k",
      fetchImpl: f as typeof fetch,
      cacheDir: cacheDir(),
      refresh: true,
    });
    expect(calledUrl).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(result.source).toBe("live");
    expect(result.models.map((m) => m.id)).toContain("meta/llama-3.3-70b-instruct");
    const coder = result.models.find((m) => m.id === "qwen/qwen2.5-coder-32b-instruct");
    expect(coder?.contextLength).toBe(32768);
  });

  it("filters Gemini models to generateContent and strips the models/ prefix", async () => {
    const f = jsonFetch({
      models: [
        {
          name: "models/gemini-2.0-flash",
          displayName: "Gemini 2.0 Flash",
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/embedding-001",
          displayName: "Embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    });
    const result = await listModelsForProvider("gemini", {
      apiKey: "k",
      fetchImpl: f as typeof fetch,
      cacheDir: cacheDir(),
      refresh: true,
    });
    expect(result.models.map((m) => m.id)).toEqual(["gemini-2.0-flash"]);
    expect(result.models[0]!.name).toBe("Gemini 2.0 Flash");
    expect(result.models[0]!.contextLength).toBe(1000000);
  });

  it("lists locally-installed Ollama models from /api/tags", async () => {
    let calledUrl = "";
    const f = jsonFetch(
      { models: [{ name: "qwen2.5-coder:14b" }, { name: "llama3.1:8b" }] },
      (u) => { calledUrl = u; },
    );
    const result = await listModelsForProvider("ollama", {
      fetchImpl: f as typeof fetch,
      cacheDir: cacheDir(),
      refresh: true,
    });
    expect(calledUrl).toContain("/api/tags");
    expect(result.models.map((m) => m.id)).toEqual(["llama3.1:8b", "qwen2.5-coder:14b"]);
  });

  it("serves from cache on the second call without re-fetching", async () => {
    const dir = cacheDir();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await listModelsForProvider("groq", { apiKey: "k", fetchImpl: f, cacheDir: dir, refresh: true });
    const second = await listModelsForProvider("groq", { apiKey: "k", fetchImpl: f, cacheDir: dir });
    expect(calls).toBe(1);
    expect(second.source).toBe("cache");
    expect(second.models[0]!.id).toBe("model-a");
  });

  it("falls back to stale cache when a live refresh fails", async () => {
    const dir = cacheDir();
    const ok = jsonFetch({ data: [{ id: "model-a" }] });
    await listModelsForProvider("groq", { apiKey: "k", fetchImpl: ok as typeof fetch, cacheDir: dir, refresh: true });
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await listModelsForProvider("groq", {
      apiKey: "k",
      fetchImpl: boom,
      cacheDir: dir,
      refresh: true,
    });
    expect(result.source).toBe("cache");
    expect(result.models[0]!.id).toBe("model-a");
  });

  it("keeps a successful live result when its cache cannot be written", async () => {
    const parent = cacheDir();
    const blockedCachePath = join(parent, "not-a-directory");
    writeFileSync(blockedCachePath, "file", "utf8");

    const result = await listModelsForProvider("groq", {
      apiKey: "k",
      fetchImpl: jsonFetch({ data: [{ id: "fresh-model" }] }) as typeof fetch,
      cacheDir: blockedCachePath,
      refresh: true,
    });

    expect(result.source).toBe("live");
    expect(result.models[0]!.id).toBe("fresh-model");
  });

  it("labels local and known free models while failing closed for unknown pricing", () => {
    expect(classifyModelBilling("ollama", "qwen3.8:latest")).toMatchObject({ class: "local", publicEligible: true });
    expect(classifyModelBilling("openrouter", "qwen/model:free")).toMatchObject({ class: "free", publicEligible: true });
    expect(classifyModelBilling("groq", "llama-3.3-70b-versatile")).toMatchObject({ class: "free-tier", publicEligible: true });
    expect(classifyModelBilling("mistral", "mistral-large-latest")).toMatchObject({ class: "unknown", publicEligible: false });
  });
});
