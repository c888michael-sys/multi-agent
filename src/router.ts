import type { Provider, CompleteOptions } from "./provider.js";
import { ProviderPool, type ProviderConfig, type PoolMode } from "./pool.js";
import type { StateStore } from "./state.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "./tools/types.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError } from "./errors.js";

/**
 * Optional out-parameter callers can pass to learn which provider actually
 * served the call (useful when an allow-list spans multiple providers and
 * the caller wants to attribute the response). The router writes to
 * `providerId` immediately before invoking the provider; on success the
 * field reflects the provider that returned the result.
 */
export interface CallAttribution {
  providerId?: string;
}

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
  /**
   * Optional callback invoked after every successful provider call (across
   * complete / completeWithTools / completeChat). Used to drive
   * ConservationPolicy.tick() so the pool mode adapts in real time. Errors
   * in the callback are swallowed so an instrumentation bug can't kill a
   * successful response.
   */
  onAfterCall?: () => void;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_JITTER = () => Math.floor(Math.random() * 500); // 0–499 ms

export class Router {
  private readonly pool: ProviderPool;
  private readonly now: () => number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private onAfterCall: () => void;

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
    this.onAfterCall = options?.onAfterCall ?? (() => {});
  }

  /** Replace the post-call hook. Used to wire ConservationPolicy after construction. */
  setOnAfterCall(fn: () => void): void {
    this.onAfterCall = fn;
  }

  /** Safely invoke the after-call hook — swallow any error from the listener. */
  private fireAfterCall(): void {
    try {
      this.onAfterCall();
    } catch {
      // intentional: instrumentation must never break a successful response
    }
  }

  /**
   * Run a text completion. If `providerIds` is provided, the call is constrained
   * to providers whose id is in that set — used by role-based routing to pin a
   * call to (e.g.) "only Gemini" or "only the reasoning model".
   */
  async complete(
    prompt: string,
    opts?: CompleteOptions,
    providerIds?: ReadonlySet<string>,
    attribution?: CallAttribution,
  ): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      const tryResult = await this.tryEachAvailable(prompt, opts, attempts, providerIds, attribution);
      if (tryResult.kind === "ok") return tryResult.text;

      if (this.maxRetryWaitMs <= 0) {
        throw new AllProvidersExhaustedError(attempts);
      }

      const earliest = this.pool.earliestAvailableIn(providerIds);
      if (!isFinite(earliest)) {
        // No providers in the (filtered) set at all. Definitively exhausted.
        throw new AllProvidersExhaustedError(attempts);
      }
      const waitMs = Math.max(0, earliest - this.now()) + this.jitter();
      const totalElapsedIfWeWait = this.now() - startedAt + waitMs;
      if (totalElapsedIfWeWait > this.maxRetryWaitMs) {
        throw new AllProvidersExhaustedError(attempts);
      }
      await this.sleep(waitMs);
    }
  }

  private async tryEachAvailable(
    prompt: string,
    opts: CompleteOptions | undefined,
    attempts: { providerId: string; error: unknown }[],
    providerIds: ReadonlySet<string> | undefined,
    attribution: CallAttribution | undefined,
  ): Promise<{ kind: "ok"; text: string } | { kind: "all_cooled" }> {
    for (let i = 0; i < this.pool.size(); i++) {
      const pick = this.pool.pickAvailable(providerIds);
      if (!pick) break;

      try {
        if (attribution) attribution.providerId = pick.provider.id;
        const result = await pick.provider.complete(prompt, opts);
        this.pool.markSuccess(pick.index);
        this.fireAfterCall();
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
   * implement completeWithTools. Supports `providerIds` constraint just like
   * complete().
   */
  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
    providerIds?: ReadonlySet<string>,
    attribution?: CallAttribution,
  ): Promise<CompleteWithToolsResult> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      for (let i = 0; i < this.pool.size(); i++) {
        const pick = this.pool.pickAvailable(providerIds);
        if (!pick) break;
        if (!pick.provider.completeWithTools) {
          // Provider doesn't support tools. Don't mark as rate-limited; just skip.
          continue;
        }
        try {
          if (attribution) attribution.providerId = pick.provider.id;
          const result = await pick.provider.completeWithTools(history, tools, opts);
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
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

      if (this.maxRetryWaitMs <= 0 || attempts.length === 0) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const earliest = this.pool.earliestAvailableIn(providerIds);
      if (!isFinite(earliest)) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const waitMs = Math.max(0, earliest - this.now()) + this.jitter();
      if (this.now() - startedAt + waitMs > this.maxRetryWaitMs) {
        throw new AllProvidersExhaustedError(attempts);
      }
      await this.sleep(waitMs);
    }
  }

  /**
   * Multi-turn chat completion (no tools). Same failover semantics as
   * complete(). Providers without completeChat() are skipped.
   */
  async completeChat(
    history: ConversationPart[],
    opts?: CompleteOptions,
    providerIds?: ReadonlySet<string>,
    attribution?: CallAttribution,
  ): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      for (let i = 0; i < this.pool.size(); i++) {
        const pick = this.pool.pickAvailable(providerIds);
        if (!pick) break;
        if (!pick.provider.completeChat) continue; // skip non-chat-capable providers
        try {
          if (attribution) attribution.providerId = pick.provider.id;
          const result = await pick.provider.completeChat(history, opts);
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
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

      if (this.maxRetryWaitMs <= 0 || attempts.length === 0) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const earliest = this.pool.earliestAvailableIn(providerIds);
      if (!isFinite(earliest)) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const waitMs = Math.max(0, earliest - this.now()) + this.jitter();
      if (this.now() - startedAt + waitMs > this.maxRetryWaitMs) {
        throw new AllProvidersExhaustedError(attempts);
      }
      await this.sleep(waitMs);
    }
  }

  /**
   * Streaming chat — same failover semantics as completeChat. Providers
   * that implement completeChatStream() emit incremental tokens via
   * onToken; ones that don't fall back to completeChat() + one final
   * onToken call with the entire reply. Returns the full assembled
   * string.
   */
  async completeChatStream(
    history: ConversationPart[],
    opts: CompleteOptions | undefined,
    providerIds: ReadonlySet<string> | undefined,
    attribution: CallAttribution | undefined,
    onToken: (text: string) => void,
  ): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];
    const startedAt = this.now();

    while (true) {
      for (let i = 0; i < this.pool.size(); i++) {
        const pick = this.pool.pickAvailable(providerIds);
        if (!pick) break;
        const stream = pick.provider.completeChatStream?.bind(pick.provider);
        const chat = pick.provider.completeChat?.bind(pick.provider);
        if (!stream && !chat) continue;
        try {
          if (attribution) attribution.providerId = pick.provider.id;
          let result: string;
          if (stream) {
            result = await stream(history, opts, onToken);
          } else {
            // Fallback: provider has no streaming — wait for the full
            // reply, then emit it as one final token so callers don't
            // need a separate code path.
            result = await chat!(history, opts);
            if (result) onToken(result);
          }
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
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
      if (this.maxRetryWaitMs <= 0 || attempts.length === 0) {
        throw new AllProvidersExhaustedError(attempts);
      }
      const earliest = this.pool.earliestAvailableIn(providerIds);
      if (!isFinite(earliest)) {
        throw new AllProvidersExhaustedError(attempts);
      }
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

  /** Which provider IDs are registered. Used by RoleResolver for filtering. */
  registeredProviderIds(): string[] {
    return this.pool.snapshot().map((p) => p.id);
  }
}
