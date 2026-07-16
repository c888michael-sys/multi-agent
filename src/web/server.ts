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
 *   GET  /api/sessions           list saved session summaries
 *   DELETE /api/sessions         delete all saved sessions
 *   POST /api/chat               { sessionId, message } -> { reply, servedBy, ... }
 *   POST /api/sessions/:id/clear wipe session history
 *   GET  /api/usage              router usage snapshot as plain text
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { WebFileService, FILE_MAX_BYTES } from "./file-service.js";
import { BuilderStage } from "./builder-stage.js";
import { resolveBuilderIntent, type BuilderMode } from "./builder-intent.js";
import { ArtifactService } from "./artifact-service.js";
import { parseArtifactCandidates, type ArtifactCandidate } from "./artifact-parser.js";
import { fileURLToPath } from "node:url";
import type { Router } from "../router.js";
import type { RoleResolver } from "../roles/resolver.js";
import type { RoleName } from "../roles/types.js";
import type { ImagePart, Tool } from "../tools/types.js";
import {
  ChatSession,
  deleteAllSessions,
  deleteSession,
  duplicateSession,
  exportSessionRaw,
  isSafeSessionId,
  listSessionSummaries,
  updateSessionMetadata,
} from "../chat/session.js";
import { formatUsageReport } from "../conservation.js";
import { RoleOrchestrator } from "../agents/role-orchestrator.js";
import { DEFAULT_ROLES } from "../roles/default-registry.js";
import {
  DEFAULT_ROLE_INSTRUCTIONS_PATH,
  defaultRoleInstructions,
  readRoleInstructions,
  writeRoleInstructions,
} from "../roles/instructions.js";
import {
  LOCAL_OLLAMA_MODELS,
  apiKeyForOverrideProvider,
  isOverrideProviderConfigured,
} from "../config.js";
import {
  listOpenRouterFreeTextModels,
} from "../models/openrouter-models.js";
import { listModelsForProvider } from "../models/provider-models.js";
import {
  DEFAULT_OPENROUTER_REASONING_MODEL,
  readReasoningModelOverride,
  resetReasoningModelOverride,
  writeReasoningModelOverride,
  readAllRoleModelOverrides,
  readRoleModelOverride,
  writeRoleModelOverride,
  clearRoleModelOverride,
  CUSTOMISABLE_ROLES,
  OVERRIDE_PROVIDER_NAMES,
  type CustomisableRole,
  type OverrideProviderName,
} from "../models/reasoning-model-overrides.js";
import type { CompleteOptions } from "../provider.js";
import type { RoutingMode } from "../agents/multi-agent-workflow.js";
import { GoalStore, newGoalId, type GoalSession } from "../goal/goal-session.js";
import { runGoalLoop, type GoalProgress } from "../goal/runner.js";
import {
  addProject,
  assertWithinAllowList,
  createProjectRoot,
  getActiveProject,
  listProjects,
  readProjects,
  removeProject,
  resolveAllowList,
  setActiveProject,
  setPinnedFile,
  writeProjects,
  DEFAULT_PROJECTS_PATH,
} from "../project/store.js";

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

/** Display labels for the override providers in the model-routing picker. */
const PROVIDER_LABELS: Record<OverrideProviderName, string> = {
  openrouter: "OpenRouter",
  nvidia: "NVIDIA",
  groq: "Groq",
  cerebras: "Cerebras",
  mistral: "Mistral",
  gemini: "Gemini",
  ollama: "Ollama (local)",
};

function isCustomisableRoleName(value: string): value is CustomisableRole {
  return (CUSTOMISABLE_ROLES as readonly string[]).includes(value);
}

function isOverrideProviderName(value: string): value is OverrideProviderName {
  return (OVERRIDE_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** The role's default (non-override) primary provider id, for the picker UI. */
function defaultPrimaryFor(role: CustomisableRole): string {
  const cfg = DEFAULT_ROLES.find((r) => r.name === role);
  return cfg?.candidates[0]?.providerId ?? "";
}

const MAX_CHAT_IMAGES = 4;
const MAX_IMAGE_BASE64_LEN = 7_000_000; // ~5 MB of binary once decoded
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Validate the optional `images` field of a chat body. Returns the cleaned
 * ImagePart[] (possibly empty) or an error string for a 400. Caps count and
 * per-image size, and restricts the mime type to a small image allowlist.
 */
function parseChatImages(raw: unknown): { images: ImagePart[] } | { error: string } {
  if (raw === undefined || raw === null) return { images: [] };
  if (!Array.isArray(raw)) return { error: "images must be an array" };
  if (raw.length > MAX_CHAT_IMAGES) return { error: `too many images (max ${MAX_CHAT_IMAGES})` };
  const images: ImagePart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "each image must be an object" };
    const { mimeType, dataBase64 } = item as { mimeType?: unknown; dataBase64?: unknown };
    if (typeof mimeType !== "string" || !ALLOWED_IMAGE_MIME.has(mimeType)) {
      return { error: `unsupported image type: ${String(mimeType)}` };
    }
    if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
      return { error: "image dataBase64 must be a non-empty string" };
    }
    if (dataBase64.length > MAX_IMAGE_BASE64_LEN) {
      return { error: "image too large (max ~5 MB each)" };
    }
    images.push({ mimeType, dataBase64 });
  }
  return { images };
}

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
  } else if (parsed.routingMode === "fast") {
    routing.mode = "fast";
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
  /** Initial browser setting for hybrid mode. User-local settings can override it. */
  defaultUseLocal?: boolean;
  port?: number;
  /** When true, allow cross-origin requests (browsers from other origins). Default false. */
  cors?: boolean;
  /** Override chat-session storage directory. Used by tests; default is ~/.multi-agent/sessions. */
  sessionStorageDir?: string;
  /** Override web-editable role-instruction file. Used by tests; default is ~/.multi-agent/role-instructions.json. */
  roleInstructionsPath?: string;
  /** Project root exposed to the web file browser. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Override goal storage directory. Used by tests; default is ~/.multi-agent/goals. */
  goalStorageDir?: string;
  /** Override projects registry path. Used by tests; default is ~/.multi-agent/projects.json. */
  projectsPath?: string;
  /** Override allowed base directories for new projects. Used by tests; default from MULTI_AGENT_PROJECT_ROOTS. */
  allowList?: string[];
  /** Override provider-catalogue HTTP requests. Used by tests. */
  modelFetchImpl?: typeof fetch;
  /** Address to bind. Defaults to IPv4 loopback for local-only operation. */
  host?: string;
}

/** Upper bound for any JSON request handled by the web server. */
export const MAX_REQUEST_BODY_BYTES = 3 * 1024 * 1024;

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

function runtimeConfig(opts: ServerOptions): {
  defaultUseLocal: boolean;
  localModels: Array<{ role: string; providerId: string; model: string }>;
} {
  return {
    defaultUseLocal: opts.defaultUseLocal === true,
    localModels: Object.entries(LOCAL_OLLAMA_MODELS).map(([role, model]) => ({
      role,
      providerId: model.providerId,
      model: process.env[model.modelEnv]?.trim() || model.model,
    })),
  };
}

/** Allowed Origin values for state-changing file endpoints (localhost only). */
function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // direct API / curl — no Origin header
  return (
    origin === `http://localhost:${port}` ||
    origin === `http://127.0.0.1:${port}`
  );
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;
}

function isAllowedFetchSite(site: string | string[] | undefined): boolean {
  return !site || (!Array.isArray(site) && (site === "same-origin" || site === "none"));
}

function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").toLowerCase().includes("application/json");
}

function matchesCsrfToken(value: string | string[] | undefined, expected: string): boolean {
  if (!value || Array.isArray(value)) return false;
  const received = Buffer.from(value);
  const token = Buffer.from(expected);
  return received.length === token.length && timingSafeEqual(received, token);
}

/**
 * Apply the local-write boundary shared by project and file mutation routes.
 * This deliberately has no browser-only assumptions so scripted local clients
 * can use it after first fetching the security context.
 */
function mutationRequestError(req: IncomingMessage, port: number, csrfToken: string): string | null {
  if (!isJsonRequest(req)) return "Content-Type must be application/json";
  if (!isAllowedHost(req.headers.host, port)) return "writes must target the local web server";
  if (!isAllowedOrigin(req.headers.origin, port)) return "cross-origin writes are not allowed";
  if (!isAllowedFetchSite(req.headers["sec-fetch-site"])) return "cross-site writes are not allowed";
  if (!matchesCsrfToken(req.headers["x-csrf-token"], csrfToken)) return "valid X-CSRF-Token required";
  return null;
}

function sendArtifactError(res: ServerResponse, err: unknown): void {
  const error = err as Error & { code?: string; rollbackFailures?: string[] };
  const code = error.code ?? "INVALID_ARTIFACT";
  const status =
    code === "PROJECT_CONTEXT_CHANGED" || code === "ARTIFACT_CONFLICT" || code === "PROPOSAL_NOT_PENDING" ? 409 :
    code === "PROPOSAL_NOT_FOUND" || code === "FILE_NOT_FOUND" || code === "TRANSACTION_NOT_FOUND" ? 404 :
    code === "TOO_LARGE" || code === "TOO_MANY_FILES" ? 413 :
    code === "BLOCKED" || code === "TRAVERSAL" ? 403 :
    code === "BINARY" ? 415 : 400;
  sendJson(res, status, {
    error: error.message,
    code,
    ...(error.rollbackFailures?.length ? { rollbackFailures: error.rollbackFailures } : {}),
  });
}

export function startWebServer(opts: ServerOptions): { close: () => void; url: string } {
  const port = opts.port ?? 7421;
  const host = opts.host ?? "127.0.0.1";
  const csrfToken = randomBytes(32).toString("hex");
  const projectsPath = opts.projectsPath ?? DEFAULT_PROJECTS_PATH;
  const serverAllowList = opts.allowList ?? resolveAllowList();

  // When an isolated projectsPath is provided (test mode), write the initial state to
  // disk immediately so that every in-request readProjects call returns consistent IDs.
  // readProjects on a missing file generates a new random ID each call, which would make
  // project lookups fail with NOT_FOUND on the very first API call.
  if (opts.projectsPath) {
    const set = readProjects(projectsPath);
    if (opts.projectRoot) {
      const active = set.projects.find((p) => p.id === set.activeId);
      if (active) active.root = resolve(opts.projectRoot);
    }
    writeProjects(projectsPath, set);
  }

  // Root resolution:
  //   1. opts.projectRoot without isolated store → use directly (backward compat, no store pollution)
  //   2. Isolated store (opts.projectsPath given) → read from the now-persisted store
  //   3. Neither → cwd (old default; CLI always passes projectRoot explicitly)
  const initialRoot = !opts.projectsPath && opts.projectRoot
    ? resolve(opts.projectRoot)
    : opts.projectsPath
      ? resolve(getActiveProject(projectsPath).root)
      : resolve(process.cwd());

  let fileService = new WebFileService(initialRoot);

  function rebuildFileService(): void {
    fileService = new WebFileService(resolve(getActiveProject(projectsPath).root));
  }

  /** Resolve an artifact request against the *currently active* project. */
  function artifactProjectContext(projectId: string) {
    // Legacy single-root callers (including the original file-browser tests)
    // have no isolated project store. Bind artifacts to the root that server
    // actually serves instead of the persisted default project's unrelated root.
    const storedActive = getActiveProject(projectsPath);
    const active = opts.projectsPath
      ? storedActive
      : { ...storedActive, root: fileService.root };
    if (active.id !== projectId) {
      throw Object.assign(new Error("the active project changed; refresh the proposal"), { code: "PROJECT_CONTEXT_CHANGED" });
    }
    if (opts.projectsPath) assertWithinAllowList(active.root, serverAllowList);
    const files = new WebFileService(resolve(active.root));
    const revision = createHash("sha256")
      .update(`${active.id}\0${files.realRoot}`, "utf8")
      .digest("hex");
    return { project: active, revision, files };
  }

  function projectRevision() {
    const active = getActiveProject(projectsPath);
    return artifactProjectContext(active.id).revision;
  }

  function responseArtifact(reply: string, sessionId: string, stagedCandidates?: ArtifactCandidate[], capturedContext?: ReturnType<typeof artifactProjectContext>): {
    sourceTurnId: string;
    projectId: string;
    projectRevision: string;
    projectName: string;
    candidates: ArtifactCandidate[];
  } | null {
    const candidates = stagedCandidates?.length ? stagedCandidates : parseArtifactCandidates(reply);
    if (candidates.length === 0) return null;
    const context = capturedContext ?? artifactProjectContext(getActiveProject(projectsPath).id);
    return {
      sourceTurnId: `turn_${randomBytes(10).toString("hex")}`,
      projectId: context.project.id,
      projectRevision: context.revision,
      projectName: context.project.name,
      candidates,
    };
  }

  const artifactService = new ArtifactService(artifactProjectContext);

  const goalStore = new GoalStore(opts.goalStorageDir);
  // In-memory listeners for SSE goal streams: goalId → set of write callbacks.
  const goalListeners = new Map<string, Set<(evt: GoalProgress) => void>>();

  function notifyGoal(goalId: string, evt: GoalProgress): void {
    goalListeners.get(goalId)?.forEach((fn) => fn(evt));
  }

  function startGoalRunner(session: GoalSession): void {
    const r = resolverFor(opts, undefined);
    runGoalLoop(session, r, {
      onProgress: (evt) => {
        session.updatedAt = Date.now();
        goalStore.save(session);
        notifyGoal(session.goalId, evt);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }).catch((err) => {
      console.error(`[goal] ${session.goalId} runner error:`, err);
      if (session.status === "running") {
        session.status = "failed";
        goalStore.save(session);
        notifyGoal(session.goalId, { kind: "goal-error", error: (err as Error).message ?? String(err) });
      }
    });
  }

  const server = createServer(async (req, res) => {
    try {
      if (opts.cors) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const pathname = url.pathname;

      // --- API routes ---
      if (pathname === "/api/security/context" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        const active = getActiveProject(projectsPath);
        sendJson(res, 200, { csrfToken, activeProjectId: active.id, projectRevision: projectRevision() });
        return;
      }

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
        // ollama:qwen3.5-9b, action-code → ollama:qwen2.5-coder).
        const useLocal = url.searchParams.get("local") === "1";
        const activeResolver = resolverFor(opts, useLocal);
        const snap = opts.router.snapshot();
        const roles = roleUsageSnapshot(snap, activeResolver);
        sendJson(res, 200, {
          mode: opts.router.getMode(),
          useLocal,
          runtime: runtimeConfig(opts),
          // Hide inactive override slots (no override set) from the flat list so
          // the providers panel only shows real, in-use providers.
          providers: snap.filter((p) => p.active !== false).map((p) => ({
            id: p.id,
            model: p.model,
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

      // ── File API (read-only Phase A) ──────────────────────────────────────

      if (pathname === "/api/files/root" && req.method === "GET") {
        const active = getActiveProject(projectsPath);
        sendJson(res, 200, {
          root: fileService.root,
          mode: "read",
          maxBytes: FILE_MAX_BYTES,
          activeProjectId: active.id,
          projectName: active.name,
          pinnedFile: active.pinnedFile,
        });
        return;
      }

      // ── Project API ────────────────────────────────────────────────────────

      if (pathname === "/api/projects" && req.method === "GET") {
        const active = getActiveProject(projectsPath);
        sendJson(res, 200, {
          active,
          projects: listProjects(projectsPath),
          allowList: serverAllowList,
        });
        return;
      }

      if (pathname === "/api/projects" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { name?: string; root?: string; pinnedFile?: string | null; createRoot?: boolean } | null;
        if (typeof parsed?.name !== "string" || typeof parsed?.root !== "string") {
          sendJson(res, 400, { error: "name and root (strings) required" });
          return;
        }
        if (parsed.createRoot !== undefined && typeof parsed.createRoot !== "boolean") {
          sendJson(res, 400, { error: "createRoot must be a boolean when provided" });
          return;
        }
        try {
          assertWithinAllowList(parsed.root, serverAllowList);
          if (parsed.createRoot === true) createProjectRoot(parsed.root, serverAllowList);
          const project = addProject(
            { name: parsed.name, root: parsed.root, pinnedFile: parsed.pinnedFile, allowList: serverAllowList },
            projectsPath,
          );
          sendJson(res, 200, { project });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === "OUTSIDE_ALLOWLIST") sendJson(res, 403, { error: e.message });
          else if (e.code === "DUPLICATE_NAME") sendJson(res, 409, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (pathname === "/api/projects/active" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { id?: string } | null;
        if (typeof parsed?.id !== "string") {
          sendJson(res, 400, { error: "id (string) required" });
          return;
        }
        try {
          const next = listProjects(projectsPath).find((project) => project.id === parsed.id);
          if (!next) throw Object.assign(new Error(`project "${parsed.id}" not found`), { code: "NOT_FOUND" });
          assertWithinAllowList(next.root, serverAllowList);
          const nextFileService = new WebFileService(resolve(next.root));
          setActiveProject(parsed.id, projectsPath);
          fileService = nextFileService;
          const active = getActiveProject(projectsPath);
          sendJson(res, 200, { active });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === "NOT_FOUND") sendJson(res, 404, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (pathname === "/api/projects/delete" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { id?: string } | null;
        if (typeof parsed?.id !== "string") {
          sendJson(res, 400, { error: "id (string) required" });
          return;
        }
        try {
          const wasActive = getActiveProject(projectsPath).id === parsed.id;
          removeProject(parsed.id, projectsPath);
          if (wasActive) rebuildFileService();
          sendJson(res, 200, { deleted: parsed.id });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === "LAST_PROJECT") sendJson(res, 409, { error: e.message });
          else if (e.code === "NOT_FOUND") sendJson(res, 404, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (pathname === "/api/projects/pin" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { path?: string | null } | null;
        if (parsed === null || !("path" in parsed)) {
          sendJson(res, 400, { error: "path (string or null) required" });
          return;
        }
        const relPath = parsed.path;
        if (relPath !== null && typeof relPath !== "string") {
          sendJson(res, 400, { error: "path must be a string or null" });
          return;
        }
        const active = getActiveProject(projectsPath);
        try {
          setPinnedFile(active.id, relPath, projectsPath);
          sendJson(res, 200, { pinnedFile: relPath });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === "TRAVERSAL") sendJson(res, 403, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (pathname === "/api/files" && req.method === "GET") {
        const userPath = url.searchParams.get("path") ?? ".";
        try {
          const result = fileService.listDir(userPath);
          sendJson(res, 200, result);
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { code?: string };
          if (e.code === "TRAVERSAL" || e.code === "BLOCKED") {
            sendJson(res, 403, { error: e.message });
          } else if (e.code === "NOT_FOUND") {
            sendJson(res, 404, { error: e.message });
          } else {
            sendJson(res, 400, { error: e.message });
          }
        }
        return;
      }

      if (pathname === "/api/files/read" && req.method === "GET") {
        const userPath = url.searchParams.get("path");
        if (!userPath) {
          sendJson(res, 400, { error: "path query param required" });
          return;
        }
        try {
          const result = fileService.readText(userPath);
          sendJson(res, 200, result);
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { code?: string };
          if (e.code === "TRAVERSAL" || e.code === "BLOCKED") {
            sendJson(res, 403, { error: e.message });
          } else if (e.code === "NOT_FOUND") {
            sendJson(res, 404, { error: e.message });
          } else if (e.code === "TOO_LARGE") {
            sendJson(res, 413, { error: e.message });
          } else if (e.code === "BINARY") {
            sendJson(res, 415, { error: e.message });
          } else {
            sendJson(res, 400, { error: e.message });
          }
        }
        return;
      }

      if (pathname === "/api/files/diff" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { path?: string; content?: string } | null;
        if (typeof parsed?.path !== "string" || typeof parsed?.content !== "string") {
          sendJson(res, 400, { error: "path and content (strings) required" });
          return;
        }
        try {
          sendJson(res, 200, fileService.buildDiff(parsed.path, parsed.content));
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { code?: string };
          if (e.code === "TRAVERSAL" || e.code === "BLOCKED") sendJson(res, 403, { error: e.message });
          else if (e.code === "NOT_FOUND") sendJson(res, 404, { error: e.message });
          else if (e.code === "TOO_LARGE") sendJson(res, 413, { error: e.message });
          else if (e.code === "BINARY") sendJson(res, 415, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (pathname === "/api/files/write" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as {
          path?: string; content?: string;
          expectedSha256?: string | null; confirm?: boolean;
        } | null;
        if (typeof parsed?.path !== "string" || typeof parsed?.content !== "string") {
          sendJson(res, 400, { error: "path and content (strings) required" });
          return;
        }
        if (parsed.confirm !== true) {
          sendJson(res, 400, { error: "confirm must be true to apply writes" });
          return;
        }
        try {
          const expectedSha256 = parsed.expectedSha256 ?? null;
          sendJson(res, 200, fileService.writeText(parsed.path, parsed.content, typeof expectedSha256 === "string" ? expectedSha256 : null));
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { code?: string };
          if (e.code === "TRAVERSAL" || e.code === "BLOCKED") sendJson(res, 403, { error: e.message });
          else if (e.code === "NOT_FOUND") sendJson(res, 404, { error: e.message });
          else if (e.code === "CONFLICT") sendJson(res, 409, { error: e.message });
          else if (e.code === "TOO_LARGE") sendJson(res, 413, { error: e.message });
          else sendJson(res, 400, { error: e.message });
        }
        return;
      }

      // ── Reviewed artifact proposal API ───────────────────────────────────
      if (pathname === "/api/artifacts/proposals" && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const parsed = safeJsonParse(await readBody(req)) as {
          projectId?: string; sessionId?: string; sourceTurnId?: string; title?: string; basePath?: string;
          files?: ArtifactCandidate[];
        } | null;
        if (!parsed || typeof parsed.projectId !== "string" || typeof parsed.sessionId !== "string" ||
          typeof parsed.sourceTurnId !== "string" || !Array.isArray(parsed.files)) {
          sendJson(res, 400, { error: "projectId, sessionId, sourceTurnId, and files are required" });
          return;
        }
        try {
          sendJson(res, 201, {
            proposal: artifactService.create({
              projectId: parsed.projectId,
              sessionId: parsed.sessionId,
              sourceTurnId: parsed.sourceTurnId,
              title: parsed.title,
              basePath: parsed.basePath,
              files: parsed.files,
            }),
          });
        } catch (err) {
          sendArtifactError(res, err);
        }
        return;
      }

      const artifactDiffMatch = pathname.match(/^\/api\/artifacts\/proposals\/([^/]+)\/files\/([^/]+)\/diff$/);
      if (artifactDiffMatch && req.method === "GET") {
        try {
          const result = artifactService.getDiff(decodeURIComponent(artifactDiffMatch[1]!), decodeURIComponent(artifactDiffMatch[2]!));
          sendJson(res, 200, result);
        } catch (err) {
          sendArtifactError(res, err);
        }
        return;
      }

      const artifactApplyMatch = pathname.match(/^\/api\/artifacts\/proposals\/([^/]+)\/apply$/);
      if (artifactApplyMatch && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const parsed = safeJsonParse(await readBody(req)) as {
          projectId?: string; projectRevision?: string; fileIds?: string[]; confirm?: boolean;
        } | null;
        if (!parsed || typeof parsed.projectId !== "string" || typeof parsed.projectRevision !== "string" || parsed.confirm !== true) {
          sendJson(res, 400, { error: "projectId, projectRevision, and confirm: true are required" });
          return;
        }
        try {
          sendJson(res, 200, artifactService.apply({
            proposalId: decodeURIComponent(artifactApplyMatch[1]!),
            projectId: parsed.projectId,
            projectRevision: parsed.projectRevision,
            fileIds: parsed.fileIds,
            confirm: true,
          }));
        } catch (err) {
          sendArtifactError(res, err);
        }
        return;
      }

      const artifactCancelMatch = pathname.match(/^\/api\/artifacts\/proposals\/([^/]+)$/);
      if (artifactCancelMatch && req.method === "DELETE") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        try {
          sendJson(res, 200, artifactService.cancel(decodeURIComponent(artifactCancelMatch[1]!)));
        } catch (err) {
          sendArtifactError(res, err);
        }
        return;
      }

      const artifactRollbackMatch = pathname.match(/^\/api\/artifacts\/transactions\/([^/]+)\/rollback$/);
      if (artifactRollbackMatch && req.method === "POST") {
        const guardError = mutationRequestError(req, port, csrfToken);
        if (guardError) {
          sendJson(res, guardError.startsWith("Content-Type") ? 415 : 403, { error: guardError });
          return;
        }
        const parsed = safeJsonParse(await readBody(req)) as {
          projectId?: string; projectRevision?: string; undoToken?: string; confirm?: boolean;
        } | null;
        if (!parsed || typeof parsed.projectId !== "string" || typeof parsed.projectRevision !== "string" ||
          typeof parsed.undoToken !== "string" || parsed.confirm !== true) {
          sendJson(res, 400, { error: "projectId, projectRevision, undoToken, and confirm: true are required" });
          return;
        }
        try {
          sendJson(res, 200, artifactService.rollback({
            transactionId: decodeURIComponent(artifactRollbackMatch[1]!),
            projectId: parsed.projectId,
            projectRevision: parsed.projectRevision,
            undoToken: parsed.undoToken,
            confirm: true,
          }));
        } catch (err) {
          sendArtifactError(res, err);
        }
        return;
      }

      // ─────────────────────────────────────────────────────────────────────

      if (pathname === "/api/sessions" && req.method === "GET") {
        sendJson(res, 200, { sessions: listSessionSummaries(opts.sessionStorageDir) });
        return;
      }
      if (pathname === "/api/sessions" && req.method === "DELETE") {
        if (!isAllowedOrigin(req.headers["origin"], port)) {
          sendJson(res, 403, { error: "cross-origin deletes are not allowed" });
          return;
        }
        const deleted = deleteAllSessions(opts.sessionStorageDir);
        sendJson(res, 200, { deleted, sessions: [] });
        return;
      }

      if (pathname === "/api/role-instructions" && req.method === "GET") {
        const path = roleInstructionsPath(opts);
        sendJson(res, 200, {
          path,
          instructions: readRoleInstructions(path),
          defaults: defaultRoleInstructions(),
        });
        return;
      }

      if (pathname === "/api/role-instructions" && req.method === "PUT") {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.includes("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        if (!isAllowedOrigin(req.headers["origin"], port)) {
          sendJson(res, 403, { error: "cross-origin writes are not allowed" });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { instructions?: unknown } | null;
        if (!parsed || typeof parsed !== "object") {
          sendJson(res, 400, { error: "JSON body required" });
          return;
        }
        const path = roleInstructionsPath(opts);
        const instructions = writeRoleInstructions(path, parsed.instructions ?? parsed);
        sendJson(res, 200, { path, instructions, defaults: defaultRoleInstructions() });
        return;
      }

      if (pathname === "/api/reasoning-models" && req.method === "GET") {
        try {
          const refresh = url.searchParams.get("refresh") === "1";
          const key = (process.env.OPENROUTER_KEY ?? "").trim();
          const result = await listOpenRouterFreeTextModels({
            apiKey: key || undefined,
            refresh,
          });
          sendJson(res, 200, {
            selected: readReasoningModelOverride(),
            defaultModel: DEFAULT_OPENROUTER_REASONING_MODEL,
            models: result.models,
            source: result.source,
            fetchedAt: result.fetchedAt,
            stale: result.stale,
          });
        } catch (err) {
          sendJson(res, 502, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/reasoning-model" && req.method === "PUT") {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.includes("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        if (!isAllowedOrigin(req.headers["origin"], port)) {
          sendJson(res, 403, { error: "cross-origin writes are not allowed" });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as { model?: string | null } | null;
        if (parsed === null || !("model" in parsed)) {
          sendJson(res, 400, { error: "model (string or null) required" });
          return;
        }
        if (parsed.model === null || parsed.model === DEFAULT_OPENROUTER_REASONING_MODEL) {
          sendJson(res, 200, { selected: resetReasoningModelOverride() });
          return;
        }
        if (typeof parsed.model !== "string" || !parsed.model.trim()) {
          sendJson(res, 400, { error: "model must be a non-empty string or null" });
          return;
        }
        try {
          const key = (process.env.OPENROUTER_KEY ?? "").trim();
          const result = await listOpenRouterFreeTextModels({ apiKey: key || undefined });
          const option = result.models.find((m) => m.id === parsed.model);
          if (!option) {
            sendJson(res, 400, { error: "model is not in the current OpenRouter free text-model list" });
            return;
          }
          const selected = writeReasoningModelOverride(undefined, {
            model: option.id,
            name: option.name,
            contextLength: option.contextLength,
            reasoningCapable: option.reasoningCapable,
          });
          sendJson(res, 200, { selected });
        } catch (err) {
          sendJson(res, 502, { error: (err as Error).message });
        }
        return;
      }

      // ── Per-role provider + model selection (generalises reasoning-model) ──

      if (pathname === "/api/providers" && req.method === "GET") {
        sendJson(res, 200, {
          providers: OVERRIDE_PROVIDER_NAMES.map((id) => ({
            id,
            label: PROVIDER_LABELS[id] ?? id,
            configured: isOverrideProviderConfigured(id),
          })),
          roles: CUSTOMISABLE_ROLES,
          overrides: readAllRoleModelOverrides(),
        });
        return;
      }

      if (pathname === "/api/role-models" && req.method === "GET") {
        const role = url.searchParams.get("role") ?? "";
        const provider = url.searchParams.get("provider") ?? "";
        if (!isCustomisableRoleName(role)) {
          sendJson(res, 400, { error: `unknown or non-customisable role: ${role}` });
          return;
        }
        if (!isOverrideProviderName(provider)) {
          sendJson(res, 400, { error: `unknown provider: ${provider}` });
          return;
        }
        try {
          const refresh = url.searchParams.get("refresh") === "1";
          const result = await listModelsForProvider(provider, {
            apiKey: apiKeyForOverrideProvider(provider) ?? undefined,
            refresh,
            ...(opts.modelFetchImpl ? { fetchImpl: opts.modelFetchImpl } : {}),
          });
          sendJson(res, 200, {
            role,
            provider,
            selected: readRoleModelOverride(role),
            defaultPrimary: defaultPrimaryFor(role),
            models: result.models,
            source: result.source,
            fetchedAt: result.fetchedAt,
            stale: result.stale,
          });
        } catch (err) {
          sendJson(res, 502, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === "/api/role-model" && req.method === "PUT") {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.includes("application/json")) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        if (!isAllowedOrigin(req.headers["origin"], port)) {
          sendJson(res, 403, { error: "cross-origin writes are not allowed" });
          return;
        }
        const body = await readBody(req);
        const parsed = safeJsonParse(body) as
          | { role?: string; provider?: string | null; model?: string | null }
          | null;
        if (!parsed || !isCustomisableRoleName(parsed.role ?? "")) {
          sendJson(res, 400, { error: "role (customisable role name) required" });
          return;
        }
        const role = parsed.role as CustomisableRole;
        // Clearing: provider or model null/empty reverts to the default chain.
        if (!parsed.provider || !parsed.model) {
          clearRoleModelOverride(role);
          sendJson(res, 200, { selected: null, role });
          return;
        }
        if (!isOverrideProviderName(parsed.provider)) {
          sendJson(res, 400, { error: `unknown provider: ${parsed.provider}` });
          return;
        }
        const provider = parsed.provider;
        if (!isOverrideProviderConfigured(provider)) {
          sendJson(res, 400, { error: `provider '${provider}' is not configured (missing API key)` });
          return;
        }
        try {
          const result = await listModelsForProvider(provider, {
            apiKey: apiKeyForOverrideProvider(provider) ?? undefined,
            refresh: true,
            ...(opts.modelFetchImpl ? { fetchImpl: opts.modelFetchImpl } : {}),
          });
          if (result.source !== "live") {
            sendJson(res, 503, {
              error: `could not verify '${provider}' against a live model catalogue; try again`,
            });
            return;
          }
          const option = result.models.find((m) => m.id === parsed.model);
          if (!option) {
            sendJson(res, 400, {
              error: `model '${parsed.model}' is not in ${provider}'s current model list`,
            });
            return;
          }
          const selected = writeRoleModelOverride(role, {
            provider,
            model: option.id,
            ...(option.name ? { name: option.name } : {}),
            ...(option.contextLength !== undefined ? { contextLength: option.contextLength } : {}),
            ...(option.reasoningCapable !== undefined
              ? { reasoningCapable: option.reasoningCapable }
              : {}),
          });
          sendJson(res, 200, { selected, role });
        } catch (err) {
          sendJson(res, 502, { error: (err as Error).message });
        }
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
              builder?: boolean;
              builderMode?: BuilderMode;
              intentText?: string;
              routingMode?: string | null;
              images?: unknown;
            }
          | null;
        if (!parsed?.sessionId || typeof parsed.message !== "string") {
          sendJson(res, 400, { error: "sessionId (string) and message (string) required" });
          return;
        }
        const imagesResult = parseChatImages(parsed.images);
        if ("error" in imagesResult) {
          sendJson(res, 400, { error: imagesResult.error });
          return;
        }
        const chatOpts = buildChatOpts(parsed);
        const builderDecision = resolveBuilderIntent({
          mode: parsed.builderMode,
          legacyBuilder: parsed.builder,
          intentText: typeof parsed.intentText === "string" ? parsed.intentText : parsed.message,
          forceRole: chatOpts.routing.forceRole,
        });
        const builder = builderDecision.active ? new BuilderStage(fileService) : null;
        const builderContext = builder ? artifactProjectContext(getActiveProject(projectsPath).id) : undefined;
        const session = createChatSession(opts, parsed.sessionId, parsed.useLocal, builder?.toolset());
        try {
          const routing = builder ? { ...chatOpts.routing, forceRole: "action-code" as RoleName } : chatOpts.routing;
          const result = await session.send(parsed.message, chatOpts.opts, undefined, routing, imagesResult.images, builder
            ? { historyScope: builderDecision.historyScope, requiredToolName: builderDecision.requiresStagedFile ? "stage_file" : undefined }
            : undefined);
          const artifact = responseArtifact(result.reply, parsed.sessionId, builder?.candidates(), builderContext);
          sendJson(res, 200, {
            reply: result.reply,
            servedBy: result.servedBy,
            plan: result.plan?.kind,
            summarizedTurns: result.summarizedTurns ?? 0,
            tokenEstimate: result.tokenEstimate,
            budgetPct: Math.round(result.budgetPct),
            warning: result.warning ?? null,
            turns: session.turnCount(),
            artifact,
            execution: builder ? { mode: "builder", source: builderDecision.source, historyScope: builderDecision.historyScope, requiresStagedFile: builderDecision.requiresStagedFile } : undefined,
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
              builder?: boolean;
              builderMode?: BuilderMode;
              intentText?: string;
              routingMode?: string | null;
              images?: unknown;
            }
          | null;
        if (!parsed?.sessionId || typeof parsed.message !== "string") {
          sendJson(res, 400, { error: "sessionId (string) and message (string) required" });
          return;
        }
        const imagesResult = parseChatImages(parsed.images);
        if ("error" in imagesResult) {
          sendJson(res, 400, { error: imagesResult.error });
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
        const streamAbort = new AbortController();
        let clientClosed = false;
        const abortStream = () => {
          clientClosed = true;
          streamAbort.abort();
        };
        req.on("aborted", abortStream);
        res.on("close", abortStream);
        const writeEvent = (payload: unknown) => {
          if (clientClosed || res.destroyed) return;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        const builderDecision = resolveBuilderIntent({
          mode: parsed.builderMode,
          legacyBuilder: parsed.builder,
          intentText: typeof parsed.intentText === "string" ? parsed.intentText : parsed.message,
          forceRole: chatOpts.routing.forceRole,
        });
        const builder = builderDecision.active ? new BuilderStage(fileService) : null;
        const builderContext = builder ? artifactProjectContext(getActiveProject(projectsPath).id) : undefined;
        const session = createChatSession(opts, parsed.sessionId, parsed.useLocal, builder?.toolset());
        try {
          const routing = builder ? { ...chatOpts.routing, forceRole: "action-code" as RoleName } : chatOpts.routing;
          if (builder) {
            writeEvent({ kind: "route", execution: { mode: "builder", source: builderDecision.source, historyScope: builderDecision.historyScope, requiresStagedFile: builderDecision.requiresStagedFile } });
          }
          const result = await session.send(
            parsed.message,
            { ...chatOpts.opts, signal: streamAbort.signal },
            (evt) => { writeEvent(evt); },
            routing,
            imagesResult.images,
            builder ? { historyScope: builderDecision.historyScope, requiredToolName: builderDecision.requiresStagedFile ? "stage_file" : undefined } : undefined,
          );
          const artifact = responseArtifact(result.reply, parsed.sessionId, builder?.candidates(), builderContext);
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
            artifact,
            execution: builder ? { mode: "builder", source: builderDecision.source, historyScope: builderDecision.historyScope, requiresStagedFile: builderDecision.requiresStagedFile } : undefined,
          });
        } catch (err) {
          if (!streamAbort.signal.aborted) {
            writeEvent({
              kind: "error",
              error: (err as Error).message,
              errorName: err instanceof Error ? err.name : "Error",
            });
          }
        } finally {
          req.off("aborted", abortStream);
          res.off("close", abortStream);
          if (!clientClosed && !res.writableEnded) res.end();
        }
        return;
      }

      const duplicateMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/duplicate$/);
      if (duplicateMatch && req.method === "POST") {
        const id = decodeURIComponent(duplicateMatch[1]!);
        const parsed = safeJsonParse(await readBody(req)) as { newId?: string } | null;
        if (!isSafeSessionId(id) || (parsed?.newId && !isSafeSessionId(parsed.newId))) {
          sendJson(res, 400, { error: "invalid session id" });
          return;
        }
        try {
          const session = duplicateSession(id, parsed?.newId, opts.sessionStorageDir);
          if (!session) sendJson(res, 404, { error: "session not found" });
          else sendJson(res, 200, { session });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      const exportMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
      if (exportMatch && req.method === "GET") {
        const id = decodeURIComponent(exportMatch[1]!);
        if (!isSafeSessionId(id)) {
          sendJson(res, 400, { error: "invalid session id" });
          return;
        }
        const raw = exportSessionRaw(id, opts.sessionStorageDir);
        if (!raw) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"" + id + ".json\"");
        res.end(JSON.stringify(raw, null, 2));
        return;
      }

      const clearMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/clear$/);
      if (clearMatch && req.method === "POST") {
        const id = decodeURIComponent(clearMatch[1]!);
        if (!isSafeSessionId(id)) {
          sendJson(res, 400, { error: "invalid session id" });
          return;
        }
        const session = createChatSession(opts, id);
        session.clear();
        sendJson(res, 200, { cleared: id });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!);
        if (!isSafeSessionId(id)) {
          sendJson(res, 400, { error: "invalid session id" });
          return;
        }
        if (req.method === "GET") {
          const session = createChatSession(opts, id);
          const snap = session.snapshot();
          sendJson(res, 200, {
            id,
            title: snap.title,
            pinned: snap.pinned,
            createdAt: snap.createdAt,
            updatedAt: snap.updatedAt,
            turns: session.turnCount(),
            tokenEstimate: session.estimateTokens(),
            history: snap.history,
          });
          return;
        }
        if (req.method === "PATCH") {
          const parsed = safeJsonParse(await readBody(req)) as { title?: string; pinned?: boolean } | null;
          const session = updateSessionMetadata(id, parsed ?? {}, opts.sessionStorageDir);
          if (!session) sendJson(res, 404, { error: "session not found" });
          else sendJson(res, 200, { session });
          return;
        }
        if (req.method === "DELETE") {
          const deleted = deleteSession(id, opts.sessionStorageDir);
          if (!deleted) sendJson(res, 404, { error: "session not found" });
          else sendJson(res, 200, { deleted: id });
          return;
        }
      }

      // --- Goal endpoints ---
      if (pathname === "/api/goals" && req.method === "GET") {
        sendJson(res, 200, { goals: goalStore.list() });
        return;
      }

      if (pathname === "/api/goal" && req.method === "POST") {
        const parsed = safeJsonParse(await readBody(req)) as { description?: string } | null;
        if (!parsed?.description || typeof parsed.description !== "string") {
          sendJson(res, 400, { error: "description (string) required" });
          return;
        }
        const goalId = newGoalId();
        const session: GoalSession = {
          goalId,
          description: parsed.description.trim(),
          steps: [],
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        goalStore.save(session);
        sendJson(res, 200, { goalId });
        startGoalRunner(session);
        return;
      }

      // /api/goal/:id and /api/goal/:id/stream
      const goalIdMatch = pathname.match(/^\/api\/goal\/([^/]+)(\/stream)?$/);
      if (goalIdMatch) {
        const goalId = goalIdMatch[1]!;
        const isStream = !!goalIdMatch[2];

        if (isStream && req.method === "GET") {
          // SSE stream for live goal progress events.
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.statusCode = 200;

          const session = goalStore.load(goalId);
          if (!session) {
            res.end(`data: ${JSON.stringify({ kind: "goal-error", error: "goal not found" })}\n\n`);
            return;
          }

          // Replay terminal state immediately on reconnect.
          if (session.status === "done" || session.status === "failed" || session.status === "paused") {
            res.write(`data: ${JSON.stringify({ kind: "goal-state", session })}\n\n`);
          }

          const removeFromListeners = () => {
            goalListeners.get(goalId)?.delete(send);
            if (goalListeners.get(goalId)?.size === 0) goalListeners.delete(goalId);
          };
          const send = (evt: GoalProgress) => {
            if (res.destroyed) return;
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
            if (evt.kind === "goal-done" || evt.kind === "goal-error") {
              removeFromListeners();
              res.end();
            }
          };
          if (!goalListeners.has(goalId)) goalListeners.set(goalId, new Set());
          goalListeners.get(goalId)!.add(send);

          req.on("close", removeFromListeners);
          res.on("close", removeFromListeners);
          return;
        }

        if (!isStream && req.method === "GET") {
          const session = goalStore.load(goalId);
          if (!session) { sendJson(res, 404, { error: "goal not found" }); return; }
          sendJson(res, 200, session);
          return;
        }

        if (!isStream && req.method === "DELETE") {
          const deleted = goalStore.delete(goalId);
          if (!deleted) { sendJson(res, 404, { error: "goal not found" }); return; }
          sendJson(res, 200, { deleted: goalId });
          return;
        }
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
          if (filePath === "/index.html") {
            const runtime = JSON.stringify(runtimeConfig(opts));
            const body = readFileSync(full, "utf8").replace(
              "</head>",
              `<script>window.__MULTI_AGENT_RUNTIME__ = ${runtime};</script>\n</head>`,
            );
            res.setHeader("Content-Type", MIME[".html"]!);
            res.statusCode = 200;
            res.end(body);
            return;
          }
          const body = readFileSync(full);
          res.setHeader("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
          res.statusCode = 200;
          res.end(body);
          return;
        }
      }

      sendText(res, 404, "not found");
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "BODY_TOO_LARGE") {
        if (!res.headersSent) sendJson(res, 413, { error: e.message });
        else res.end();
        return;
      }
      console.error("[web] handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  });

  server.listen(port, host);
  const url = `http://${host}:${port}/`;
  return {
    url,
    close: () => server.close(),
  };
}

function readBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { code: "BODY_TOO_LARGE" }));
      return;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const rejectOnce = (err: Error): void => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(err);
    };
    req.on("data", (c: Buffer) => {
      if (settled) return;
      totalBytes += c.length;
      if (totalBytes > maxBytes) {
        rejectOnce(Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
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
    // An override slot is "transparent" when it's inactive (no override set) or
    // absent from the snapshot — it should be skipped both as the configured
    // primary and as a routing candidate, so the role's real default chain
    // shows. An ACTIVE override slot is the configured primary and wins.
    const isTransparentOverride = (providerId: string): boolean =>
      providerId.startsWith("override:") && byId.get(providerId)?.active !== true;

    // Configured primary = first candidate that isn't a transparent override
    // slot (kept even if not registered, so serving a backup reads as fallback).
    const primaryId =
      role.candidates.find((c) => !isTransparentOverride(c.providerId))?.providerId ??
      role.candidates[0]?.providerId ??
      "";
    const registered = role.candidates
      .filter((c) => !isTransparentOverride(c.providerId))
      .map((c) => byId.get(c.providerId))
      .filter((p): p is ProviderSnapshot => p !== undefined && p.active !== false);
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
      model: picked.model,
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
        model: p.model,
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

function createChatSession(opts: ServerOptions, id: string, useLocal?: boolean, tools?: Tool[]): ChatSession {
  const roleInstructionsPathValue = roleInstructionsPath(opts);
  return new ChatSession({
    resolver: resolverFor(opts, useLocal),
    id,
    roleInstructions: readRoleInstructions(roleInstructionsPathValue),
    ...(tools?.length ? { tools } : {}),
    ...(opts.sessionStorageDir && { storagePath: join(opts.sessionStorageDir, `${id}.json`) }),
  });
}

function roleInstructionsPath(opts: ServerOptions): string {
  return opts.roleInstructionsPath ?? DEFAULT_ROLE_INSTRUCTIONS_PATH;
}
