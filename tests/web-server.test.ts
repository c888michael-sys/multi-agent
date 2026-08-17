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
import { MAX_REQUEST_BODY_BYTES, startWebServer } from "../src/web/server.js";
import type { CompleteOptions } from "../src/provider.js";
import type { ConversationPart } from "../src/tools/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────
type Snap = {
  id: string;
  model?: string;
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

function makeResolver(
  handler: (name: string, prompt: string) => Promise<string>,
  toolHandler?: (name: string, history: ConversationPart[], tools: unknown[]) => Promise<unknown>,
) {
  // The server uses runRole(name, prompt), and /api/task also needs the
  // resolver's rosterDescription() for RoleOrchestrator planning.
  return {
    runRole: (name: string, prompt: string) => handler(name, prompt),
    runRoleChat: (name: string, history: ConversationPart[]) =>
      handler(name, JSON.stringify(history)),
    runRoleChatStream: async function* (name: string, history: ConversationPart[]) {
      yield await handler(name, JSON.stringify(history));
    },
    runRoleWithTools: (name: string, history: ConversationPart[], tools: unknown[]) => (
      toolHandler ? toolHandler(name, history, tools) : Promise.resolve({ kind: "text", text: "no tool work" })
    ),
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
  let originalOverridePath: string | undefined;
  let originalModelCachePath: string | undefined;
  let originalProviderModelsCachePath: string | undefined;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "multi-agent-web-sessions-"));
    roleInstructionsPath = join(sessionDir, "role-instructions.json");
    originalOverridePath = process.env.MULTI_AGENT_MODEL_OVERRIDES;
    originalModelCachePath = process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE;
    originalProviderModelsCachePath = process.env.MULTI_AGENT_PROVIDER_MODELS_CACHE;
  });

  afterEach(() => {
    for (const h of handles) {
      try { h.close(); } catch {/* ignore */}
    }
    handles = [];
    rmSync(sessionDir, { recursive: true, force: true });
    if (originalOverridePath === undefined) delete process.env.MULTI_AGENT_MODEL_OVERRIDES;
    else process.env.MULTI_AGENT_MODEL_OVERRIDES = originalOverridePath;
    if (originalModelCachePath === undefined) delete process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE;
    else process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE = originalModelCachePath;
    if (originalProviderModelsCachePath === undefined) delete process.env.MULTI_AGENT_PROVIDER_MODELS_CACHE;
    else process.env.MULTI_AGENT_PROVIDER_MODELS_CACHE = originalProviderModelsCachePath;
  });

  function spawn(opts: {
    snap?: Snap[];
    handler?: (name: string, prompt: string) => Promise<string>;
    toolHandler?: (name: string, history: ConversationPart[], tools: unknown[]) => Promise<unknown>;
    modelFetchImpl?: typeof fetch;
    chatOnly?: boolean;
    allowSharedSettings?: boolean;
    projectRoot?: string;
  } = {}) {
    const port = pickPort();
    const router = makeRouter(opts.snap ?? [
      { id: "gemini:1", cooldownUntil: 0, successCount: 3, rateLimitCount: 0, remainingPct: 75 },
      { id: "groq:llama-70b", cooldownUntil: 0, successCount: 1, rateLimitCount: 0 },
    ]);
    const resolver = makeResolver(opts.handler ?? (async (_n, p) => `reply:${p}`), opts.toolHandler);
    const handle = startWebServer({
      router,
      resolver,
      port,
      sessionStorageDir: sessionDir,
      roleInstructionsPath,
      chatOnly: opts.chatOnly,
      allowSharedSettings: opts.allowSharedSettings,
      projectRoot: opts.projectRoot,
      ...(opts.modelFetchImpl ? { modelFetchImpl: opts.modelFetchImpl } : {}),
    });
    handles.push(handle);
    return { handle, port, url: `http://localhost:${port}` };
  }

  async function localMutationFetch(url: string, init: RequestInit): Promise<Response> {
    const context = await fetch(`${new URL(url).origin}/api/security/context`);
    expect(context.status).toBe(200);
    const { csrfToken } = await context.json() as { csrfToken?: string };
    expect(typeof csrfToken).toBe("string");
    const headers = new Headers(init.headers);
    headers.set("X-CSRF-Token", csrfToken!);
    return fetch(url, { ...init, headers });
  }

  it("binds to loopback by default", async () => {
    const port = pickPort();
    const handle = startWebServer({
      router: makeRouter([]),
      resolver: makeResolver(async () => ""),
      port,
      sessionStorageDir: sessionDir,
      roleInstructionsPath,
    });
    handles.push(handle);

    expect(handle.url).toBe(`http://127.0.0.1:${port}/`);
    const response = await fetch(handle.url);
    expect(response.status).toBe(200);
  });

  it("can run a full local listener beside a shared chat-and-settings listener", async () => {
    const projectRoot = join(sessionDir, "host-project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "local-only.txt"), "owner can read this", "utf8");
    const router = makeRouter([]);
    const sharedPrompts: string[] = [];
    const resolver = makeResolver(async (_name, prompt) => {
      sharedPrompts.push(prompt);
      return `reply:${prompt}`;
    });
    const localPort = pickPort();
    let sharePort = pickPort();
    while (sharePort === localPort) sharePort = pickPort();
    const common = {
      router,
      resolver,
      sessionStorageDir: sessionDir,
      roleInstructionsPath,
      projectRoot,
    };
    const local = startWebServer({ ...common, port: localPort });
    const shared = startWebServer({
      ...common,
      port: sharePort,
      chatOnly: true,
      allowSharedSettings: true,
    });
    handles.push(local, shared);

    const localFile = await fetch(`${local.url}api/files/read?path=local-only.txt`);
    expect(localFile.status).toBe(200);
    expect((await localFile.json() as { content?: string }).content).toBe("owner can read this");
    expect((await fetch(`${local.url}api/role-instructions`)).status).toBe(200);

    const sharedFile = await fetch(`${shared.url}api/files/read?path=local-only.txt`);
    expect(sharedFile.status).toBe(404);
    const sharedInstructions = await fetch(`${shared.url}api/role-instructions`);
    expect(sharedInstructions.status).toBe(200);
    expect(await sharedInstructions.json()).not.toHaveProperty("path");
    expect((await fetch(`${shared.url}api/usage.json`)).status).toBe(200);
    expect((await fetch(`${shared.url}api/usage`)).status).toBe(200);
    expect((await fetch(`${shared.url}api/providers`)).status).toBe(200);
    expect((await fetch(`${shared.url}api/role-models`)).status).toBe(400);
    expect((await fetch(`${shared.url}api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(400);
    expect((await fetch(`${shared.url}api/reasoning-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(400);

    const sharedOrigin = "https://friend-node.example.ts.net";
    const savedInstructions = await fetch(`${shared.url}api/role-instructions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Host": "friend-node.example.ts.net",
        "Origin": sharedOrigin,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ instructions: { global: "shared preference", roles: {} } }),
    });
    expect(savedInstructions.status).toBe(200);
    expect(await savedInstructions.json()).not.toHaveProperty("path");

    const sharedTurn = await fetch(`${shared.url}api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "shared-settings-turn",
        message: "hello",
        forceRole: "orchestration",
      }),
    });
    expect(sharedTurn.status).toBe(200);
    expect(sharedPrompts.some((prompt) => prompt.includes("shared preference"))).toBe(true);

    const crossOriginWrite = await fetch(`${shared.url}api/role-instructions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Host": "friend-node.example.ts.net",
        "Origin": "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ instructions: { global: "evil", roles: {} } }),
    });
    expect(crossOriginWrite.status).toBe(403);

    for (const path of [
      "/api/security/context",
      "/api/projects",
      "/api/sessions",
      "/api/goals",
      "/api/artifacts/proposals",
    ]) {
      expect((await fetch(`${shared.url}${path}`)).status, path).toBe(404);
    }

    const [localShell, sharedShell] = await Promise.all([
      fetch(local.url).then((response) => response.text()),
      fetch(shared.url).then((response) => response.text()),
    ]);
    expect(localShell).toContain('"chatOnly":false');
    expect(sharedShell).toContain('"chatOnly":true');
    expect(sharedShell).toContain('"allowSharedSettings":true');
    expect(sharedShell).not.toContain(roleInstructionsPath);
  });

  it("serves the SPA shell at /", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain("HeroMindmap");
    expect(body).toContain("Lattice — multi-agent");
    expect(body).toContain("id=\"favicon\"");
  });

  it("enforces chat-only mode server-side and keeps chat history off disk", async () => {
    const projectRoot = join(sessionDir, "private-project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "host-secret.txt"), "must remain unreachable", "utf8");
    writeFileSync(roleInstructionsPath, JSON.stringify({
      version: 1,
      global: "HOST_INSTRUCTION_MARKER",
      roles: { orchestration: "HOST_ROLE_MARKER" },
    }), "utf8");

    const prompts: string[] = [];
    let toolCalls = 0;
    const { url } = spawn({
      chatOnly: true,
      projectRoot,
      handler: async (_role, prompt) => {
        prompts.push(prompt);
        return "// host-secret.txt\nreplacement content";
      },
      toolHandler: async () => {
        toolCalls += 1;
        return { kind: "text", text: "tool should not run" };
      },
    });

    const shell = await fetch(`${url}/`);
    expect(shell.status).toBe(200);
    const shellBody = await shell.text();
    expect(shellBody).toContain('"chatOnly":true');
    expect(shellBody).toContain('"localModels":[]');

    const completion = await fetch(`${url}/api/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "categorise this", role: "mindmap-categorize" }),
    });
    expect(completion.status).toBe(200);

    for (const [path, method] of [
      ["/api/security/context", "GET"],
      ["/api/usage", "GET"],
      ["/api/usage.json", "GET"],
      ["/api/ollama-health", "GET"],
      ["/api/projects", "GET"],
      ["/api/files/read?path=host-secret.txt", "GET"],
      ["/api/sessions", "GET"],
      ["/api/role-instructions", "GET"],
      ["/api/reasoning-models", "GET"],
      ["/api/providers", "GET"],
      ["/api/role-models", "GET"],
      ["/api/goals", "GET"],
      ["/api/task", "POST"],
      ["/api/files/write", "POST"],
      ["/api/artifacts/proposals", "POST"],
      ["/api/goal", "POST"],
      ["/api/role-instructions", "PUT"],
      ["/api/sessions", "DELETE"],
    ] as const) {
      const response = await fetch(`${url}${path}`, {
        method,
        ...(method === "POST" || method === "PUT"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: "not available in chat-only mode" });
    }

    const send = (message: string) => fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "friend-chat",
        message,
        forceRole: "orchestration",
        builder: true,
      }),
    });
    const first = await send("hello");
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { artifact?: unknown; turns?: number };
    expect(firstBody.artifact).toBeNull();
    expect(firstBody.turns).toBe(1);

    const streamed = await fetch(`${url}/api/chat-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "friend-stream",
        message: "stream this",
        forceRole: "orchestration",
        builder: true,
      }),
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toContain('"kind":"done"');

    const second = await send("do you remember me?");
    expect(second.status).toBe(200);
    expect((await second.json() as { turns?: number }).turns).toBe(2);
    expect(toolCalls).toBe(0);
    expect(prompts.some((prompt) => prompt.includes("HOST_INSTRUCTION_MARKER"))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes("HOST_ROLE_MARKER"))).toBe(false);
    expect(prompts.at(-1)).toContain("do you remember me?");
    expect(prompts.at(-1)).toContain("replacement content");
    expect(existsSync(join(sessionDir, "friend-chat.json"))).toBe(false);
    expect(existsSync(join(sessionDir, "friend-stream.json"))).toBe(false);
    expect(readFileSync(join(projectRoot, "host-secret.txt"), "utf8")).toBe("must remain unreachable");
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
    expect(body).toContain("delete all threads");
    expect(body).toContain("setBusyChrome");
    expect(body).toContain("prefers-reduced-motion: reduce");
    expect(body).toContain("onTemplatePick");
    expect(body).toContain("mm-empty");
    expect(body).toContain("onPointerDown={() => loadModels(role, provider, true, true)}");
    expect(body).toContain("Model catalogue through");
    expect(body).toContain("SHOW_NON_FILE_CONTROLS");
    expect(body).toContain("SHARED CHAT");
    expect(body).toContain("allowBuilder={!CHAT_ONLY}");
    expect(body.indexOf('<span className="mm-settings-name">Routing</span>')).toBeLessThan(
      body.indexOf('<span className="mm-settings-name">Appearance</span>'),
    );
  });

  it("serves Phase A polish CSS and template starters", async () => {
    const { url } = spawn();
    const [styleRes, templateRes] = await Promise.all([
      fetch(`${url}/style.css`),
      fetch(`${url}/templates.jsx`),
    ]);
    expect(styleRes.status).toBe(200);
    expect(templateRes.status).toBe(200);
    const style = await styleRes.text();
    const templates = await templateRes.text();
    expect(style).toContain("prefers-reduced-motion: reduce");
    expect(style).toContain(".mm-root :focus-visible");
    expect(style).toContain(".tnum");
    expect(style).toContain(".mm-empty");
    expect(templates).toContain("starter:");
  });

  it("serves Phase B frontend assets", async () => {
    const { url } = spawn();
    const [indexRes, appRes, styleRes, artifactRes, previewRes] = await Promise.all([
      fetch(`${url}/`),
      fetch(`${url}/app.jsx`),
      fetch(`${url}/style.css`),
      fetch(`${url}/artifact-review.jsx`),
      fetch(`${url}/artifact-preview.js`),
    ]);
    expect(indexRes.status).toBe(200);
    expect(appRes.status).toBe(200);
    expect(styleRes.status).toBe(200);
    expect(artifactRes.status).toBe(200);
    expect(previewRes.status).toBe(200);
    const index = await indexRes.text();
    const app = await appRes.text();
    const style = await styleRes.text();
    const artifact = await artifactRes.text();
    const preview = await previewRes.text();

    expect(index).not.toContain("atom-one-dark");
    expect(app).toContain("CommandBar");
    expect(app).toContain("mm-jump-latest");
    expect(app).toContain("data-theme");
    expect(app).toContain("mm-code-wrap-toggle");
    expect(app).toContain("theme: 'clay'");
    expect(app).toContain("onReviewArtifact");
    expect(app).toContain("drawerRef.current.inert = !open");
    expect(app).toContain('role="status" aria-live="polite"');
    expect(app).toContain("function ErrorTurnCard");
    expect(app).not.toContain("(error: ${errorMsg})");
    expect(app).toContain("function BuilderChecklist");
    expect(app).toContain("artifactSlim:");
    expect(app).toContain("DRAFT_LS_PREFIX");
    expect(app).toContain("generateSessionTitle");
    expect(app).toContain("exportSessionMarkdown");
    expect(app).toContain("No providers configured");
    expect(index).toContain("/artifact-review.jsx");
    expect(index).toContain("/artifact-preview.js");
    expect(artifact).toContain("ArtifactReviewDialog");
    expect(artifact).toContain("Inferred brief");
    expect(artifact).toContain("aria-modal=\"true\"");
    expect(artifact).toContain("onTabKeyDown");
    expect(artifact).toContain("aria-controls=\"artifact-tab-panel\"");
    expect(artifact).toContain("preparedOnce");
    expect(artifact).toContain("mm-artifact-file-group");
    expect(artifact).toContain("Open project files");
    expect(artifact).toContain("undo available for");
    expect(artifact).toContain("Sandboxed source preview");
    expect(preview).toContain("connect-src 'none'");
    expect(style).toContain(".mm-root[data-theme=\"paper\"]");
    expect(style).toContain(".mm-command-bar");
    expect(style).toContain(".mm-jump-latest");
    expect(style).toContain(".mm-code-header");
    expect(style).toContain(".hljs-keyword");
    expect(style).toContain(".mm-artifact-dialog");
    expect(style).toContain(".mm-sr-only");
  });

  it("runs Builder mode through staging tools and returns a review artifact", async () => {
    let iteration = 0;
    const { url } = spawn({
      toolHandler: async (role, _history, tools) => {
        expect(role).toBe("action-code");
        expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
          "list_project", "read_project_file", "stage_file",
        ]);
        if (iteration++ === 0) {
          return {
            kind: "calls",
            calls: [{ name: "stage_file", args: { path: "landing/index.html", content: "<h1>Staged</h1>", language: "html" } }],
          };
        }
        return { kind: "text", text: "The staged site is ready for review." };
      },
    });
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "builder-test", message: "make a simple single-file landing page" }),
    });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.reply).toContain("ready for review");
    expect(body.artifact.candidates).toEqual([{ path: "landing/index.html", content: "<h1>Staged</h1>", language: "html" }]);
    expect(body.servedBy).toEqual(["action-code"]);
    expect(body.execution).toMatchObject({ mode: "builder", source: "auto", requiresStagedFile: true });
  });

  it("enforces an inferred brief and quality review for an ambiguous creative website", async () => {
    let iteration = 0;
    const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Studio</title></head><body><header><nav aria-label="Primary">Work Process Contact</nav></header><main>${Array.from({ length: 6 }, (_, i) => `<section><h2>Project ${i + 1}</h2><img alt="Project ${i + 1}"><p>${"A complete case study with decisions, process, craft, and measurable outcomes. ".repeat(9)}</p></section>`).join("")}</main><footer>Start a project</footer></body></html>`;
    const css = `:root{font-family:system-ui;color:#eee;background:#111}body{margin:0}section{display:grid;grid-template-columns:1fr 1fr;gap:clamp(1rem,4vw,4rem);padding:4rem;border-bottom:1px solid #555}:focus-visible{outline:3px solid orange}@media(max-width:700px){section{grid-template-columns:1fr}}${".card{display:flex;padding:1rem;margin:1rem;color:#eee;background:#222;transition:transform .2s}".repeat(18)}`;
    const js = `document.querySelector('nav').addEventListener('click',()=>document.body.classList.toggle('open'));${"document.querySelectorAll('section').forEach(node=>node.dataset.ready='true');".repeat(6)}`;
    const { url } = spawn({
      toolHandler: async (role, _history, tools) => {
        expect(role).toBe("action-code");
        expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
          "list_project", "read_project_file", "define_build_brief", "stage_file", "review_build_quality",
        ]);
        const responses = [
          { kind: "calls", calls: [{ name: "define_build_brief", args: {
            concept: "An interactive editorial studio portfolio for ambitious digital work.",
            audience: "Prospective product and design clients",
            visualDirection: "Warm dark editorial typography, precise grids, and restrained motion.",
            sections: "Navigation; Hero; Selected work; Capabilities; Process; Contact",
            interactions: "Interactive project cards and navigation state",
            successCriteria: "Distinctive presentation; Responsive layout; Accessible controls; Finished content",
          } }] },
          { kind: "calls", calls: [{ name: "stage_file", args: { path: "index.html", content: html, language: "html" } }] },
          { kind: "calls", calls: [{ name: "stage_file", args: { path: "style.css", content: css, language: "css" } }] },
          { kind: "calls", calls: [{ name: "stage_file", args: { path: "script.js", content: js, language: "javascript" } }] },
          { kind: "calls", calls: [{ name: "review_build_quality", args: {} }] },
          { kind: "text", text: "The reviewed studio site is ready." },
        ];
        return responses[iteration++] as any;
      },
    });
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "ambiguous-quality", message: "build a website of your choice to showcase your skill" }),
    });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.execution).toMatchObject({ mode: "builder", qualityProfile: "creative-web", quality: { passed: true } });
    expect(body.artifact.quality.brief.concept).toContain("studio portfolio");
    expect(body.artifact.candidates).toHaveLength(3);
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
    // Reasoning's primary is openrouter:reasoning, which is absent
    // from this test's mock snapshot, so the resolver falls back to gemini:1.
    expect(j.roles.reasoning.providerId).toBe("gemini:1");
    expect(j.roles.reasoning.fallback).toBe(true);
  });

  it("/api/usage.json marks a role temporarily unavailable when all candidates are cooling", async () => {
    const future = Date.now() + 60_000;
    const { url } = spawn({
      snap: [
        { id: "openrouter:reasoning", model: "qwen/qwen3-next-80b-a3b-instruct:free", cooldownUntil: future, successCount: 0, rateLimitCount: 2 },
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
          models: [{ name: "qwen3.5:9b" }, { name: "qwen2.5-coder:32b" }],
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
      expect(j.required).toEqual(["qwen3.5:9b", "qwen2.5-coder:14b"]);
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

  it("/api/chat attaches grouped artifact metadata only to its final response", async () => {
    const fence = String.fromCharCode(96).repeat(3);
    const { url } = spawn({
      handler: async () => JSON.stringify({
        kind: "direct",
        answer: fence + 'html path="index.html"\n<h1>Ready</h1>\n' + fence,
      }),
    });
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "artifact-thread", message: "make a page" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      artifact: { projectId: string; projectName: string; candidates: Array<{ path: string; content: string }> };
    };
    expect(body.artifact.projectId).toBeTruthy();
    expect(body.artifact.projectName).toBeTruthy();
    expect(body.artifact.candidates).toEqual([{ path: "index.html", content: "<h1>Ready</h1>\n", language: "html" }]);
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
    expect(r.headers.get("access-control-allow-methods")).toContain("PUT");
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

  it("DELETE /api/sessions removes all saved session files", async () => {
    writeFileSync(join(sessionDir, "first.json"), JSON.stringify({
      version: 1,
      id: "first",
      history: [],
    }), "utf8");
    writeFileSync(join(sessionDir, "second.json"), JSON.stringify({
      version: 1,
      id: "second",
      history: [],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.deleted).toBe(2);
    expect(existsSync(join(sessionDir, "first.json"))).toBe(false);
    expect(existsSync(join(sessionDir, "second.json"))).toBe(false);
    const listed = await fetch(`${url}/api/sessions`);
    const listedJson: any = await listed.json();
    expect(listedJson.sessions).toEqual([]);
  });

  it("DELETE /api/sessions rejects cross-origin requests", async () => {
    writeFileSync(join(sessionDir, "kept.json"), JSON.stringify({
      version: 1,
      id: "kept",
      history: [],
    }), "utf8");

    const { url } = spawn();
    const r = await fetch(`${url}/api/sessions`, {
      method: "DELETE",
      headers: { Origin: "https://example.com" },
    });
    expect(r.status).toBe(403);
    expect(existsSync(join(sessionDir, "kept.json"))).toBe(true);
  });

  it("/api/role-instructions reads and writes the editable local instruction file", async () => {
    const { url } = spawn();

    const initial = await fetch(`${url}/api/role-instructions`);
    expect(initial.status).toBe(200);
    const before: any = await initial.json();
    expect(before.path).toBe(roleInstructionsPath);
    expect(before.instructions.global).toContain("rigorous expert collaborator");
    expect(before.instructions.roles.perception).toContain("Gather the evidence");
    expect(before.defaults).toEqual(before.instructions);

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
    expect(after.defaults.roles.reasoning).toContain("strongest defensible solution");

    const raw = JSON.parse(readFileSync(roleInstructionsPath, "utf8"));
    expect(raw.global).toBe("Use direct language.");
  });

  it("issues a non-cacheable CSRF token from the local security context", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/security/context`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const body: any = await r.json();
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("/api/role-instructions can persist the canonical defaults after customisation", async () => {
    const { url } = spawn();
    const initial: any = await (await fetch(`${url}/api/role-instructions`)).json();

    const saved = await fetch(`${url}/api/role-instructions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: initial.defaults }),
    });

    expect(saved.status).toBe(200);
    const restored: any = await saved.json();
    expect(restored.instructions).toEqual(initial.defaults);
    expect(JSON.parse(readFileSync(roleInstructionsPath, "utf8"))).toEqual(initial.defaults);
  });

  it("/api/role-instructions rejects non-JSON writes", async () => {
    const { url } = spawn();
    const saved = await fetch(`${url}/api/role-instructions`, {
      method: "PUT",
      body: JSON.stringify({ instructions: { global: "Nope" } }),
    });

    expect(saved.status).toBe(415);
  });

  it("/api/role-instructions rejects cross-origin writes", async () => {
    const { url } = spawn();
    const saved = await fetch(`${url}/api/role-instructions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ instructions: { global: "Nope" } }),
    });

    expect(saved.status).toBe(403);
  });

  it("/api/reasoning-models lists cached OpenRouter free models and persists the selection", async () => {
    const overridesPath = join(sessionDir, "model-overrides.json");
    const cachePath = join(sessionDir, "openrouter-free-models.json");
    process.env.MULTI_AGENT_MODEL_OVERRIDES = overridesPath;
    process.env.MULTI_AGENT_OPENROUTER_MODELS_CACHE = cachePath;
    writeFileSync(
      cachePath,
      `${JSON.stringify(
        {
          version: 1,
          fetchedAt: Date.now(),
          models: [
            {
              id: "general/strong-chat:free",
              name: "Strong Chat",
              contextLength: 131072,
              created: 2,
              reasoningCapable: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { url } = spawn({
      snap: [
        {
          id: "openrouter:reasoning",
          model: "qwen/qwen3-next-80b-a3b-instruct:free",
          cooldownUntil: 0,
          successCount: 0,
          rateLimitCount: 0,
          remainingPct: 100,
        },
      ],
    });

    const listed = await fetch(`${url}/api/reasoning-models`);
    expect(listed.status).toBe(200);
    const listedJson = await listed.json() as { models: Array<{ id: string }>; selected: { model: string } };
    expect(listedJson.models.map((m) => m.id)).toContain("general/strong-chat:free");
    expect(listedJson.selected.model).toBe("qwen/qwen3-next-80b-a3b-instruct:free");

    const saved = await fetch(`${url}/api/reasoning-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "general/strong-chat:free" }),
    });
    expect(saved.status).toBe(200);
    const savedJson = await saved.json() as { selected: { model: string } };
    expect(savedJson.selected.model).toBe("general/strong-chat:free");
    expect(readFileSync(overridesPath, "utf8")).toContain("general/strong-chat:free");
  });

  it("/api/reasoning-model rejects non-JSON writes", async () => {
    const { url } = spawn();
    const saved = await fetch(`${url}/api/reasoning-model`, {
      method: "PUT",
      body: JSON.stringify({ model: null }),
    });

    expect(saved.status).toBe(415);
  });

  it("/api/reasoning-model rejects cross-origin writes", async () => {
    const { url } = spawn();
    const saved = await fetch(`${url}/api/reasoning-model`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ model: null }),
    });

    expect(saved.status).toBe(403);
  });

  /** Pre-write a provider-models cache so the server reads it without network. */
  function writeProviderModelsCache(
    provider: string,
    models: Array<{ id: string; name?: string; contextLength?: number; reasoningCapable?: boolean }>,
  ): void {
    const dir = join(sessionDir, "models-cache");
    mkdirSync(dir, { recursive: true });
    process.env.MULTI_AGENT_PROVIDER_MODELS_CACHE = dir;
    writeFileSync(
      join(dir, `${provider}.json`),
      `${JSON.stringify({ version: 1, fetchedAt: Date.now(), models }, null, 2)}\n`,
      "utf8",
    );
  }

  it("/api/providers lists selectable providers and customisable roles", async () => {
    process.env.MULTI_AGENT_MODEL_OVERRIDES = join(sessionDir, "model-overrides.json");
    const { url } = spawn();
    const r = await fetch(`${url}/api/providers`);
    expect(r.status).toBe(200);
    const j = await r.json() as {
      providers: Array<{ id: string; label: string; configured: boolean }>;
      roles: string[];
      overrides: Record<string, unknown>;
    };
    const ids = j.providers.map((p) => p.id);
    expect(ids).toContain("nvidia");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("ollama");
    expect(j.providers.find((p) => p.id === "ollama")!.configured).toBe(true);
    expect(j.providers.find((p) => p.id === "nvidia")!).toHaveProperty("configured");
    expect(j.roles).toContain("action-code");
    expect(j.roles).not.toContain("perception");
    expect(typeof j.overrides).toBe("object");
  });

  it("/api/role-models lists a provider's models from cache with the default primary", async () => {
    process.env.MULTI_AGENT_MODEL_OVERRIDES = join(sessionDir, "model-overrides.json");
    writeProviderModelsCache("groq", [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }]);
    const { url } = spawn();
    const r = await fetch(`${url}/api/role-models?role=action-structural&provider=groq`);
    expect(r.status).toBe(200);
    const j = await r.json() as {
      models: Array<{ id: string }>;
      defaultPrimary: string;
      selected: unknown;
    };
    expect(j.models.map((m) => m.id)).toContain("llama-3.3-70b-versatile");
    expect(j.defaultPrimary).toBe("groq:llama-70b");
    expect(j.selected).toBeNull();
  });

  it("/api/role-models rejects a non-customisable role", async () => {
    const { url } = spawn();
    const r = await fetch(`${url}/api/role-models?role=perception&provider=groq`);
    expect(r.status).toBe(400);
  });

  it("/api/role-model sets then clears a per-role override", async () => {
    const overridesPath = join(sessionDir, "model-overrides.json");
    process.env.MULTI_AGENT_MODEL_OVERRIDES = overridesPath;
    const modelFetchImpl = (async () => new Response(JSON.stringify({
      models: [{ name: "qwen2.5-coder:14b" }],
    }), { status: 200 })) as typeof fetch;
    const { url } = spawn({ modelFetchImpl });

    const set = await fetch(`${url}/api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "action-code", provider: "ollama", model: "qwen2.5-coder:14b" }),
    });
    expect(set.status).toBe(200);
    const setJson = await set.json() as { selected: { provider: string; model: string } };
    expect(setJson.selected.provider).toBe("ollama");
    expect(setJson.selected.model).toBe("qwen2.5-coder:14b");
    expect(readFileSync(overridesPath, "utf8")).toContain("qwen2.5-coder:14b");

    const clear = await fetch(`${url}/api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "action-code", provider: null, model: null }),
    });
    expect(clear.status).toBe(200);
    const clearJson = await clear.json() as { selected: unknown };
    expect(clearJson.selected).toBeNull();
  });

  it("/api/role-model refuses to save when only a cached catalogue is available", async () => {
    const overridesPath = join(sessionDir, "model-overrides.json");
    process.env.MULTI_AGENT_MODEL_OVERRIDES = overridesPath;
    writeProviderModelsCache("ollama", [{ id: "stale-model:latest", name: "stale-model:latest" }]);
    const modelFetchImpl = (async () => {
      throw new Error("provider offline");
    }) as typeof fetch;
    const { url } = spawn({ modelFetchImpl });

    const response = await fetch(`${url}/api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "action-code", provider: "ollama", model: "stale-model:latest" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "could not verify 'ollama' against a live model catalogue; try again",
    });
  });

  it("/api/role-model rejects unknown roles and cross-origin writes", async () => {
    const { url } = spawn();
    const badRole = await fetch(`${url}/api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "perception", provider: "groq", model: "x" }),
    });
    expect(badRole.status).toBe(400);

    const crossOrigin = await fetch(`${url}/api/role-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ role: "action-code", provider: "ollama", model: "x" }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("/api/chat accepts images and routes the turn to the vision role", async () => {
    const seen: Array<{ name: string; payload: string }> = [];
    const { url } = spawn({
      handler: async (name, payload) => { seen.push({ name, payload }); return "i see it"; },
    });
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "img-sess",
        message: "what is this?",
        images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
      }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { reply: string; servedBy: string[] };
    expect(j.reply).toBe("i see it");
    expect(j.servedBy).toEqual(["vision"]);
    const visionCall = seen.find((s) => s.name === "vision");
    expect(visionCall).toBeTruthy();
    expect(visionCall!.payload).toContain("AAAA"); // image rode the turn to the model
  });

  it("rejects too many images and unsupported image mime types", async () => {
    const { url } = spawn();
    const tooMany = await fetch(`${url}/api/chat-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s",
        message: "hi",
        images: Array.from({ length: 5 }, () => ({ mimeType: "image/png", dataBase64: "AA" })),
      }),
    });
    expect(tooMany.status).toBe(400);

    const badMime = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s",
        message: "hi",
        images: [{ mimeType: "image/svg+xml", dataBase64: "AA" }],
      }),
    });
    expect(badMime.status).toBe(400);
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

    it("POST /api/files/diff returns a create preview for a missing file", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "site/index.html", content: "<h1>Hello</h1>\n" }),
      });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.path).toBe("site/index.html");
      expect(j.beforeSha256).toBeNull();
      expect(j.diff).toContain("--- /dev/null");
      expect(j.diff).toContain("+++ site/index.html");
      expect(j.diff).toContain("+<h1>Hello</h1>");
    });

    it("creates a reviewed missing file when its null hash is applied", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await localMutationFetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "site/index.html", content: "<h1>Hello</h1>\n", expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(200);
      expect(readFileSync(join(fileRoot, "site", "index.html"), "utf8")).toBe("<h1>Hello</h1>\n");
    });

    it("requires a CSRF token before a file write", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "blocked-without-token.txt", content: "no", expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(403);
      expect(existsSync(join(fileRoot, "blocked-without-token.txt"))).toBe(false);
    });

    it("rejects an oversized request body before parsing it", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await fetch(`${url}/api/files/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "oversized.txt", content: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
      });
      expect(r.status).toBe(413);
    });

    it("blocks sensitive names case-insensitively and Windows device names", async () => {
      writeFileSync(join(fileRoot, ".ENV"), "SECRET=still-blocked", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      const env = await fetch(`${url}/api/files/read?path=.ENV`);
      expect(env.status).toBe(403);
      const device = await fetch(`${url}/api/files/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "CON.txt", content: "blocked" }),
      });
      expect(device.status).toBe(403);
    });

    it("POST /api/files/write applies content when expectedSha256 matches", async () => {
      writeFileSync(join(fileRoot, "target.txt"), "original content\n", "utf8");
      const { url } = spawnWithRoot(fileRoot);
      // Get current sha256 via read
      const readRes = await fetch(`${url}/api/files/read?path=target.txt`);
      const { sha256 } = await readRes.json() as any;
      // Apply write
      const r = await localMutationFetch(`${url}/api/files/write`, {
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
      const r = await localMutationFetch(`${url}/api/files/write`, {
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
      const r = await localMutationFetch(`${url}/api/files/write`, {
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
      const r = await localMutationFetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "guard.txt", content: "x", expectedSha256: sha256 }), // no confirm
      });
      expect(r.status).toBe(400);
    });

    it("POST /api/files/write 403s on path traversal", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await localMutationFetch(`${url}/api/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../escape.txt", content: "x", expectedSha256: null, confirm: true }),
      });
      expect(r.status).toBe(403);
    });

    it("POST /api/files/write 403s on .env", async () => {
      const { url } = spawnWithRoot(fileRoot);
      const r = await localMutationFetch(`${url}/api/files/write`, {
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

  describe("goal endpoints", () => {
    let goalDir: string;

    beforeEach(() => {
      goalDir = mkdtempSync(join(tmpdir(), "multi-agent-goals-"));
    });
    afterEach(() => rmSync(goalDir, { recursive: true, force: true }));

    function spawnWithGoals() {
      const port = pickPort();
      const router = makeRouter([
        { id: "gemini:1", cooldownUntil: 0, successCount: 0, rateLimitCount: 0 },
      ]);
      // Resolver returns quickly so the goal runner doesn't hang tests.
      const resolver = makeResolver(async (_name, prompt) => {
        if (prompt.includes("next concrete action") || prompt.includes("Completed steps")) {
          return '{"nextPrompt":"","done":true,"summary":"Test goal complete"}';
        }
        return "step result";
      });
      const handle = startWebServer({
        router, resolver, port,
        sessionStorageDir: sessionDir,
        roleInstructionsPath,
        goalStorageDir: goalDir,
      });
      handles.push(handle);
      return { url: `http://localhost:${port}` };
    }

    it("POST /api/goal returns a goalId", async () => {
      const { url } = spawnWithGoals();
      const r = await fetch(`${url}/api/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Test goal" }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as any;
      expect(typeof body.goalId).toBe("string");
      expect(body.goalId).toMatch(/^goal_/);
    });

    it("GET /api/goals returns an array", async () => {
      const { url } = spawnWithGoals();
      // Create a goal first
      await fetch(`${url}/api/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "List test goal" }),
      });
      const r = await fetch(`${url}/api/goals`);
      expect(r.status).toBe(200);
      const body = await r.json() as any;
      expect(Array.isArray(body.goals)).toBe(true);
    });

    it("DELETE /api/goal/:id removes the goal", async () => {
      const { url } = spawnWithGoals();
      const createRes = await fetch(`${url}/api/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Delete test goal" }),
      });
      const { goalId } = await createRes.json() as any;

      const delRes = await fetch(`${url}/api/goal/${goalId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      // Should be gone from the list
      const listRes = await fetch(`${url}/api/goals`);
      const { goals } = await listRes.json() as any;
      expect(goals.find((g: any) => g.goalId === goalId)).toBeUndefined();
    });

    it("GET /api/goal/:id returns the goal session", async () => {
      const { url } = spawnWithGoals();
      const createRes = await fetch(`${url}/api/goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Get test goal" }),
      });
      const { goalId } = await createRes.json() as any;

      const r = await fetch(`${url}/api/goal/${goalId}`);
      expect(r.status).toBe(200);
      const body = await r.json() as any;
      expect(body.goalId).toBe(goalId);
      expect(body.description).toBe("Get test goal");
    });

    it("DELETE /api/goal/:id 404s for unknown id", async () => {
      const { url } = spawnWithGoals();
      const r = await fetch(`${url}/api/goal/goal_nonexistent`, { method: "DELETE" });
      expect(r.status).toBe(404);
    });
  });

  describe("reviewed artifact API", () => {
    let artifactRoot: string;
    let artifactStoreDir: string;
    let artifactHandles: Array<{ close: () => void }> = [];

    beforeEach(() => {
      artifactRoot = mkdtempSync(join(tmpdir(), "multi-agent-artifact-web-"));
      artifactStoreDir = mkdtempSync(join(tmpdir(), "multi-agent-artifact-store-"));
    });

    afterEach(() => {
      for (const handle of artifactHandles) handle.close();
      artifactHandles = [];
      rmSync(artifactRoot, { recursive: true, force: true });
      rmSync(artifactStoreDir, { recursive: true, force: true });
    });

    function spawnArtifacts() {
      const port = pickPort();
      const handle = startWebServer({
        router: makeRouter([]),
        resolver: makeResolver(async (_n, p) => `reply:${p}`),
        port,
        projectRoot: artifactRoot,
        projectsPath: join(artifactStoreDir, "projects.json"),
        allowList: [tmpdir()],
        sessionStorageDir: sessionDir,
      });
      artifactHandles.push(handle);
      return { url: `http://localhost:${port}` };
    }

    it("requires local mutation credentials before creating a proposal", async () => {
      const { url } = spawnArtifacts();
      const context: any = await (await fetch(`${url}/api/security/context`)).json();
      const response = await fetch(`${url}/api/artifacts/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: context.activeProjectId, sessionId: "s", sourceTurnId: "t",
          files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
        }),
      });
      expect(response.status).toBe(403);
    });

    it("creates, diffs, applies, and rolls back a project-bound file batch", async () => {
      const { url } = spawnArtifacts();
      const context: any = await (await fetch(`${url}/api/security/context`)).json();
      const create = await localMutationFetch(`${url}/api/artifacts/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: context.activeProjectId,
          sessionId: "session-1",
          sourceTurnId: "turn-1",
          title: "Landing page",
          files: [
            { path: "index.html", content: "<h1>Hello</h1>\n", language: "html" },
            { path: "assets/site.css", content: "body { margin: 0; }\n", language: "css" },
          ],
        }),
      });
      expect(create.status).toBe(201);
      const proposal = (await create.json() as { proposal: any }).proposal;
      expect(JSON.stringify(proposal)).not.toContain("<h1>Hello");
      const diff = await fetch(`${url}/api/artifacts/proposals/${proposal.id}/files/${proposal.files[0].id}/diff`);
      expect(diff.status).toBe(200);
      expect((await diff.json() as { diff: string }).diff).toContain("+<h1>Hello</h1>");

      const apply = await localMutationFetch(`${url}/api/artifacts/proposals/${proposal.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: context.activeProjectId,
          projectRevision: context.projectRevision,
          confirm: true,
        }),
      });
      expect(apply.status).toBe(200);
      const applied: any = await apply.json();
      expect(applied.undoExpiresAt).toBeGreaterThan(Date.now());
      expect(readFileSync(join(artifactRoot, "index.html"), "utf8")).toContain("Hello");

      const rollback = await localMutationFetch(`${url}/api/artifacts/transactions/${applied.transactionId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: context.activeProjectId,
          projectRevision: context.projectRevision,
          undoToken: applied.undoToken,
          confirm: true,
        }),
      });
      expect(rollback.status).toBe(200);
      expect(existsSync(join(artifactRoot, "index.html"))).toBe(false);
    });
  });

  it("/api/chat-stream preserves the resolver error type", async () => {
    const port = pickPort();
    const router = makeRouter([]);
    const resolver = {
      runRoleChatStream: async () => {
        const error = new Error("all candidates are cooling down");
        error.name = "AllProvidersExhaustedError";
        throw error;
      },
      listRoles: () => [],
      rosterDescription: () => "",
    } as unknown as import("../src/roles/resolver.js").RoleResolver;
    const handle = startWebServer({ router, resolver, port, sessionStorageDir: sessionDir });
    handles.push(handle);

    const response = await fetch(`http://localhost:${port}/api/chat-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "typed-error", message: "fail", forceRole: "orchestration" }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"kind":"error"');
    expect(body).toContain('"errorName":"AllProvidersExhaustedError"');
  });

  describe("project endpoints", () => {
    let projDir: string;
    let projDir2: string;
    let projStoreDir: string;
    let projHandles: Array<{ close: () => void }> = [];

    beforeEach(() => {
      projDir = mkdtempSync(join(tmpdir(), "multi-agent-proj-a-"));
      projDir2 = mkdtempSync(join(tmpdir(), "multi-agent-proj-b-"));
      projStoreDir = mkdtempSync(join(tmpdir(), "multi-agent-proj-store-"));
    });

    afterEach(() => {
      for (const h of projHandles) { try { h.close(); } catch { /* */ } }
      projHandles = [];
      rmSync(projDir, { recursive: true, force: true });
      rmSync(projDir2, { recursive: true, force: true });
      rmSync(projStoreDir, { recursive: true, force: true });
    });

    function spawnWithProjects() {
      const port = pickPort();
      const router = makeRouter([]);
      const resolver = makeResolver(async (_n, p) => `reply:${p}`);
      const projectsPath = join(projStoreDir, "projects.json");
      const handle = startWebServer({
        router, resolver, port,
        projectRoot: projDir,
        projectsPath,
        allowList: [tmpdir()],
        sessionStorageDir: sessionDir,
      });
      projHandles.push(handle);
      return { port, url: `http://localhost:${port}`, projectsPath };
    }

    it("GET /api/projects returns active project and list", async () => {
      const { url } = spawnWithProjects();
      const r = await fetch(`${url}/api/projects`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.active).toBeDefined();
      expect(Array.isArray(j.projects)).toBe(true);
      expect(Array.isArray(j.allowList)).toBe(true);
    });

    it("GET /api/files/root includes activeProjectId and projectName", async () => {
      const { url } = spawnWithProjects();
      const r = await fetch(`${url}/api/files/root`);
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.activeProjectId).toBeDefined();
      expect(typeof j.projectName).toBe("string");
      expect(j.pinnedFile === null || typeof j.pinnedFile === "string").toBe(true);
    });

    it("POST /api/projects adds a new project within allow-list", async () => {
      const { url } = spawnWithProjects();
      const tmpBase = join(tmpdir());
      const r = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "second", root: projDir2 }),
      });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.project.name).toBe("second");
      expect(j.project.id).toMatch(/^p_/);
    });

    it("requires a CSRF token before changing the project registry", async () => {
      const { url } = spawnWithProjects();
      const r = await fetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "blocked", root: projDir2 }),
      });
      expect(r.status).toBe(403);
    });

    it("creates a requested missing project root only when explicitly opted in", async () => {
      const { url } = spawnWithProjects();
      const root = join(projDir, "sites", "portfolio");
      const missing = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "missing", root }),
      });
      expect(missing.status).toBe(400);
      expect(existsSync(root)).toBe(false);

      const created = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "portfolio", root, createRoot: true }),
      });
      expect(created.status).toBe(200);
      expect(existsSync(root)).toBe(true);
    });

    it("POST /api/projects 409s on duplicate name", async () => {
      const { url, projectsPath } = spawnWithProjects();
      // Add once successfully
      await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dup", root: projDir2 }),
      });
      // Second attempt with same name
      const r = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dup", root: projDir2 }),
      });
      expect(r.status).toBe(409);
    });

    it("POST /api/projects/active switches project and re-points listDir", async () => {
      const { url } = spawnWithProjects();
      // Write a sentinel file in projDir2
      writeFileSync(join(projDir2, "sentinel.txt"), "found!", "utf8");

      // Add second project
      const addRes = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "second", root: projDir2 }),
      });
      const { project } = await addRes.json() as any;

      // Switch to it
      const switchRes = await localMutationFetch(`${url}/api/projects/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: project.id }),
      });
      expect(switchRes.status).toBe(200);

      // listDir should now show sentinel.txt from projDir2
      const listRes = await fetch(`${url}/api/files?path=.`);
      expect(listRes.status).toBe(200);
      const list: any = await listRes.json();
      expect(list.entries.some((e: any) => e.name === "sentinel.txt")).toBe(true);
    });

    it("keeps the current project active when a selected root is no longer valid", async () => {
      const { url } = spawnWithProjects();
      const before: any = await (await fetch(`${url}/api/projects`)).json();
      const addRes = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "removed-root", root: projDir2 }),
      });
      const { project } = await addRes.json() as any;
      rmSync(projDir2, { recursive: true, force: true });

      const switchRes = await localMutationFetch(`${url}/api/projects/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: project.id }),
      });
      expect(switchRes.status).toBe(400);
      const after: any = await (await fetch(`${url}/api/projects`)).json();
      expect(after.active.id).toBe(before.active.id);
    });

    it("POST /api/projects/active 404s for unknown id", async () => {
      const { url } = spawnWithProjects();
      const r = await localMutationFetch(`${url}/api/projects/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "p_nonexistent" }),
      });
      expect(r.status).toBe(404);
    });

    it("POST /api/projects/delete removes a project", async () => {
      const { url } = spawnWithProjects();
      const addRes = await localMutationFetch(`${url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "todelete", root: projDir2 }),
      });
      const { project } = await addRes.json() as any;
      const r = await localMutationFetch(`${url}/api/projects/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: project.id }),
      });
      expect(r.status).toBe(200);
    });

    it("POST /api/projects/delete 409s when only one project remains", async () => {
      const { url, projectsPath } = spawnWithProjects();
      const { readProjects } = await import("../src/project/store.js");
      const set = readProjects(projectsPath);
      const r = await localMutationFetch(`${url}/api/projects/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: set.activeId }),
      });
      expect(r.status).toBe(409);
    });

    it("POST /api/projects/pin sets pinned file", async () => {
      const { url } = spawnWithProjects();
      writeFileSync(join(projDir, "focus.ts"), "// focus", "utf8");
      const r = await localMutationFetch(`${url}/api/projects/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "focus.ts" }),
      });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.pinnedFile).toBe("focus.ts");
    });

    it("POST /api/projects/pin 403s on traversal", async () => {
      const { url } = spawnWithProjects();
      const r = await localMutationFetch(`${url}/api/projects/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../../escape.ts" }),
      });
      expect(r.status).toBe(403);
    });
  });
});
