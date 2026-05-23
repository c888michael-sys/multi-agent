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
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { startWebServer } from "../src/web/server.js";

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
  // The server only uses runRole(name, prompt). Wrap a fake handler.
  return {
    runRole: (name: string, prompt: string) => handler(name, prompt),
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

  afterEach(() => {
    for (const h of handles) {
      try { h.close(); } catch {/* ignore */}
    }
    handles = [];
  });

  function spawn(opts: { snap?: Snap[]; handler?: (name: string, prompt: string) => Promise<string> } = {}) {
    const port = pickPort();
    const router = makeRouter(opts.snap ?? [
      { id: "gemini:1", cooldownUntil: 0, successCount: 3, rateLimitCount: 0, remainingPct: 75 },
      { id: "groq:llama-70b", cooldownUntil: 0, successCount: 1, rateLimitCount: 0 },
    ]);
    const resolver = makeResolver(opts.handler ?? (async (_n, p) => `reply:${p}`));
    const handle = startWebServer({ router, resolver, port });
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
    // Reasoning isn't registered in the snapshot, so the role surfaces as { registered: false }
    expect(j.roles.reasoning.registered).toBe(false);
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
