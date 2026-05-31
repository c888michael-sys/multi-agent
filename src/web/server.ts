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
import type { RoleName } from "../roles/types.js";
import { ChatSession, listSessions } from "../chat/session.js";
import { formatUsageReport } from "../conservation.js";
import { RoleOrchestrator } from "../agents/role-orchestrator.js";
import { DEFAULT_ROLES } from "../roles/default-registry.js";
import {
  DEFAULT_ROLE_INSTRUCTIONS_PATH,
  readRoleInstructions,
  writeRoleInstructions,
} from "../roles/instructions.js";
import { LOCAL_OLLAMA_MODELS } from "../config.js";
import type { CompleteOptions } from "../provider.js";
import type { RoutingMode } from "../agents/multi-agent-workflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_ROLES: ReadonlySet<RoleName> = new Set<RoleName>([
  "perception",
  "reasoning",
  "orchestration",
  "action-code",
  "action-structural",
  "action-repetitive",
  "mindmap-categorize",
]);

/**
 * Translate the optional CLI-parity flags (`thinking`, `useSearch`,
 * `forceRole`) from a /api/chat or /api/chat-stream body into the
 * ChatSession.send() argument shape. Invalid forceRole values are
 * dropped silently — better than 400'ing a chat turn just because a
 * stale UI sent an unknown role.
 */
function buildChatOpts(parsed: {
  thinking?: "low" | "medium" | "high" | null;
  useSearch?: boolean;
  forceRole?: string | null;
  routingMode?: string | null;
}): { opts: CompleteOptions; routing: { forceRole?: RoleName; mode?: RoutingMode } } {
  const opts: CompleteOptions = {};
  if (parsed.thinking === "low" || parsed.thinking === "medium" || parsed.thinking === "high") {
    opts.thinking = parsed.thinking;
  }
  if (parsed.useSearch === true) {
    opts.useSearch = true;
  }
  const routing: { forceRole?: RoleName; mode?: RoutingMode } = {};
  const fr = parsed.forceRole;
  if (typeof fr === "string" && VALID_ROLES.has(fr as RoleName)) {
    routing.forceRole = fr as RoleName;
  }
  // Routing mode: 'smart' (default) → orchestrator plans per turn;
  // 'round-robin' → ChatSession forces a parallel fan-out across all
  // four specialists, synthesizing through orchestration. The actual
  // execution happens inside ChatSession.send via the routing arg.
  if (parsed.routingMode === "smart" || parsed.routingMode === "auto") {
    routing.mode = "auto";
  } else if (parsed.routingMode === "round-robin" || parsed.routingMode === "brainstorming") {
    routing.mode = "brainstorming";
  } else if (parsed.routingMode === "multi-agent") {
    routing.mode = "multi-agent";
  }
  return { opts, routing };
}
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

function normalizeRoutingMode(value: unknown): RoutingMode {
  if (value === "smart" || value === "auto") return "auto";
  if (value === "round-robin" || value === "brainstorming") return "brainstorming";
  if (value === "multi-agent") return "multi-agent";
  return "multi-agent";
}

export interface ServerOptions {
  router: Router;
  /** Default resolver — used when the request body does not specify `useLocal`. */
  resolver: RoleResolver;
  /** Optional local-mode resolver. Selected per request when `useLocal: true`. */
  localResolver?: RoleResolver;
  /** Optional cloud-mode resolver. Selected per request when `useLocal: false`. */
  cloudResolver?: RoleResolver;
  port?: number;
  /** When true, allow cross-origin requests (browsers from other origins). Default false. */
  cors?: boolean;
  /** Override chat-session storage directory. Used by tests; default is ~/.multi-agent/sessions. */
  sessionStorageDir?: string;
  /** Override web-editable role-instruction file. Used by tests; default is ~/.multi-agent/role-instructions.json. */
  roleInstructionsPath?: string;
}

/**
 * Select the resolver for this request based on the optional `useLocal`
 * field in the body. When the chosen alternative isn't registered (e.g.
 * `localResolver` not supplied), falls back to the default `resolver`.
 */
function resolverFor(opts: ServerOptions, useLocal: boolean | undefined): RoleResolver {
  if (useLocal === true && opts.localResolver) return opts.localResolver;
  if (useLocal === false && opts.cloudResolver) return opts.cloudResolver;
  return opts.resolver;
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

      if (pathname === "/api/ollama-health" && req.method === "GET") {
        // Pings the configured Ollama daemon and reports which of the two
        // required hybrid-mode models are actually pulled. The web UI calls
        // this before letting the user enable "Hybrid local models" — if
        // the daemon isn't running OR the models aren't pulled, the toggle
        // is refused with a clear reason rather than silently failing on
        // the next chat turn.
        const baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
        const required = Object.values(LOCAL_OLLAMA_MODELS).map(
          (m) => process.env[m.modelEnv]?.trim() || m.model,
        );
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1500);
          const tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
          clearTimeout(timer);
          if (!tagsRes.ok) {
            sendJson(res, 200, {
              reachable: false,
              baseUrl,
              required,
              missing: required,
              reason: `Ollama responded ${tagsRes.status}`,
            });
            return;
          }
          const json = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
          const installed = (json.models ?? []).map((m) => String(m.name ?? ""));
          const missing = required.filter((m) => !installed.some((i) => i === m || i.startsWith(`${m}-`)));
          sendJson(res, 200, {
            reachable: true,
            baseUrl,
            installed,
            required,
            missing,
          });
        } catch (err) {
          sendJson(res, 200, {
            reachable: false,
            baseUrl,
            required,
            missing: required,
            reason: (err as Error).message,
          });
        }
        return;
      }

      if (pathname === "/api/usage.json" && req.method === "GET") {
        // Machine-readable counterpart for the web sidebar's live gauges.
        // Exposes both RPM (rolling 60s window) and RPD (daily, UTC reset)
        // plus an accurate cooldown countdown in milliseconds.
        //
        // `?local=1` makes the snapshot read role candidates from the
        // local-prepend resolver so the sidebar's per-role primary/fallback
        // attribution reflects the hybrid-mode chains (reasoning →
        // ollama:deepseek-r1, action-code → ollama:qwen2.5-coder).
        const useLocal = url.searchParams.get("local") === "1";
        const activeResolver = resolverFor(opts, useLocal);
        const snap = opts.router.snapshot();
        const roles = roleUsageSnapshot(snap, activeResolver);
        sendJson(res, 200, {
          mode: opts.router.getMode(),
          useLocal,
          providers: snap.map((p) => ({
            id: p.id,
            successCount: p.successCount,
            rateLimitCount: p.rateLimitCount,
            remainingPct: p.remainingPct ?? null,
            estimatedDailyBudget: p.estimatedDailyBudget ?? null,
            rpmCount: p.rpmCount,
            rpmCap: p.rpmCap ?? null,
            rpmSource: p.rpmSource,
            rpdSource: p.rpdSource,
            liveQuotaFetchedAt: p.liveQuotaFetchedAt ?? null,
            cooling: p.cooldownMsRemaining > 0,
            cooldownMsRemaining: p.cooldownMsRemaining,
          })),
          roles,
        });
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        sendJson(res, 200, { sessions: listSessions(opts.sessionStorageDir) });
        return;
      }

      if (pathname === "/api/role-instructions" && req.method === "GET") {
        const path = roleInstructionsPath(opts);
        sendJson(res, 200, { path, instructions: readRoleInstructions(path) });
        return;
      }

      if (pathname === "/api/role-instructions" && req.method === "PUT") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { instructions?: unknown } | null;
        if (!parsed || typeof parsed !== "object") {
          sendJson(res, 400, { error: "JSON body required" });
          return;
        }
        const path = roleInstructionsPath(opts);
        const instructions = writeRoleInstructions(path, parsed.instructions ?? parsed);
        sendJson(res, 200, { path, instructions });
        return;
      }

      if (pathname === "/api/complete" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { prompt?: string; role?: string; useLocal?: boolean } | null;
        if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) {
          sendJson(res, 400, { error: "prompt (non-empty string) required" });
          return;
        }
        try {
          // Single-shot completion through the requested role (default
          // orchestration). The mindmap pre-fetch uses the dedicated
          // mindmap-categorize role and passes useLocal:false so a burst
          // never depends on local Ollama availability.
          const role = (parsed.role as RoleName) || ("orchestration" as RoleName);
          const r = resolverFor(opts, parsed.useLocal);
          const reply = await r.runRole(role, parsed.prompt);
          sendJson(res, 200, { reply });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/task" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { prompt?: string; mode?: string | null } | null;
        if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) {
          sendJson(res, 400, { error: "prompt (non-empty string) required" });
          return;
        }
        try {
          // Same orchestration path as `npm run cli -- task <prompt>`:
          // plan -> optional specialist role calls -> synthesis.
          const orchestrator = new RoleOrchestrator({ resolver: opts.resolver });
          const mode = normalizeRoutingMode(parsed.mode);
          const result = await orchestrator.runWithTrace(parsed.prompt, undefined, mode);
          sendJson(res, 200, {
            reply: result.finalOutput,
            plan: mode === "multi-agent" ? "multi-agent" : result.plan.kind,
            perRole: result.perRole ?? [],
          });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as
          | {
              sessionId?: string;
              message?: string;
              thinking?: "low" | "medium" | "high" | null;
              useSearch?: boolean;
              forceRole?: string | null;
              useLocal?: boolean;
              routingMode?: string | null;
            }
          | null;
        if (!parsed?.sessionId || typeof parsed.message !== "string") {
          sendJson(res, 400, { error: "sessionId (string) and message (string) required" });
          return;
        }
        const chatOpts = buildChatOpts(parsed);
        const session = createChatSession(opts, parsed.sessionId, parsed.useLocal);
        try {
          const result = await session.send(parsed.message, chatOpts.opts, undefined, chatOpts.routing);
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

      // SSE streaming variant of /api/chat. Same request body, but the
      // response is a text/event-stream that emits one event per
      // ChatSession progress event (plan-start, plan, role-start,
      // role-end, token, summarize-*) followed by a final `done` event
      // carrying the SendResult shape. Each event is a `data: <json>\n\n`
      // frame; events have no event name (default 'message').
      if (pathname === "/api/chat-stream" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as
          | {
              sessionId?: string;
              message?: string;
              thinking?: "low" | "medium" | "high" | null;
              useSearch?: boolean;
              forceRole?: string | null;
              useLocal?: boolean;
              routingMode?: string | null;
            }
          | null;
        if (!parsed?.sessionId || typeof parsed.message !== "string") {
          sendJson(res, 400, { error: "sessionId (string) and message (string) required" });
          return;
        }
        const chatOpts = buildChatOpts(parsed);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        // Disable default Node compression for this response — interferes with
        // streaming. (We don't enable compression elsewhere, but be explicit.)
        res.setHeader("X-Accel-Buffering", "no");
        // Flush headers eagerly so the browser sees the stream is alive.
        res.write(`:\n\n`);
        const writeEvent = (payload: unknown) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        const session = createChatSession(opts, parsed.sessionId, parsed.useLocal);
        try {
          const result = await session.send(
            parsed.message,
            chatOpts.opts,
            (evt) => { writeEvent(evt); },
            chatOpts.routing,
          );
          writeEvent({
            kind: "done",
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
          writeEvent({ kind: "error", error: (err as Error).message });
        } finally {
          res.end();
        }
        return;
      }

      const clearMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/clear$/);
      if (clearMatch && req.method === "POST") {
        const id = decodeURIComponent(clearMatch[1]!);
        const session = createChatSession(opts, id);
        session.clear();
        sendJson(res, 200, { cleared: id });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "GET") {
        const id = decodeURIComponent(sessionMatch[1]!);
        const session = createChatSession(opts, id);
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

type ProviderSnapshot = ReturnType<Router["snapshot"]>[number];

function roleUsageSnapshot(
  snap: ProviderSnapshot[],
  resolver?: RoleResolver,
): Record<string, unknown> {
  const byId = new Map(snap.map((p) => [p.id, p]));
  const now = Date.now();
  const roles: Record<string, unknown> = {};

  // When a specific resolver is supplied (e.g. the local-mode resolver),
  // walk its role candidate list — that way the sidebar's primary +
  // fallback attribution matches whichever resolver actually serves the
  // current chat traffic. Without a resolver argument we fall back to
  // DEFAULT_ROLES for backwards compat with anything that still calls
  // this helper plainly.
  // Prefer the resolver's chains so local-mode prepends show up in the
  // snapshot. If the resolver supplies no roles (e.g., test stubs),
  // fall back to DEFAULT_ROLES rather than returning an empty mapping.
  const resolverChains = resolver?.listRoles();
  const roleConfigs = resolverChains && resolverChains.length > 0
    ? resolverChains
    : DEFAULT_ROLES;

  for (const role of roleConfigs) {
    const primaryId = role.candidates[0]?.providerId ?? "";
    const registered = role.candidates
      .map((c) => byId.get(c.providerId))
      .filter((p): p is ProviderSnapshot => Boolean(p));
    const ready = registered.find((p) => p.cooldownUntil <= now);
    const picked = ready ?? registered[0];

    if (!picked) {
      roles[role.name] = {
        providerId: primaryId,
        primaryProviderId: primaryId,
        registered: false,
        status: "unavailable",
      };
      continue;
    }

    const cooling = !ready;
    roles[role.name] = {
      providerId: picked.id,
      primaryProviderId: primaryId,
      registered: true,
      status: cooling ? "temporarily-unavailable" : "ready",
      fallback: picked.id !== primaryId,
      successCount: picked.successCount,
      rateLimitCount: picked.rateLimitCount,
      remainingPct: picked.remainingPct ?? null,
      estimatedDailyBudget: picked.estimatedDailyBudget ?? null,
      rpmCount: picked.rpmCount,
      rpmCap: picked.rpmCap ?? null,
      rpmSource: picked.rpmSource,
      rpdSource: picked.rpdSource,
      liveQuotaFetchedAt: picked.liveQuotaFetchedAt ?? null,
      cooldownUntil: picked.cooldownUntil,
      cooldownMsRemaining: picked.cooldownMsRemaining,
      cooling,
      candidates: registered.map((p) => ({
        providerId: p.id,
        cooling: p.cooldownMsRemaining > 0,
        cooldownMsRemaining: p.cooldownMsRemaining,
        remainingPct: p.remainingPct ?? null,
        rpmCount: p.rpmCount,
        rpmCap: p.rpmCap ?? null,
        rpmSource: p.rpmSource,
        rpdSource: p.rpdSource,
      })),
    };
  }

  return roles;
}

function createChatSession(opts: ServerOptions, id: string, useLocal?: boolean): ChatSession {
  const roleInstructionsPathValue = roleInstructionsPath(opts);
  return new ChatSession({
    resolver: resolverFor(opts, useLocal),
    id,
    roleInstructions: readRoleInstructions(roleInstructionsPathValue),
    ...(opts.sessionStorageDir && { storagePath: join(opts.sessionStorageDir, `${id}.json`) }),
  });
}

function roleInstructionsPath(opts: ServerOptions): string {
  return opts.roleInstructionsPath ?? DEFAULT_ROLE_INSTRUCTIONS_PATH;
}
