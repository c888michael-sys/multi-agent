import { createInterface, Interface as ReadlineInterface } from "node:readline";
import type { Router } from "../router.js";
import type { ChatSession } from "./session.js";

export interface ReplOptions {
  session: ChatSession;
  router: Router;
  /** stdin/stdout override for tests. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const HELP_TEXT = `Slash commands (accept / or \\ prefix):
  /clear              wipe session history (persists immediately)
  /truncate <N>       keep only the most recent N turns
  /info               show session id, turn count, token estimate, mode flags
  /usage              show provider usage snapshot
  /power [on|off]     toggle "powerful" mode (Gemini thinking=high every call)
  /help               show this help
  /exit (or 'exit')   leave the session (history persists to disk)`;

/**
 * Interactive REPL on top of a ChatSession. Synchronous input loop via
 * node:readline. Slash commands are handled locally; everything else is
 * sent to the session.
 *
 * Token warnings:
 *   - At 80%, print a warning and continue.
 *   - At 95%, prompt the user to clear, truncate, or continue anyway.
 */
export class ChatRepl {
  private readonly session: ChatSession;
  private readonly router: Router;
  private readonly rl: ReadlineInterface;
  private readonly output: NodeJS.WritableStream;
  private exiting = false;

  constructor(opts: ReplOptions) {
    this.session = opts.session;
    this.router = opts.router;
    this.output = opts.output ?? process.stdout;
    this.rl = createInterface({
      input: opts.input ?? process.stdin,
      output: this.output,
      prompt: this.makePrompt(),
      terminal: false, // avoid escape codes in piped output
    });
  }

  async run(): Promise<void> {
    const existing = this.session.turnCount();
    if (existing > 0) {
      this.println(
        `chat: resuming session '${this.session.id}' with ${existing} prior turn(s). Use /clear to wipe history, /help for commands, /exit to leave.`,
      );
    } else {
      this.println(
        `chat: new session '${this.session.id}'. /help for commands, /clear to wipe history, /exit to leave.`,
      );
    }
    if (this.session.isPowerful()) {
      this.println(`(powerful mode ON — Gemini will use thinking=high on every call)`);
    }

    // Event-driven loop with a queue so handlers can be async without missing
    // pipelined input. for-await would crash when the stream closes mid-handler.
    const queue: string[] = [];
    let resolveNext: ((value: string | null) => void) | null = null;
    let inputClosed = false;

    const onLine = (raw: string) => {
      const line = raw.trim();
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(line);
      } else {
        queue.push(line);
      }
    };
    const onClose = () => {
      inputClosed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null); // signal end
      }
    };
    this.rl.on("line", onLine);
    this.rl.on("close", onClose);

    const nextLine = (): Promise<string | null> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (inputClosed) return Promise.resolve(null);
      return new Promise((res) => {
        resolveNext = res;
      });
    };

    this.safePrompt();
    while (!this.exiting) {
      const line = await nextLine();
      if (line === null) break; // stdin closed
      if (!line) {
        this.safePrompt();
        continue;
      }
      // Accept either "/cmd" or "\cmd" — Windows users habitually type backslash.
      // Also accept bare "exit"/"quit" as friendly aliases for /exit.
      if (line.startsWith("/") || line.startsWith("\\")) {
        const normalized = "/" + line.slice(1);
        const handled = await this.handleSlash(normalized);
        if (handled === "exit") break;
      } else if (line === "exit" || line === "quit") {
        const handled = await this.handleSlash("/exit");
        if (handled === "exit") break;
      } else {
        await this.handleMessage(line);
      }
      this.rl.setPrompt(this.makePrompt());
      this.safePrompt();
    }
    this.rl.off("line", onLine);
    this.rl.off("close", onClose);
    try {
      this.rl.close();
    } catch {
      // already closed
    }
  }

  /** Call rl.prompt() only if readline hasn't been closed — avoids ERR_USE_AFTER_CLOSE. */
  private safePrompt(): void {
    try {
      this.rl.prompt();
    } catch {
      // readline closed; nothing to do
    }
  }

  /** Process a user message: warn on budget, optionally prompt before sending, then send. */
  private async handleMessage(message: string): Promise<void> {
    // Pre-send budget check on what the history WOULD be after appending.
    // Cheap: just add message length to current estimate.
    const projected =
      this.session.estimateTokens() +
      Math.ceil(message.length / 4); // matches default charsPerToken
    const projectedPct = (projected / this.session.tokenBudget) * 100;
    if (projectedPct >= 95) {
      const proceed = await this.confirm(
        `⚠ This message would push context to ~${projectedPct.toFixed(0)}% of budget (${projected} / ${this.session.tokenBudget} est. tokens). Continue anyway? [y/N/c] (c = clear history first) `,
      );
      if (proceed === "no") return;
      if (proceed === "clear") this.session.clear();
    } else if (projectedPct >= 80) {
      this.println(
        `⚠ Approaching token budget (${projectedPct.toFixed(0)}%). Consider /clear or /truncate.`,
      );
    }

    let result;
    try {
      result = await this.session.send(message);
    } catch (err) {
      this.println(`error: ${(err as Error).message}`);
      return;
    }
    // Surface specialist routing so the user knows which model(s) answered.
    if (result.plan && result.plan.kind === "parallel") {
      const roles = result.servedBy.filter((r) => r !== "orchestration");
      this.println(`[parallel: ${roles.join(", ")} → synthesized]`);
    } else if (result.servedBy.length === 1 && result.servedBy[0] !== "orchestration") {
      this.println(`[routed to ${result.servedBy[0]}]`);
    }
    this.println(result.reply);
    if (result.warning === "over-budget") {
      this.println(
        `(now at ${result.budgetPct.toFixed(0)}% of token budget — /clear or /truncate recommended)`,
      );
    } else if (result.warning === "approaching-budget") {
      this.println(`(now at ${result.budgetPct.toFixed(0)}% of token budget)`);
    }
  }

  private async handleSlash(line: string): Promise<"continue" | "exit"> {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/help":
        this.println(HELP_TEXT);
        return "continue";
      case "/clear":
        this.session.clear();
        this.println("history cleared.");
        return "continue";
      case "/usage": {
        const { formatUsageReport } = await import("../conservation.js");
        this.println(formatUsageReport(this.router));
        return "continue";
      }
      case "/info":
        this.println(
          `session id: ${this.session.id}\n` +
            `role: ${this.session.role}, smart-routing: ${this.session.smartRouting ? "on" : "off"}, powerful: ${this.session.isPowerful() ? "on" : "off"}\n` +
            `turns: ${this.session.turnCount()}, est. tokens: ${this.session.estimateTokens()} / ${this.session.tokenBudget}\n` +
            `storage: ${this.session.storagePath}`,
        );
        return "continue";
      case "/power": {
        const arg = (rest[0] ?? "").toLowerCase();
        if (arg === "on") this.session.setPowerful(true);
        else if (arg === "off") this.session.setPowerful(false);
        else this.session.setPowerful(!this.session.isPowerful());
        this.println(
          `powerful mode: ${this.session.isPowerful() ? "ON" : "OFF"}` +
            (this.session.isPowerful()
              ? " — Gemini will now use thinking=high on every call this session."
              : ""),
        );
        return "continue";
      }
      case "/truncate": {
        const n = parseInt(rest[0] ?? "", 10);
        if (!Number.isFinite(n) || n < 1) {
          this.println("usage: /truncate <positive integer>");
          return "continue";
        }
        this.session.truncateToRecent(n);
        this.println(`kept the most recent ${n} turn(s).`);
        return "continue";
      }
      case "/exit":
        this.exiting = true;
        this.rl.close();
        return "exit";
      default:
        this.println(`unknown command: ${cmd}. /help for list.`);
        return "continue";
    }
  }

  /** Prompt the user with a yes/no/clear choice. Returns "yes" | "no" | "clear". */
  private confirm(question: string): Promise<"yes" | "no" | "clear"> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "y" || a === "yes") resolve("yes");
        else if (a === "c" || a === "clear") resolve("clear");
        else resolve("no");
      });
    });
  }

  private makePrompt(): string {
    return `chat:${this.session.id}> `;
  }

  private println(s: string): void {
    this.output.write(s + "\n");
  }
}
