import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RoleResolver } from "../roles/resolver.js";
import type { RoleName } from "../roles/types.js";
import type { CompleteOptions } from "../provider.js";
import type { ConversationPart } from "../tools/types.js";
import { parsePlan, type Plan } from "../agents/role-orchestrator.js";

const PLAN_PREAMBLE = `[CHAT-PLAN PROTOCOL: You are the orchestrator in a multi-turn chat with access to specialist agents. For each new user message, decide how to handle it. Output EXACTLY one JSON object.

Specialists:
- perception: live web search / current facts
- reasoning: hard deliberation, plans, complex multi-step problems
- action-code: writing or debugging code
- action-structural: formatting tables, transforming data, structured outputs
- action-repetitive: bulk simple work where speed matters

Plan shapes (pick exactly ONE):

1) Trivial — answer the user yourself with no delegation:
{ "kind": "direct", "answer": "<your reply>" }

2) Delegate to one specialist (specialist will see the full conversation history):
{ "kind": "single", "role": "<role>", "prompt": "<brief framing for the specialist; can be empty string if no extra framing needed>" }

3) Multiple specialists work different angles in parallel — you'll synthesize their outputs:
{ "kind": "parallel", "tasks": [
  { "role": "<role>", "prompt": "<what this specialist should focus on>" },
  ...
] }

Default to "direct" for greetings, follow-ups, definitions, summaries — anything the conversation context already covers. Only delegate when a specialist would meaningfully help. Use "parallel" sparingly — only when the user's message genuinely needs N different angles working at once.

Output ONLY the JSON. No markdown fences, no commentary.]`;

const PLAN_ACK = "Understood. I'll respond with a single JSON plan for every user message.";

export interface ChatSessionOptions {
  resolver: RoleResolver;
  /** Persisted session id; used as the filename. */
  id: string;
  /** Which role is the entry point for chat turns. Default "orchestration". */
  role?: RoleName;
  /**
   * When true (default), the orchestrator decides per turn whether to answer
   * directly, delegate to one specialist, or fan out to multiple specialists
   * in parallel (with synthesis). When false, every turn goes to `role`
   * directly with no planning step.
   */
  smartRouting?: boolean;
  /**
   * Powerful mode — when enabled, every underlying call in this session uses
   * Gemini's `thinking: high` setting. Non-Gemini providers ignore it. Off
   * by default; toggleable mid-session via /power slash command.
   */
  powerful?: boolean;
  /**
   * When true (default), automatically summarize the oldest turns before
   * sending if estimated context usage is about to exceed
   * `autoSummarizeAtPct` of the token budget. The summarization replaces
   * the old turns with a single synthetic "[Earlier conversation summary]"
   * pair, freeing budget. Most recent `keepRecentTurns` are preserved
   * verbatim. Disabled when false; user must `/clear` or `/truncate`
   * manually instead.
   */
  autoSummarize?: boolean;
  /** Percent of token budget at which auto-summarization triggers. Default 85. */
  autoSummarizeAtPct?: number;
  /** Most recent N user/assistant pairs always kept verbatim. Default 3. */
  keepRecentTurns?: number;
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
   * Which role(s) actually produced the reply this turn.
   *   - ["orchestration"]: orchestrator answered directly (kind: "direct")
   *   - ["<role>"]: orchestrator delegated to one specialist (kind: "single")
   *   - ["<role>", "<role>", ..., "orchestration"]: parallel — multiple
   *     specialists + final synthesis pass through orchestration
   */
  servedBy: RoleName[];
  /** Plan the orchestrator picked for this turn (smart-routing mode only). */
  plan?: Plan;
  /** Number of older turns folded into a summary on this send, if any. */
  summarizedTurns?: number;
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
  readonly autoSummarize: boolean;
  readonly autoSummarizeAtPct: number;
  readonly keepRecentTurns: number;
  private readonly charsPerToken: number;
  private readonly resolver: RoleResolver;
  private powerful: boolean;

  private history: ConversationPart[] = [];
  private createdAt: number;
  private updatedAt: number;

  constructor(opts: ChatSessionOptions) {
    this.resolver = opts.resolver;
    this.id = opts.id;
    this.role = opts.role ?? "orchestration";
    this.smartRouting = opts.smartRouting ?? true;
    this.powerful = opts.powerful ?? false;
    this.autoSummarize = opts.autoSummarize ?? true;
    this.autoSummarizeAtPct = opts.autoSummarizeAtPct ?? 85;
    this.keepRecentTurns = opts.keepRecentTurns ?? 3;
    this.storagePath =
      opts.storagePath ?? join(homedir(), ".multi-agent", "sessions", `${opts.id}.json`);
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_BUDGET;
    this.charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.load();
  }

  isPowerful(): boolean {
    return this.powerful;
  }

  setPowerful(value: boolean): void {
    this.powerful = value;
  }

  /**
   * Send one turn.
   *
   * Smart-routing flow (default):
   *   1. Append user message to history.
   *   2. Ask orchestrator for a JSON plan: direct/single/parallel.
   *   3. Execute the plan:
   *      - direct: orchestrator's answer becomes the reply.
   *      - single: dispatch to one specialist with clean conversation history.
   *      - parallel: dispatch to N specialists concurrently (each gets the
   *        clean history plus the per-task framing); orchestrator synthesizes.
   *   4. Append the final reply, persist, return.
   *
   * Simple-routing flow (smartRouting=false): always call `this.role` once.
   *
   * Powerful mode: when enabled, `thinking: high` is merged into every
   * underlying call's opts. Non-Gemini providers ignore it.
   */
  async send(userInput: string, opts?: CompleteOptions): Promise<SendResult> {
    // Merge powerful-mode thinking into the call opts. Caller opts win on conflict.
    const effectiveOpts: CompleteOptions = {
      ...(this.powerful && { thinking: "high" as const }),
      ...opts,
    };

    // Auto-summarize older turns if we're about to exceed budget.
    let summarizedTurns = 0;
    if (this.autoSummarize) {
      const projected =
        this.estimateTokens() + Math.ceil(userInput.length / this.charsPerToken);
      const projectedPct = (projected / this.tokenBudget) * 100;
      if (projectedPct >= this.autoSummarizeAtPct) {
        summarizedTurns = await this.summarizeOlderTurns(effectiveOpts);
      }
    }

    this.history.push({ kind: "user_text", text: userInput });

    let reply: string;
    let servedBy: RoleName[];
    let plan: Plan | undefined;
    try {
      if (!this.smartRouting) {
        reply = await this.resolver.runRoleChat(this.role, this.history, effectiveOpts);
        servedBy = [this.role];
      } else {
        const planned = await this.planAndExecute(effectiveOpts);
        reply = planned.reply;
        servedBy = planned.servedBy;
        plan = planned.plan;
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
    if (plan) result.plan = plan;
    if (summarizedTurns > 0) result.summarizedTurns = summarizedTurns;
    if (budgetPct >= 95) result.warning = "over-budget";
    else if (budgetPct >= 80) result.warning = "approaching-budget";
    return result;
  }

  /**
   * Collapse older turns into a single synthetic summary pair, keeping the
   * most recent `keepRecentTurns` user/assistant pairs verbatim. Persists
   * after the rewrite. Returns the number of turns (model_text entries)
   * actually folded into the summary; 0 if there was nothing to summarize
   * or the summarization call failed (in which case the call is silently
   * skipped so the user's message can still go through).
   */
  private async summarizeOlderTurns(opts: CompleteOptions): Promise<number> {
    const keepMessages = this.keepRecentTurns * 2;
    // Need at least keepMessages + 2 to have something to fold (so the kept
    // window doesn't include the summary slot itself).
    if (this.history.length <= keepMessages + 2) return 0;

    const cutoff = this.history.length - keepMessages;
    const toFold = this.history.slice(0, cutoff);
    const kept = this.history.slice(cutoff);

    // Count user/assistant pairs we're collapsing for the SendResult report.
    const foldedTurns = toFold.filter((p) => p.kind === "model_text").length;

    const summary = await this.callSummarizer(toFold, opts);
    if (!summary) return 0; // summarizer failed; leave history untouched

    this.history = [
      {
        kind: "user_text",
        text: `[The earlier portion of this conversation was auto-summarized to fit the context budget.]`,
      },
      { kind: "model_text", text: `Earlier conversation summary:\n\n${summary}` },
      ...kept,
    ];
    this.persist();
    return foldedTurns;
  }

  private async callSummarizer(
    parts: ConversationPart[],
    opts: CompleteOptions,
  ): Promise<string | null> {
    const lines: string[] = [];
    for (const p of parts) {
      if (p.kind === "user_text") lines.push(`User: ${p.text}`);
      else if (p.kind === "model_text") lines.push(`Assistant: ${p.text}`);
      else if (p.kind === "tool_result") lines.push(`Tool[${p.name}]: ${p.result}`);
    }
    const block = lines.join("\n\n");
    const prompt = `Summarize this earlier portion of a conversation. Preserve any decisions made, names mentioned, key facts established, and ongoing tasks or unresolved questions. Be terse but complete — this summary will replace the original turns in the conversation history, so future turns must be able to infer relevant context from your summary alone.

Conversation to summarize:

${block}

Output ONLY the summary, no preamble.`;
    try {
      return await this.resolver.runRole(this.role, prompt, opts);
    } catch (err) {
      console.error(`[chat-session] auto-summarize failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Smart-routing turn: ask orchestrator for a plan, then execute.
   * The plan preamble is injected into the planning call's history but never
   * persisted — chat history stays clean.
   */
  private async planAndExecute(
    opts: CompleteOptions,
  ): Promise<{ reply: string; servedBy: RoleName[]; plan: Plan }> {
    const orchHistory: ConversationPart[] = [
      { kind: "user_text", text: PLAN_PREAMBLE },
      { kind: "model_text", text: PLAN_ACK },
      ...this.history,
    ];
    const planRaw = await this.resolver.runRoleChat(this.role, orchHistory, opts);
    const plan = parsePlan(planRaw);

    if (plan.kind === "direct") {
      return { reply: plan.answer, servedBy: [this.role], plan };
    }

    if (plan.kind === "single") {
      const specialistHistory = this.historyWithFraming(plan.prompt);
      const reply = await this.resolver.runRoleChat(plan.role, specialistHistory, opts);
      return { reply, servedBy: [plan.role], plan };
    }

    // parallel: dispatch each task with its own framing, then synthesize.
    const settled = await Promise.allSettled(
      plan.tasks.map((t) =>
        this.resolver.runRoleChat(t.role, this.historyWithFraming(t.prompt), opts),
      ),
    );
    const perRole = plan.tasks.map((t, i) => {
      const res = settled[i]!;
      const output =
        res.status === "fulfilled" ? res.value : `[error: ${String(res.reason)}]`;
      return { role: t.role, output };
    });

    if (perRole.length === 1) {
      const only = perRole[0]!;
      return { reply: only.output, servedBy: [only.role], plan };
    }

    const synthesisHistory: ConversationPart[] = [
      ...this.history,
      {
        kind: "user_text",
        text:
          `[Orchestrator-internal: the user's last message was just delegated in parallel. ` +
          `Per-specialist outputs:\n\n` +
          perRole.map((p) => `<<<${p.role}\n${p.output}\n>>>`).join("\n\n") +
          `\n\nIntegrate these into one coherent answer for the user. No preamble, no per-specialist labels.]`,
      },
    ];
    const finalReply = await this.resolver.runRoleChat(this.role, synthesisHistory, opts);
    return {
      reply: finalReply,
      servedBy: [...perRole.map((p) => p.role), this.role],
      plan,
    };
  }

  /**
   * Build a history view for a specialist call: the conversation as-is,
   * optionally with a framing instruction appended as a synthetic user_text.
   * Specialist sees: full conversation + (if framing) "[Orchestrator: ...]".
   */
  private historyWithFraming(framing: string): ConversationPart[] {
    if (!framing.trim()) return this.history;
    return [
      ...this.history,
      { kind: "user_text", text: `[Orchestrator framing for you: ${framing}]` },
    ];
  }

  /** Clear conversation history. Persists immediately. */
  clear(): void {
    this.history = [];
    this.updatedAt = Date.now();
    this.persist();
  }

  /**
   * Save a snapshot of the current history under a new session id. The current
   * session continues unchanged — useful for branching ("save here, then keep
   * exploring; come back to this point later"). The new file lives next to
   * this session's storage file by default.
   */
  saveAs(newId: string): string {
    const newPath = join(dirname(this.storagePath), `${newId}.json`);
    mkdirSync(dirname(newPath), { recursive: true });
    const body = JSON.stringify(
      {
        version: SESSION_VERSION,
        id: newId,
        role: this.role,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        history: this.history,
      },
      null,
      2,
    );
    writeFileSync(newPath, body, "utf8");
    return newPath;
  }

  /**
   * Replace this session's history with the contents of another session file.
   * The current history is overwritten (the new state immediately persists to
   * THIS session's file). Use saveAs() first if you want to keep the current
   * state under another id before loading.
   *
   * Returns true if the load succeeded, false if the source didn't exist.
   */
  loadFrom(otherId: string): boolean {
    const otherPath = join(dirname(this.storagePath), `${otherId}.json`);
    if (!existsSync(otherPath)) return false;
    try {
      const raw = readFileSync(otherPath, "utf8");
      const parsed = JSON.parse(raw) as { history?: ConversationPart[] };
      if (!Array.isArray(parsed.history)) return false;
      this.history = parsed.history;
      this.updatedAt = Date.now();
      this.persist();
      return true;
    } catch (err) {
      console.error(`[chat-session] failed to load ${otherPath}: ${(err as Error).message}`);
      return false;
    }
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
