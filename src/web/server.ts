/**
 * Minimal HTTP server exposing the multi-agent ChatSession over REST.
 *
 * Built on Node's built-in http module — no Express, no new dependency.
 * Designed for localhost personal use first; can be put behind a tunnel
 * (ngrok / Tailscale Funnel) or moved to a cheap host later.
 *
 * Routes:
 *   GET  /                       static index.html
 *   GET  /<asset>                static files from src/web/static/
 *   GET  /api/sessions           list saved session ids
 *   POST /api/chat               { sessionId, message } -> { reply, servedBy, ... }
 *   POST /api/sessions/:id/clear wipe session history
 *   GET  /api/usage              router usage snapshot as plain text
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "../router.js";
import type { RoleResolver } from "../roles/resolver.js";
import { ChatSession, listSessions } from "../chat/session.js";
import { formatUsageReport } from "../conservation.js";
import { RoleOrchestrator } from "../agents/role-orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  // .jsx is served as text/babel so the in-browser Babel <script type="text/babel">
  // picks them up. (Real build pipeline would compile ahead of time; this matches
  // the prototype's no-build approach for personal-use simplicity.)
  ".jsx": "text/babel; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

export interface ServerOptions {
  router: Router;
  resolver: RoleResolver;
  port?: number;
  /** When true, allow cross-origin requests (browsers from other origins). Default false. */
  cors?: boolean;
}

export function startWebServer(opts: ServerOptions): { close: () => void; url: string } {
  const port = opts.port ?? 7421;

  const server = createServer(async (req, res) => {
    try {
      if (opts.cors) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const pathname = url.pathname;

      // --- API routes ---
      if (pathname === "/api/usage" && req.method === "GET") {
        sendText(res, 200, formatUsageReport(opts.router));
        return;
      }

      if (pathname === "/api/usage.json" && req.method === "GET") {
        // Machine-readable counterpart for the web sidebar's live gauges.
        // Maps each sidebar role to its primary provider's snapshot row so
        // the UI doesn't have to know the role-registry layout.
        const snap = opts.router.snapshot();
        const byId = Object.fromEntries(snap.map((p) => [p.id, p]));
        // The 5 roles the sidebar surfaces (matches MM_AGENTS in app.jsx).
        // Each role's *primary* candidate id — see roles/default-registry.ts.
        const roleToPrimaryId: Record<string, string> = {
          "orchestration": "gemini:1",
          "perception": "gemini:1",
          "reasoning": "openrouter:deepseek-v4",
          "action-code": "mistral:codestral",
          "action-structural": "groq:llama-70b",
        };
        const roles: Record<string, unknown> = {};
        for (const [role, primaryId] of Object.entries(roleToPrimaryId)) {
          const p = byId[primaryId];
          roles[role] = p
            ? {
                providerId: p.id,
                successCount: p.successCount,
                rateLimitCount: p.rateLimitCount,
                remainingPct: p.remainingPct ?? null,
                cooling: p.cooldownUntil > Date.now(),
              }
            : { providerId: primaryId, registered: false };
        }
        sendJson(res, 200, {
          mode: opts.router.getMode(),
          providers: snap.map((p) => ({
            id: p.id,
            successCount: p.successCount,
            rateLimitCount: p.rateLimitCount,
            remainingPct: p.remainingPct ?? null,
            cooling: p.cooldownUntil > Date.now(),
          })),
          roles,
        });
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        sendJson(res, 200, { sessions: listSessions() });
        return;
      }

      if (pathname === "/api/complete" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { prompt?: string } | null;
        if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) {
          sendJson(res, 400, { error: "prompt (non-empty string) required" });
          return;
        }
        try {
          // Single-shot completion through the orchestration role. Routes to
          // Gemini by default with full failover semantics.
          const reply = await opts.resolver.runRole("orchestration", parsed.prompt);
          sendJson(res, 200, { reply });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/task" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { prompt?: string } | null;
        if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) {
          sendJson(res, 400, { error: "prompt (non-empty string) required" });
          return;
        }
        try {
          // Same orchestration path as `npm run cli -- task <prompt>`:
          // plan -> optional specialist role calls -> synthesis.
          const orchestrator = new RoleOrchestrator({ resolver: opts.resolver });
          const result = await orchestrator.runWithTrace(parsed.prompt);
          sendJson(res, 200, {
            reply: result.finalOutput,
            plan: result.plan.kind,
            perRole: result.perRole ?? [],
          });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { sessionId?: string; message?: string } | null;
        if (!parsed?.sessionId || typeof parsed.message !== "string") {
          sendJson(res, 400, { error: "sessionId (string) and message (string) required" });
          return;
        }
        const session = new ChatSession({ resolver: opts.resolver, id: parsed.sessionId });
        try {
          const result = await session.send(parsed.message);
          sendJson(res, 200, {
            reply: result.reply,
            servedBy: result.servedBy,
            plan: result.plan?.kind,
            summarizedTurns: result.summarizedTurns ?? 0,
            tokenEstimate: result.tokenEstimate,
            budgetPct: Math.round(result.budgetPct),
            warning: result.warning ?? null,
            turns: session.turnCount(),
          });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      const clearMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/clear$/);
      if (clearMatch && req.method === "POST") {
        const id = decodeURIComponent(clearMatch[1]!);
        const session = new ChatSession({ resolver: opts.resolver, id });
        session.clear();
        sendJson(res, 200, { cleared: id });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "GET") {
        const id = decodeURIComponent(sessionMatch[1]!);
        const session = new ChatSession({ resolver: opts.resolver, id });
        sendJson(res, 200, {
          id,
          turns: session.turnCount(),
          tokenEstimate: session.estimateTokens(),
          history: session.snapshot().history,
        });
        return;
      }

      // --- Static files ---
      if (req.method === "GET") {
        const filePath = pathname === "/" ? "/index.html" : pathname;
        const full = join(STATIC_DIR, filePath.replace(/^\//, ""));
        // Prevent directory traversal: resolved path must live under STATIC_DIR.
        if (!full.startsWith(STATIC_DIR)) {
          sendText(res, 403, "forbidden");
          return;
        }
        if (existsSync(full) && statSync(full).isFile()) {
          const body = readFileSync(full);
          res.setHeader("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
          res.statusCode = 200;
          res.end(body);
          return;
        }
      }

      sendText(res, 404, "not found");
    } catch (err) {
      console.error("[web] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  server.listen(port);
  const url = `http://localhost:${port}/`;
  return {
    url,
    close: () => server.close(),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", MIME[".json"]!);
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}
