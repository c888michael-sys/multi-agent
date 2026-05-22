import type { Provider, CompleteOptions } from "../src/provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../src/tools/types.js";

export type Reply =
  | { kind: "ok"; text: string }
  | { kind: "rate"; retryAfterMs?: number | null }
  | { kind: "error"; error: Error };

/** Deterministic provider for tests. Queues replies; each call shifts one. */
export class FakeProvider implements Provider {
  readonly id: string;
  readonly model = "fake-model";
  calls: { prompt: string; opts?: CompleteOptions }[] = [];
  private replies: Reply[];

  constructor(id: string, replies: Reply[]) {
    this.id = id;
    this.replies = [...replies];
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`FakeProvider(${this.id}): no replies queued`);
    if (reply.kind === "ok") return reply.text;
    if (reply.kind === "rate") {
      const err = new RateLimitedError("429 rate limit", reply.retryAfterMs ?? null);
      throw err;
    }
    throw reply.error;
  }

  isRateLimitError(err: unknown): boolean {
    return err instanceof RateLimitedError;
  }

  retryAfterMs(err: unknown): number | null {
    return err instanceof RateLimitedError ? err.retryAfterMs : null;
  }
}

/** Provider scripted for tool-use tests. */
export class ToolFakeProvider implements Provider {
  readonly id: string;
  readonly model = "fake-tool-model";
  toolCalls: { history: ConversationPart[]; tools: ToolDeclaration[] }[] = [];
  private scripted: CompleteWithToolsResult[];

  constructor(id: string, scripted: CompleteWithToolsResult[]) {
    this.id = id;
    this.scripted = [...scripted];
  }

  async complete(): Promise<string> {
    throw new Error("ToolFakeProvider does not support plain complete()");
  }

  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
  ): Promise<CompleteWithToolsResult> {
    this.toolCalls.push({ history: [...history], tools: [...tools] });
    const next = this.scripted.shift();
    if (!next) throw new Error(`ToolFakeProvider(${this.id}): out of scripted responses`);
    return next;
  }

  isRateLimitError() {
    return false;
  }
  retryAfterMs() {
    return null;
  }
}

export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(msg: string, retryAfterMs: number | null) {
    super(msg);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}
