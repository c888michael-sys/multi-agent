import type { Provider, CompleteOptions } from "./provider.js";
import { ProviderPool, type ProviderConfig, type PoolMode } from "./pool.js";
import type { StateStore } from "./state.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "./tools/types.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError, StreamInterruptedError } from "./errors.js";

class ProviderTimeoutError extends Error {
  readonly retryAfterMs = 5_000;

  constructor(providerId: string, timeoutMs: number) {
    super(`Provider ${providerId} timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

class ProviderAbortError extends Error {
  constructor() {
    super("Provider request aborted");
    this.name = "AbortError";
  }
}

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
  requestTimeoutMs?: number;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_JITTER = () => Math.floor(Math.random() * 500); // 0–499 ms
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class Router {
  private readonly pool: ProviderPool;
  private readonly now: () => number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly requestTimeoutMs: number;
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
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
      await this.sleepWithSignal(waitMs, opts?.signal);
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
        const result = await this.callWithTimeout(
          pick.provider.id,
          pick.provider.requestTimeoutMs ?? this.requestTimeoutMs,
          opts?.signal,
          (signal) => pick.provider.complete(prompt, this.withSignal(opts, signal)),
        );
        this.pool.markSuccess(pick.index);
        this.fireAfterCall();
        return { kind: "ok", text: result };
      } catch (err) {
        if (pick.provider.isRateLimitError(err) || err instanceof ProviderTimeoutError) {
          const retryAfterMs = err instanceof ProviderTimeoutError
            ? err.retryAfterMs
            : pick.provider.retryAfterMs(err);
          this.pool.markRateLimited(pick.index, retryAfterMs);
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
          const result = await this.callWithTimeout(
            pick.provider.id,
            pick.provider.requestTimeoutMs ?? this.requestTimeoutMs,
            opts?.signal,
            (signal) => pick.provider.completeWithTools!(history, tools, this.withSignal(opts, signal)),
          );
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
          return result;
        } catch (err) {
          if (pick.provider.isRateLimitError(err) || err instanceof ProviderTimeoutError) {
            const retryAfterMs = err instanceof ProviderTimeoutError
              ? err.retryAfterMs
              : pick.provider.retryAfterMs(err);
            this.pool.markRateLimited(pick.index, retryAfterMs);
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
      await this.sleepWithSignal(waitMs, opts?.signal);
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
          const result = await this.callWithTimeout(
            pick.provider.id,
            pick.provider.requestTimeoutMs ?? this.requestTimeoutMs,
            opts?.signal,
            (signal) => pick.provider.completeChat!(history, this.withSignal(opts, signal)),
          );
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
          return result;
        } catch (err) {
          if (pick.provider.isRateLimitError(err) || err instanceof ProviderTimeoutError) {
            const retryAfterMs = err instanceof ProviderTimeoutError
              ? err.retryAfterMs
              : pick.provider.retryAfterMs(err);
            this.pool.markRateLimited(pick.index, retryAfterMs);
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
      await this.sleepWithSignal(waitMs, opts?.signal);
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
        let committed = false;
        let leadingWhitespace = "";
        let emitted = "";
        const commitToken = (text: string) => {
          if (!committed) {
            if (!/\S/.test(text)) { leadingWhitespace += text; return; }
            committed = true;
            text = leadingWhitespace + text;
            leadingWhitespace = "";
          }
          emitted += text;
          onToken(text);
        };
        try {
          if (attribution) attribution.providerId = pick.provider.id;
          let result: string;
          if (stream) {
            result = await this.callWithTimeout(
              pick.provider.id,
              pick.provider.requestTimeoutMs ?? this.requestTimeoutMs,
              opts?.signal,
              (signal) => stream(history, this.withSignal(opts, signal), commitToken),
            );
          } else {
            // Fallback: provider has no streaming — wait for the full
            // reply, then emit it as one final token so callers don't
            // need a separate code path.
            result = await this.callWithTimeout(
              pick.provider.id,
              pick.provider.requestTimeoutMs ?? this.requestTimeoutMs,
              opts?.signal,
              (signal) => chat!(history, this.withSignal(opts, signal)),
            );
            if (result) commitToken(result);
          }
          this.pool.markSuccess(pick.index);
          this.fireAfterCall();
          return result;
        } catch (err) {
          if (committed) throw new StreamInterruptedError(emitted, err);
          if ((err as { name?: string })?.name === "AbortError") throw err;
          if (pick.provider.isRateLimitError(err) || err instanceof ProviderTimeoutError) {
            const retryAfterMs = err instanceof ProviderTimeoutError
              ? err.retryAfterMs
              : pick.provider.retryAfterMs(err);
            this.pool.markRateLimited(pick.index, retryAfterMs);
            attempts.push({ providerId: pick.provider.id, error: err });
            continue;
          }
          this.pool.markRateLimited(pick.index, 1_000);
          attempts.push({ providerId: pick.provider.id, error: err });
          continue;
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
      await this.sleepWithSignal(waitMs, opts?.signal);
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

  /** Look up a registered provider by id. Used by RoleResolver to skip inactive override slots. */
  getProvider(id: string): Provider | undefined {
    return this.pool.getProvider(id);
  }

  private withSignal(opts: CompleteOptions | undefined, signal: AbortSignal): CompleteOptions {
    return { ...opts, signal };
  }

  private async callWithTimeout<T>(
    providerId: string,
    timeoutMs: number,
    parentSignal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let rejectAbort: (err: ProviderAbortError) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abortFromParent = () => {
      controller.abort();
      rejectAbort(new ProviderAbortError());
    };
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderTimeoutError(providerId, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([fn(controller.signal), timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  private async sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) throw new ProviderAbortError();

    let abortFromParent: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortFromParent = () => reject(new ProviderAbortError());
      signal.addEventListener("abort", abortFromParent, { once: true });
    });

    try {
      await Promise.race([this.sleep(ms), aborted]);
    } finally {
      if (abortFromParent) signal.removeEventListener("abort", abortFromParent);
    }
  }
}
