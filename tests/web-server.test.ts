/**
 * Tests for the built-in web server. We exercise each /api/* route end-to-end
 * against a real HTTP socket (random port) with hand-rolled minimal stand-ins
 * for Router and RoleResolver — the server only uses a tiny surface of each.
 *
 * Static-file routes are smoke-checked (existence + Content-Type) rather than
 * byte-compared, since the static assets live in src/web/static/ and shipping
 * them in tests would just rewrap on every UI change.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.js";
import type { CompleteOptions } from "../src/provider.js";
import type { ConversationPart } from "../src/tools/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────
type Snap = {
  id: string;
  cooldownUntil: number;
  successCount: number;
  rateLimitCount: number;
  remainingPct?: number;
};

function makeRouter(snap: Snap[], mode: "round-robin" | "serial" = "round-robin") {
  // The server consumes Router via: snapshot(), getMode(), and indirectly
  // through formatUsageReport which calls both. Anything else is unused.
  return {
    snapshot: () => snap,
    getMode: () => mode,
  } as unknown as import("../src/router.js").Router;
}

function makeResolver(handler: (name: string, prompt: string) => Promise<string>) {
  // The server uses runRole(name, prompt), and /api/task also needs the
  // resolver's rosterDescription() for RoleOrchestrator planning.
  return {
    runRole: (name: string, prompt: string) => handler(name, prompt),
    runRoleChat: (name: string, history: ConversationPart[]) =>
      handler(name, JSON.stringify(history)),
    rosterDescription: () =>
      [
        "- orchestration: planning and synthesis",
        "- action-structural: structured execution",
      ].join("\n"),
    // listRoles is consumed by roleUsageSnapshot to walk the active
    // resolver's chains. Tests don't care about role attribution, so
    // return an empty list (snapshot falls back to DEFAULT_ROLES'
    // shape via the iteration loop).
    listRoles: () => [],
  } as unknown as import("../src/roles/resolver.js").RoleResolver;
}

async function startTestServer(routerSnap: Snap[], handler?: (name: string, prompt: string) => Promise<string>) {
  const router = makeRouter(routerSnap);
  const resolver = makeResolver(handler ?? (async (_n, p) => `echo:${p}`));
  // Port 0 means OS picks an ephemeral port. We capture it via the server's url.
  const handle = startWebServer({ router, resolver, port: 0 });
  // url is reported with the requested port; resolve actual port from listener.
  // For Node http server, the underlying server isn't exposed — but startWebServer
  // returns a string with our port. Since we requested 0, the OS picked one; we
  // pull it back via the server.listening reference. Since opts.port falls back to
  // 7421 when 0/undefined, we instead pass a unique higher port per test below.
  return handle;
}

// We don't have port 0 trickery (default is 7421); just pick high random ports
// per test to avoid collisions with a possibly-running dev server.
function pickPort(): number {
  // 50000-59999 range — leaves room and stays out of common dev-server territory
  return 50000 + Math.floor(Math.random() * 10000);
}

describe("web server", () => {
  let handles: Array<{ close: () => void }> = [];
  let sessionDir: string;
  let roleInstructionsPath: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "multi-agent-web-sessions-"));
    roleInstructionsPath = join(sessionDir, "role-instructions.json");
  });

  afterEach(() => {
    for (const h of handles) {
      try { h.close(); } catch {/* ignore */}
    }
    handles = [];
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function spawn(opts: { snap?: Snap[]; handler?: (name: string, prompt: string) => Promise<string> } = {}) {
    const port = pickPort();
    const router = makeRouter(opts.snap ?? [
      { id: "gemini:1", cooldownUntil: 0, successCount: 3, rateLimitCount: 0, remainingPct: 75 },
      { id: "groq:llama-70b", cooldownUntil: 0, successCount: 1, rateLimitCount: 0 },
    ]);
    const resolver = makeResolver(opts.handler ?? (async (_n, p) => `reply:${p}`));
    const handle = startWebServer({ router, resolver, port, sessionStorageDir: sessionDir, roleInstructionsPath });
    handles.push(handle);
    return { handle, port, url: `http://localhost:${port}` };
  }

  it("serves the SPA shell at /", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain("HeroMindmap");
  });

  it("serves /app.jsx with the conversation manager entry point", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/app.jsx`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/babel/);
    const body = await r.text();
    expect(body).toContain("ConversationDrawer");
    expect(body).toContain("mm-nav-sessions");
    expect(body).toContain("Open saved threads");
  });

  it("keeps project-file attachments compatible with the composer attachment shape", () => {
    const app = readFileSync(join(process.cwd(), "src", "web", "static", "app.jsx"), "utf8");
    expect(app).toContain("function attachmentText(att)");
    expect(app).toContain("text: selectedFile.content");
    expect(app).not.toContain("content: selectedFile.content }]");
  });

  it("blocks directory traversal", async () => {
    const { url } = spawn();
    // %2e%2e%2f is ../ encoded; the server should normalize and refuse.
    const r = await fetch(`${url}/..%2f..%2fpackage.json`);
    // Either 403 or 404 is acceptable; the important thing is no leaked file content.
    expect(r.status).toBeGreaterThanOrEqual(400);
    const body = await r.text();
    expect(body).not.toContain("\"name\":");
  });

  it("404s an unknown path", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/no-such-thing`);
    expect(r.status).toBe(404);
  });

  it("/api/usage returns plain-text formatted report", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/usage`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await r.text();
    expect(body).toContain("gemini:1");
    expect(body).toContain("3 successful");
  });

  it("/api/usage.json returns structured snapshot and role mapping", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/usage.json`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.mode).toBe("round-robin");
    expect(j.providers).toHaveLength(2);
    expect(j.providers[0].id).toBe("gemini:1");
    expect(j.providers[0].cooling).toBe(false);
    expect(j.providers[0].remainingPct).toBe(75);
    expect(j.providers[1].remainingPct).toBeNull(); // groq has no budget
    expect(j.roles.orchestration.providerId).toBe("gemini:1");
    expect(j.roles.orchestration.successCount).toBe(3);
    expect(j.roles["action-structural"].providerId).toBe("groq:llama-70b");
    // Reasoning's NEW primary chain begins with gemini:1 (Flash + thinking=high),
    // so it's the primary not a fallback — even though OpenRouter / Gemma are
    // missing from this test's provider set.
    expect(j.roles.reasoning.providerId).toBe("gemini:1");
    expect(j.roles.reasoning.fallback).toBe(false);
  });

  it("/api/usage.json marks a role temporarily unavailable when all candidates are cooling", async () => {
    const future = Date.now() + 60_000;
    const { url } = spawn({
      snap: [
        { id: "openrouter:deepseek-v4-flash", cooldownUntil: future, successCount: 0, rateLimitCount: 2 },
        { id: "gemini:1", cooldownUntil: future, successCount: 3, rateLimitCount: 1, remainingPct: 75 },
        { id: "gemini:2", cooldownUntil: future, successCount: 0, rateLimitCount: 1, remainingPct: 80 },
        { id: "gemini:3", cooldownUntil: future, successCount: 0, rateLimitCount: 1, remainingPct: 80 },
      ],
    });
    const r = await fetch(`${url}/api/usage.json`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.roles.reasoning.status).toBe("temporarily-unavailable");
    expect(j.roles.reasoning.cooling).toBe(true);
  });

  it("/api/ollama-health does not treat an installed 32b tag as satisfying the 14b default", async () => {
    const oldFetch = globalThis.fetch;
    const oldReasoning = process.env.OLLAMA_REASONING_MODEL;
    const oldCoder = process.env.OLLAMA_CODER_MODEL;
    const oldHost = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_REASONING_MODEL;
    delete process.env.OLLAMA_CODER_MODEL;
    process.env.OLLAMA_HOST = "http://localhost:11434";

    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "http://localhost:11434/api/tags") {
        return Response.json({
          models: [{ name: "deepseek-r1:14b" }, { name: "qwen2.5-coder:32b" }],
        });
      }
      return oldFetch(input, init);
    }) as typeof fetch;

    try {
      const { url } = spawn();
      const r = await fetch(`${url}/api/ollama-health`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.reachable).toBe(true);
      expect(j.required).toEqual(["deepseek-r1:14b", "qwen2.5-coder:14b"]);
      expect(j.missing).toEqual(["qwen2.5-coder:14b"]);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldReasoning === undefined) delete process.env.OLLAMA_REASONING_MODEL;
      else process.env.OLLAMA_REASONING_MODEL = oldReasoning;
      if (oldCoder === undefined) delete process.env.OLLAMA_CODER_MODEL;
      else process.env.OLLAMA_CODER_MODEL = oldCoder;
      if (oldHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = oldHost;
    }
  });

  it("/api/complete 400s without prompt", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const j: any = await r.json();
    expect(j.error).toMatch(/prompt/);
  });

  it("/api/complete 400s on empty-string prompt", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    expect(r.status).toBe(400);
  });

  it("/api/complete forwards to resolver.runRole(orchestration, prompt)", async () => {
    const calls: Array<{ name: string; prompt: string }> = [];
    const { url } = spawn({
      handler: async (name, prompt) => {
        calls.push({ name, prompt });
        return `synthesized: ${prompt}`;
      },
    });
    const r = await fetch(`${url}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello world", mode: "auto" }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.reply).toBe("synthesized: hello world");
    expect(calls).toEqual([{ name: "orchestration", prompt: "hello world" }]);
  });

  it("/api/complete honors explicit useLocal false even when the server default is local", async () => {
    const port = pickPort();
    const calls: string[] = [];
    const router = makeRouter([]);
    const defaultLocal = makeResolver(async () => {
      calls.push("default-local");
      return "local";
    });
    const cloud = makeResolver(async () => {
      calls.push("cloud");
      return "cloud";
    });
    const handle = startWebServer({
      router,
      resolver: defaultLocal,
      localResolver: defaultLocal,
      cloudResolver: cloud,
      port,
      sessionStorageDir: sessionDir,
    });
    handles.push(handle);

    const r = await fetch(`http://localhost:${port}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "categorize", role: "mindmap-categorize", useLocal: false }),
    });

    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.reply).toBe("cloud");
    expect(calls).toEqual(["cloud"]);
  });

  it("/api/complete 500s with the resolver error message", async () => {
    const { url } = spawn({
      handler: async () => { throw new Error("upstream blew up"); },
    });
    const r = await fetch(`${url}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    expect(r.status).toBe(500);
    const j: any = await r.json();
    expect(j.error).toBe("upstream blew up");
  });

  it("/api/task runs the RoleOrchestrator path used by the CLI task command", async () => {
    const calls: Array<{ name: string; prompt: string }> = [];
    const { url } = spawn({
      handler: async (name, prompt) => {
        calls.push({ name, prompt });
        if (name === "orchestration" && prompt.includes("Output EXACTLY one JSON object")) {
          return JSON.stringify({
            kind: "single",
            role: "action-structural",
            prompt: "expand: hello world",
          });
        }
        return "full task answer from specialist";
      },
    });
    const r = await fetch(`${url}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello world", mode: "auto" }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.reply).toBe("full task answer from specialist");
    expect(j.plan).toBe("single");
    expect(calls[0]!.name).toBe("orchestration");
    expect(calls[1]).toEqual({ name: "action-structural", prompt: "expand: hello world" });
  });

  it("/api/chat keeps conversation context across browser turns", async () => {
    const histories: ConversationPart[][] = [];
    const { url } = spawn({
      handler: async (_name, prompt) => {
        const history = JSON.parse(prompt) as ConversationPart[];
        histories.push(history);
        const lastUser = [...history].reverse().find((p) => p.kind === "user_text") as
          | { text: string }
          | undefined;
        return JSON.stringify({
          kind: "direct",
          answer: lastUser?.text.includes("again")
            ? "the previous topic was Apollo"
            : "Apollo noted",
        });
      },
    });

    const first = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-thread", message: "remember Apollo" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-thread", message: "what was that again?" }),
    });
    expect(second.status).toBe(200);
    const j: any = await second.json();
    expect(j.reply).toBe("the previous topic was Apollo");

    const secondHistory = histories[1]!;
    expect(secondHistory.some((p) => p.kind === "user_text" && p.text === "remember Apollo")).toBe(true);
    expect(secondHistory.some((p) => p.kind === "model_text" && p.text === "Apollo noted")).toBe(true);
  });

  it("CORS preflight returns 204 when cors is enabled", async () => {
    const port = pickPort();
    const handle = startWebServer({
      router: makeRouter([]),
      resolver: makeResolver(async () => ""),
      port,
      cors: true,
    });
    handles.push(handle);
    const r = await fetch(`http://localhost:${port}/api/usage`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

﻿  it("/api/sessions returns session summaries sorted by pinned and recency", async () => {
    writeFileSync(join(sessionDir, "old.json"), JSON.stringify({
      version: 1,
      id: "old",
      title: "Old chat",
      pinned: false,
      createdAt: 1000,
      updatedAt: 2000,
      history: [
        { kind: "user_text", text: "older question" },
        { kind: "model_text", text: "older answer" },
      ],
    }), "utf8");
    writeFileSync(join(sessionDir, "pinned.json"), JSON.stringify({
      version: 1,
      id: "pinned",
      title: "Pinned chat",
      pinned: true,
      createdAt: 1000,
      updatedAt: 1500,
      history: [
        { kind: "user_text", text: "important question" },
        { kind: "model_text", text: "important answer" },
      ],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.sessions.map((x: any) => x.id)).toEqual(["pinned", "old"]);
    expect(j.sessions[0]).toMatchObject({
      id: "pinned",
      title: "Pinned chat",
      pinned: true,
      turns: 1,
      preview: "important question",
    });
  });

  it("/api/sessions/:id PATCH updates title and pinned metadata", async () => {
    writeFileSync(join(sessionDir, "meta.json"), JSON.stringify({
      version: 1,
      id: "meta",
      createdAt: 1000,
      updatedAt: 2000,
      history: [{ kind: "user_text", text: "first topic" }],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions/meta`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed thread", pinned: true }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.session.title).toBe("Renamed thread");
    expect(j.session.pinned).toBe(true);

    const raw = JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf8"));
    expect(raw.title).toBe("Renamed thread");
    expect(raw.pinned).toBe(true);
  });

  it("/api/sessions/:id/duplicate copies a session under a new id", async () => {
    writeFileSync(join(sessionDir, "source.json"), JSON.stringify({
      version: 1,
      id: "source",
      title: "Source",
      createdAt: 1000,
      updatedAt: 2000,
      history: [
        { kind: "user_text", text: "copy me" },
        { kind: "model_text", text: "copied" },
      ],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions/source/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newId: "source-copy" }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.session.id).toBe("source-copy");
    expect(j.session.title).toBe("Source copy");
    expect(existsSync(join(sessionDir, "source-copy.json"))).toBe(true);
    const copy = JSON.parse(readFileSync(join(sessionDir, "source-copy.json"), "utf8"));
    expect(copy.history).toHaveLength(2);
  });

  it("/api/sessions/:id/export downloads the raw session JSON", async () => {
    writeFileSync(join(sessionDir, "export-me.json"), JSON.stringify({
      version: 1,
      id: "export-me",
      title: "Export me",
      history: [],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions/export-me/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.headers.get("content-disposition")).toContain("export-me.json");
    const j: any = await r.json();
    expect(j.title).toBe("Export me");
  });

  it("/api/sessions/:id DELETE removes a session file", async () => {
    writeFileSync(join(sessionDir, "delete-me.json"), JSON.stringify({
      version: 1,
      id: "delete-me",
      history: [],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions/delete-me`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(existsSync(join(sessionDir, "delete-me.json"))).toBe(false);
  });

  it("/api/role-instructions reads and writes the editable local instruction file", async () => {
    const { url } = spawn();

    const initial = await fetch(`${url}/api/role-instructions`);
    expect(initial.status).toBe(200);
    const before: any = await initial.json();
    expect(before.path).toBe(roleInstructionsPath);
    expect(before.instructions.roles.perception).toBe("");

    const saved = await fetch(`${url}/api/role-instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instructions: {
          version: 1,
          global: "Use direct language.",
          roles: { perception: "Prefer research-backed claims." },
        },
      }),
    });
    expect(saved.status).toBe(200);
    const after: any = await saved.json();
    expect(after.instructions.global).toBe("Use direct language.");
    expect(after.instructions.roles.perception).toBe("Prefer research-backed claims.");
    expect(after.instructions.roles.reasoning).toBe("");

    const raw = JSON.parse(readFileSync(roleInstructionsPath, "utf8"));
    expect(raw.global).toBe("Use direct language.");
  });

  it("/api/chat loads role instructions from disk for web sessions", async () => {
    const histories: ConversationPart[][] = [];
    let calls = 0;
    const { url } = spawn({
      handler: async (_name, prompt) => {
        histories.push(JSON.parse(prompt) as ConversationPart[]);
        calls++;
        return calls === 1
          ? JSON.stringify({ kind: "direct", answer: "hello back" })
          : "hello back";
      },
    });

    const put = await fetch(`${url}/api/role-instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instructions: {
          version: 1,
          global: "Keep a steady tone.",
          roles: { orchestration: "Prefer direct plans." },
        },
      }),
    });
    expect(put.status).toBe(200);

    const chat = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "role-file-thread", message: "hello" }),
    });
    expect(chat.status).toBe(200);

    expect(histories[0]![2]).toEqual({
      kind: "user_text",
      text: expect.stringContaining("Long-term role instructions for orchestration"),
    });
    expect((histories[0]![2] as { text: string }).text).toContain("Keep a steady tone.");
    expect((histories[0]![2] as { text: string }).text).toContain("Prefer direct plans.");
  });

  // ── File API tests ───────────────────────────────────────────────────────

  describe("web file API", () => {
    let fileRoot: string;
    let fileHandles: Array<{ close: () => void }> = [];

    beforeEach(() => {
      fileRoot = mkdtempSync(join(tmpdir(), "multi-agent-file-root-"));
      writeFileSync(join(fileRoot, "hello.txt"), "Hello, world!", "utf8");
      mkdirSync(join(fileRoot, ".git"), { recursive: true });
      mkdirSync(join(fileRoot, "node_modules"), { recursive: true });
      mkdirSync(join(fileRoot, "src"), { recursive: true });
      writeFileSync(join(fileRoot, "src", "main.ts"), "export const x = 1;", "utf8");
    });

    afterEach(() => {
      for (const h of fileHandles) {
        try { h.close(); } catch { /* ignore */ }
      }
      fileHandles = [];
      rmSync(fileRoot, { recursive: true, force: true });
    });

    function spawnWithRoot(projectRoot: string) {
      const port = pickPort();
      const router = makeRouter([]);
      const resolver = makeResolver(async (_n, p) => `reply:${p}`);
      const handle = startWebServer({ router, resolver, port, projectRoot, sessionStorageDir: sessionDir });
      fileHandles.push(handle);
      return { port, url: `http://localhost:${port}` };
    }

    it("GET /api/files/root reports the configured project root", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/root`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.root).toBe(fileRoot);
      expect(j.mode).toBe("read");
      expect(j.maxBytes).toBe(262144);
    });

    it("GET /api/files lists directory entries and omits blocked names", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files?path=.`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.path).toBe(".");
      const names: string[] = j.entries.map((e: any) => e.name);
      expect(names).toContain("hello.txt");
      expect(names).toContain("src");
      expect(names).not.toContain(".git");
      expect(names).not.toContain("node_modules");
    });

    it("GET /api/files/read returns content and a stable sha256", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=hello.txt`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.path).toBe("hello.txt");
      expect(j.content).toBe("Hello, world!");
      expect(j.truncated).toBe(false);
      expect(typeof j.sha256).toBe("string");
      expect(j.sha256).toHaveLength(64);
      // Same hash on repeated calls
      const r2 = await fetch(`${url}/api/files/read?path=hello.txt`);
      const j2: any = await r2.json();
      expect(j2.sha256).toBe(j.sha256);
    });

    it("GET /api/files/read 403s on path traversal", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=../secret.txt`);
      expect(r.status).toBe(403);
      const j: any = await r.json();
      expect(j.error).toBeDefined();
    });

    it("GET /api/files/read 403s on .env", async () => {
      writeFileSync(join(fileRoot, ".env"), "SECRET=password", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=.env`);
      expect(r.status).toBe(403);
    });

    it("GET /api/files/read 413s when the file exceeds the cap", async () => {
      writeFileSync(join(fileRoot, "large.txt"), Buffer.alloc(300_000, "x"));
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=large.txt`);
      expect(r.status).toBe(413);
      const j: any = await r.json();
      expect(j.error).toMatch(/too large/i);
    });

    it("GET /api/files/read 415s for binary files", async () => {
      writeFileSync(join(fileRoot, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=image.bin`);
      expect(r.status).toBe(415);
      const j: any = await r.json();
      expect(j.error).toMatch(/binary/i);
    });

    it("GET /api/files/read 415s for invalid UTF-8 text without NUL bytes", async () => {
      writeFileSync(join(fileRoot, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/read?path=invalid.txt`);
      expect(r.status).toBe(415);
      const j: any = await r.json();
      expect(j.error).toMatch(/binary|utf-?8/i);
    });

    // ── Phase B: diff + write ─────────────────────────────────────────────

    it("POST /api/files/diff returns a unified diff and beforeSha256", async () => {
      writeFileSync(join(fileRoot, "edit.txt"), "line one\nline two\nline three\n", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "edit.txt", content: "line one\nline TWO\nline three\n" }),
      });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.path).toBe("edit.txt");
      expect(typeof j.beforeSha256).toBe("string");
      expect(j.beforeSha256).toHaveLength(64);
      expect(j.diff).toContain("-line two");
      expect(j.diff).toContain("+line TWO");
    });

    it("POST /api/files/write applies content when expectedSha256 matches", async () => {
      writeFileSync(join(fileRoot, "target.txt"), "original content\n", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      // Get current sha256 via read
      const readRes = await fetch(`${url}/api/files/read?path=target.txt`);
      const { sha256 } = await readRes.json() as any;
      // Apply write
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "target.txt", content: "updated content\n", expectedSha256: sha256, confirm: true }),
      });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.path).toBe("target.txt");
      expect(typeof j.sha256).toBe("string");
      expect(readFileSync(join(fileRoot, "target.txt"), "utf8")).toBe("updated content\n");
    });

    it("POST /api/files/write 409s when expectedSha256 is stale", async () => {
      writeFileSync(join(fileRoot, "stale.txt"), "first version\n", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "stale.txt", content: "new version\n", expectedSha256: "a".repeat(64), confirm: true }),
      });
      expect(r.status).toBe(409);
      const j: any = await r.json();
      expect(j.error).toMatch(/changed on disk/i);
    });

    it("POST /api/files/write 413s when new content exceeds the cap", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "too-large.txt", content: "x".repeat(300_000), expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(413);
      expect(existsSync(join(fileRoot, "too-large.txt"))).toBe(false);
      const j: any = await r.json();
      expect(j.error).toMatch(/too large/i);
    });

    it("POST /api/files/write 400s when confirm is not true", async () => {
      writeFileSync(join(fileRoot, "guard.txt"), "content\n", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      const readRes = await fetch(`${url}/api/files/read?path=guard.txt`);
      const { sha256 } = await readRes.json() as any;
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "guard.txt", content: "x", expectedSha256: sha256 }), // no confirm
      });
      expect(r.status).toBe(400);
    });

    it("POST /api/files/write 403s on path traversal", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../escape.txt", content: "x", expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(403);
    });

    it("POST /api/files/write 403s on .env", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: ".env", content: "SECRET=x", expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(403);
    });
  });

  it("/api/chat-stream aborts in-flight role work when the client disconnects", async () => {
    const port = pickPort();
    let roleStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      roleStarted = resolve;
    });
    let roleAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      roleAborted = resolve;
    });
    const router = makeRouter([]);
    const resolver = {
      runRoleChatStream: async (
        _name: string,
        _history: ConversationPart[],
        onToken: (text: string) => void,
        opts?: CompleteOptions,
      ) => {
        onToken("started");
        roleStarted();
        return await new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            roleAborted();
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      },
      listRoles: () => [],
      rosterDescription: () => "",
    } as unknown as import("../src/roles/resolver.js").RoleResolver;
    const handle = startWebServer({ router, resolver, port, sessionStorageDir: sessionDir });
    handles.push(handle);

    const controller = new AbortController();
    const response = await fetch(`http://localhost:${port}/api/chat-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "abort-stream",
        message: "please stop",
        forceRole: "orchestration",
      }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await started;

    controller.abort();

    await expect(Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("role was not aborted")), 500)),
    ])).resolves.toBeUndefined();
  });
});
