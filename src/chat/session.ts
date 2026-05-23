import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RoleResolver } from "../roles/resolver.js";
import type { RoleName } from "../roles/types.js";
import type { CompleteOptions } from "../provider.js";
import type { ConversationPart } from "../tools/types.js";

export interface ChatSessionOptions {
  resolver: RoleResolver;
  /** Persisted session id; used as the filename. */
  id: string;
  /** Which role serves chat turns. Default "orchestration" — Gemini Flash by default. */
  role?: RoleName;
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
    this.storagePath =
      opts.storagePath ?? join(homedir(), ".multi-agent", "sessions", `${opts.id}.json`);
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_BUDGET;
    this.charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.load();
  }

  /**
   * Send one turn: append user message, call the role, append assistant reply,
   * persist, return the reply plus budget telemetry.
   */
  async send(userInput: string, opts?: CompleteOptions): Promise<SendResult> {
    this.history.push({ kind: "user_text", text: userInput });
    let reply: string;
    try {
      reply = await this.resolver.runRoleChat(this.role, this.history, opts);
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
    const result: SendResult = { reply, tokenEstimate, budgetPct };
    if (budgetPct >= 95) result.warning = "over-budget";
    else if (budgetPct >= 80) result.warning = "approaching-budget";
    return result;
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
