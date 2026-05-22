import type { Provider, CompleteOptions } from "./provider.js";
import { ProviderPool, type ProviderConfig, type PoolMode } from "./pool.js";
import type { StateStore } from "./state.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "./tools/types.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError } from "./errors.js";

export interface RouterOptions {
  now?: () => number;
  mode?: PoolMode;
  /**
   * When every provider in the pool is cooling down, wait until at least one
   * recovers (capped at maxRetryWaitMs total wait per complete() call) before
   * throwing AllProvidersExhaustedError. 0 disables — old behavior, throws
   * immediately. Default 90_000 (90s — leaves headroom over the typical 60s
   * per-minute recovery so one retry cycle actually fits under the cap).
   */
  maxRetryWaitMs?: number;
  /** Override for tests. Default delegates to global setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests. Adds random ms to each backoff sleep to avoid thundering herd. */
  jitterMs?: () => number;
  /**
   * Persistent usage store. When set, per-provider counters and cooldowns
   * survive across process restarts and reset daily (UTC). When unset, all
   * state lives only for this Router instance.
   */
  stateStore?: StateStore;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_JITTER = () => Math.floor(Math.random() * 500); // 0–499 ms

export class Router {
  private readonly pool: ProviderPool;
  private readonly now: () => number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(providers: Array<Provider | ProviderConfig>, options?: RouterOptions) {
    if (providers.length === 0) throw new NoProvidersConfiguredError();
    this.now = options?.now ?? Date.now;
    this.pool = new ProviderPool(providers, {
      now: this.now,
      ...(options?.mode && { mode: options.mode }),
      ...(options?.stateStore && { stateStore: options.stateStore }),
    });
    this.maxRetryWaitMs = options?.maxRetryWaitMs ?? 90_000;
    this.sleep = options?.sleep ?? DEFAULT_SLEEP;
    this.jitter = options?.jitterMs ?? DEFAULT_JITTER;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      const tryResult = await this.tryEachAvailable(prompt, opts, attempts);
      if (tryResult.kind === "ok") return tryResult.text;

      // All providers cooled. Either back off and retry, or give up.
      if (this.maxRetryWaitMs <= 0) {
        throw new AllProvidersExhaustedError(attempts);
      }

      const earliest = this.pool.earliestAvailable();
      const waitMs = Math.max(0, earliest - this.now()) + this.jitter();
      const totalElapsedIfWeWait = this.now() - startedAt + waitMs;
      if (totalElapsedIfWeWait > this.maxRetryWaitMs) {
        throw new AllProvidersExhaustedError(attempts);
      }
      await this.sleep(waitMs);
      // loop: re-try with the same prompt
    }
  }

  /**
   * One pass: try every available provider in pool order. Returns ok on first
   * success, or "all_cooled" if every available one rate-limited (or none were
   * available to begin with). Non-rate-limit errors propagate immediately.
   */
  private async tryEachAvailable(
    prompt: string,
    opts: CompleteOptions | undefined,
    attempts: { providerId: string; error: unknown }[],
  ): Promise<{ kind: "ok"; text: string } | { kind: "all_cooled" }> {
    for (let i = 0; i < this.pool.size(); i++) {
      const pick = this.pool.pickAvailable();
      if (!pick) break;

      try {
        const result = await pick.provider.complete(prompt, opts);
        this.pool.markSuccess(pick.index);
        return { kind: "ok", text: result };
      } catch (err) {
        if (pick.provider.isRateLimitError(err)) {
          this.pool.markRateLimited(pick.index, pick.provider.retryAfterMs(err));
          attempts.push({ providerId: pick.provider.id, error: err });
          continue;
        }
        throw err;
      }
    }
    return { kind: "all_cooled" };
  }

  /**
   * Like complete(), but supports tool-use (function calling). Returns either
   * model text (done) or a list of tool calls to execute. Same rate-limit
   * rotation and backoff semantics as complete(). Skips providers that don't
   * implement completeWithTools.
   */
  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      for (let i = 0; i < this.pool.size(); i++) {
        const pick = this.pool.pickAvailable();
        if (!pick) break;
        if (!pick.provider.completeWithTools) {
          // Skip silently; in a heterogeneous pool, some providers may not support tools.
          continue;
        }
        try {
          const result = await pick.provider.completeWithTools(history, tools, opts);
          this.pool.markSuccess(pick.index);
          return result;
        } catch (err) {
          if (pick.provider.isRateLimitError(err)) {
            this.pool.markRateLimited(pick.index, pick.provider.retryAfterMs(err));
            attempts.push({ providerId: pick.provider.id, error: err });
            continue;
          }
          throw err;
        }
      }

      // All providers cooled or none supports tools.
      if (this.maxRetryWaitMs <= 0 || attempts.length === 0) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const earliest = this.pool.earliestAvailable();
      const waitMs = Math.max(0, earliest - this.now()) + this.jitter();
      if (this.now() - startedAt + waitMs > this.maxRetryWaitMs) {
        throw new AllProvidersExhaustedError(attempts);
      }
      await this.sleep(waitMs);
    }
  }

  /** Caller-visible state — call counts, cooldowns, remaining quota %. */
  snapshot() {
    return this.pool.snapshot();
  }

  getMode(): PoolMode {
    return this.pool.getMode();
  }

  setMode(mode: PoolMode): void {
    this.pool.setMode(mode);
  }
}
