import type { Provider, CompleteOptions } from "../src/provider.js";

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

export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(msg: string, retryAfterMs: number | null) {
    super(msg);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}
