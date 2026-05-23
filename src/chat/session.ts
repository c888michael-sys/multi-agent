import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RoleResolver } from "../roles/resolver.js";
import type { RoleName } from "../roles/types.js";
import type { CompleteOptions } from "../provider.js";
import type { ConversationPart } from "../tools/types.js";

const VALID_ROLES_FOR_ROUTING: RoleName[] = [
  "perception",
  "reasoning",
  "action-code",
  "action-structural",
  "action-repetitive",
];

const ROUTING_PREAMBLE = `[CHAT-ROUTING PROTOCOL: You are the orchestrator in a multi-turn chat. For each new user message:
1. If you can answer the user with high confidence using the conversation context alone, just answer normally.
2. If a specialist would serve the user's latest message better, respond with EXACTLY one line in this format, nothing else:
   ROUTE: <role>
   Where <role> is one of: perception, reasoning, action-code, action-structural, action-repetitive

Specialists:
- perception: live web search / current facts
- reasoning: hard deliberation, plans, complex multi-step problems
- action-code: writing or debugging code
- action-structural: formatting tables, transforming data, structured outputs
- action-repetitive: bulk simple work where speed matters

Default to answering yourself for greetings, follow-ups, definitions, summaries — anything the conversation context already covers. Only route when a specialist would be meaningfully better.]`;

const ROUTING_ACK = "Understood. I'll route when a specialist would help, otherwise I'll answer directly.";

export interface ChatSessionOptions {
  resolver: RoleResolver;
  /** Persisted session id; used as the filename. */
  id: string;
  /** Which role is the entry point for chat turns. Default "orchestration". */
  role?: RoleName;
  /**
   * When true (default), the orchestrator may route any turn to a specialist
   * role (perception, reasoning, action-code, action-structural, action-
   * repetitive) instead of answering itself. The specialist receives the
   * full conversation history. When false, every turn goes to `role` directly.
   */
  smartRouting?: boolean;
  /** Path to JSON file backing this session. Default ~/.multi-agent/sessions/<id>.json. */
  storagePath?: string;
  /** Soft token budget. Warn at 80%, prompt at 95%. Default 100_000 tokens. */
  tokenBudget?: number;
  /**
   * Approximate tokens-per-character ratio for estimation. The real value is
   * model-specific (~3-4 chars/token for English). 4 is a safe conservative
   * default. Used only when no live countTokens is available.
   */
  charsPerToken?: number;
}

export interface SessionSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
  role: RoleName;
  history: ConversationPart[];
  estimatedTokens: number;
}

export interface SendResult {
  reply: string;
  tokenEstimate: number;
  budgetPct: number;
  warning?: "approaching-budget" | "over-budget";
  /**
   * Which role actually produced the reply this turn. "orchestration" means the
   * orchestrator answered directly; any other value means the orchestrator
   * delegated to that specialist for this turn.
   */
  servedBy: RoleName;
}

const SESSION_VERSION = 1;
const DEFAULT_BUDGET = 100_000;
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * A persistent multi-turn chat session. Each call to send() appends a
 * user/assistant pair to history and persists to disk. Token estimates
 * are heuristic (chars/N) — accurate enough for budget warnings.
 *
 * Sessions survive process restarts; reopen by ID. Default storage:
 * ~/.multi-agent/sessions/<id>.json.
 */
export class ChatSession {
  readonly id: string;
  readonly role: RoleName;
  readonly smartRouting: boolean;
  readonly storagePath: string;
  readonly tokenBudget: number;
  private readonly charsPerToken: number;
  private readonly resolver: RoleResolver;

  private history: ConversationPart[] = [];
  private createdAt: number;
  private updatedAt: number;

  constructor(opts: ChatSessionOptions) {
    this.resolver = opts.resolver;
    this.id = opts.id;
    this.role = opts.role ?? "orchestration";
    this.smartRouting = opts.smartRouting ?? true;
    this.storagePath =
      opts.storagePath ?? join(homedir(), ".multi-agent", "sessions", `${opts.id}.json`);
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_BUDGET;
    this.charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.load();
  }

  /**
   * Send one turn. Smart-routing flow:
   *   1. Append user message to history.
   *   2. Ask orchestrator (with a routing preamble) to either answer directly
   *      OR respond with "ROUTE: <role>".
   *   3. If routing: re-call that specialist with the CLEAN history (preamble
   *      stripped) so the specialist sees only real conversation.
   *   4. Append the final reply, persist, return.
   *
   * Simple-routing flow (smartRouting=false): always call `this.role` once.
   */
  async send(userInput: string, opts?: CompleteOptions): Promise<SendResult> {
    this.history.push({ kind: "user_text", text: userInput });

    let reply: string;
    let servedBy: RoleName;
    try {
      if (!this.smartRouting) {
        reply = await this.resolver.runRoleChat(this.role, this.history, opts);
        servedBy = this.role;
      } else {
        const planned = await this.routeAndAnswer(opts);
        reply = planned.reply;
        servedBy = planned.servedBy;
      }
    } catch (err) {
      // Roll back the user message we just added so re-sending doesn't double it.
      this.history.pop();
      throw err;
    }
    this.history.push({ kind: "model_text", text: reply });
    this.updatedAt = Date.now();
    this.persist();
    const tokenEstimate = this.estimateTokens();
    const budgetPct = (tokenEstimate / this.tokenBudget) * 100;
    const result: SendResult = { reply, tokenEstimate, budgetPct, servedBy };
    if (budgetPct >= 95) result.warning = "over-budget";
    else if (budgetPct >= 80) result.warning = "approaching-budget";
    return result;
  }

  /**
   * Smart-routing turn: orchestrator either answers directly or routes to a
   * specialist. The routing preamble is injected at the head of the call's
   * history but never persisted, so chat history stays clean.
   */
  private async routeAndAnswer(
    opts?: CompleteOptions,
  ): Promise<{ reply: string; servedBy: RoleName }> {
    const orchHistory: ConversationPart[] = [
      { kind: "user_text", text: ROUTING_PREAMBLE },
      { kind: "model_text", text: ROUTING_ACK },
      ...this.history,
    ];
    const planReply = await this.resolver.runRoleChat(this.role, orchHistory, opts);
    const routed = parseRouteDirective(planReply);
    if (!routed) {
      return { reply: planReply, servedBy: this.role };
    }
    // Specialist sees the actual conversation history — no orchestrator noise.
    const specialistReply = await this.resolver.runRoleChat(routed, this.history, opts);
    return { reply: specialistReply, servedBy: routed };
  }

  /** Clear conversation history. Persists immediately. */
  clear(): void {
    this.history = [];
    this.updatedAt = Date.now();
    this.persist();
  }

  /**
   * Like clear() but keeps the most recent N user/assistant pairs. Useful for
   * the "auto-clear with context" path where we want continuity but need to
   * shed weight.
   */
  truncateToRecent(pairs: number): void {
    // History alternates user_text, model_text; keep the last (2 * pairs) entries.
    const keep = pairs * 2;
    if (this.history.length <= keep) return;
    this.history = this.history.slice(-keep);
    this.updatedAt = Date.now();
    this.persist();
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      role: this.role,
      history: this.history.map((h) => ({ ...h })),
      estimatedTokens: this.estimateTokens(),
    };
  }

  /**
   * Cheap token estimate based on character count. Will overestimate for
   * dense text and underestimate for whitespace-heavy. Good enough for
   * budget thresholds; not suitable for billing.
   */
  estimateTokens(): number {
    let chars = 0;
    for (const part of this.history) {
      if (part.kind === "user_text" || part.kind === "model_text") {
        chars += part.text.length;
      } else if (part.kind === "tool_result") {
        chars += part.result.length;
      }
      // model_calls — overhead is small; ignore for estimate.
    }
    return Math.ceil(chars / this.charsPerToken);
  }

  /** Number of user/assistant pairs currently in history. */
  turnCount(): number {
    return this.history.filter((h) => h.kind === "model_text").length;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      const body = JSON.stringify(
        {
          version: SESSION_VERSION,
          id: this.id,
          role: this.role,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          history: this.history,
        },
        null,
        2,
      );
      writeFileSync(this.storagePath, body, "utf8");
    } catch (err) {
      console.error(`[chat-session] failed to persist ${this.storagePath}: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const raw = readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: number;
        createdAt?: number;
        updatedAt?: number;
        history?: ConversationPart[];
      };
      if (typeof parsed.createdAt === "number") this.createdAt = parsed.createdAt;
      if (typeof parsed.updatedAt === "number") this.updatedAt = parsed.updatedAt;
      if (Array.isArray(parsed.history)) this.history = parsed.history;
    } catch (err) {
      console.error(
        `[chat-session] failed to load ${this.storagePath}: ${(err as Error).message}. Starting fresh.`,
      );
    }
  }
}

/**
 * Parse an orchestrator reply for a "ROUTE: <role>" directive. Returns the
 * role name if recognized, otherwise null (meaning: use the reply as-is).
 * Exported for testing.
 */
export function parseRouteDirective(reply: string): RoleName | null {
  // Strip whitespace and optional leading code fences / quotes.
  const trimmed = reply.trim().replace(/^['"`]+|['"`]+$/g, "");
  const m = trimmed.match(/^ROUTE:\s*([a-z-]+)\s*$/i);
  if (!m) return null;
  const role = m[1]!.toLowerCase();
  if ((VALID_ROLES_FOR_ROUTING as string[]).includes(role)) {
    return role as RoleName;
  }
  return null;
}

/** List existing session ids by scanning the storage directory. */
export function listSessions(storageDir?: string): string[] {
  const dir = storageDir ?? join(homedir(), ".multi-agent", "sessions");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}
