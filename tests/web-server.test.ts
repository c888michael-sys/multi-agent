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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.js";
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

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "multi-agent-web-sessions-"));
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
    const handle = startWebServer({ router, resolver, port, sessionStorageDir: sessionDir });
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

  it("serves /app.jsx as text/babel", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/app.jsx`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/babel/);
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
      body: JSON.stringify({ prompt: "hello world" }),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.reply).toBe("synthesized: hello world");
    expect(calls).toEqual([{ name: "orchestration", prompt: "hello world" }]);
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
      body: JSON.stringify({ prompt: "hello world" }),
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

  it("/api/sessions returns whatever listSessions reports", async () => {
    // listSessions reads ~/.multi-agent/sessions — we don't write fixtures
    // here, just confirm the route shape. The real session-store tests live
    // in chat-session.test.ts.
    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions`);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(Array.isArray(j.sessions)).toBe(true);
  });
});
