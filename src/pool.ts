import type { Provider } from "./provider.js";
import { type StateStore, emptyUsage, rollover, utcDay } from "./state.js";

export type PoolMode = "round-robin" | "serial";

interface ProviderState {
  provider: Provider;
  cooldownUntil: number;
  successCount: number;
  rateLimitCount: number;
  /** Caller-supplied estimate of total daily requests this provider can serve, or undefined. */
  estimatedDailyBudget?: number;
  /** Caller-supplied estimate of per-minute request cap, or undefined. */
  estimatedRpmCap?: number;
  /**
   * Fallback cooldown to use when a rate-limit response arrives without a
   * Retry-After header. Defaults to 60s if not set — but most providers
   * benefit from a tighter value (e.g. OpenRouter's per-minute window is
   * short; their daily caps are reported via header).
   */
  defaultCooldownMs?: number;
  /** Sliding-window timestamps (ms) of requests in the last 60s. NOT persisted —
   *  the window is process-local because RPM is a short-term real-time signal,
   *  not a cumulative counter. */
  recentRequestTimes: number[];
}

export interface PickResult {
  provider: Provider;
  index: number;
}

/**
 * `source: 'live'` means the values came straight off a provider response
 * header (X-RateLimit-*) — accurate, ground-truth.
 * `source: 'estimated'` means the values are computed from our local
 * counters (sliding RPM window + cumulative success). Slightly stale; the
 * provider may have its own counter that differs.
 */
export type QuotaSource = "live" | "estimated";

export interface ProviderSnapshot {
  id: string;
  /** Absolute timestamp (ms since epoch) when the provider becomes available. */
  cooldownUntil: number;
  /** Milliseconds until the provider is available; 0 if already available. */
  cooldownMsRemaining: number;
  /** Today's successful completions (UTC-day, persisted). */
  successCount: number;
  /** Today's rejected-by-rate-limit attempts (UTC-day, persisted). */
  rateLimitCount: number;
  estimatedDailyBudget?: number;
  /** Percent of estimated daily budget remaining (0-100). For 'live' sources
   *  this is computed from header-reported rpdRemaining when available;
   *  otherwise from local successCount / estimatedDailyBudget. */
  remainingPct?: number;
  /** Approximate requests in the last 60 seconds. From live header when
   *  available; otherwise from our sliding window. */
  rpmCount: number;
  /** Per-minute cap. Header-reported when available; otherwise the configured estimate. */
  rpmCap?: number;
  /** Where the RPM/RPD numbers came from. */
  rpmSource: QuotaSource;
  rpdSource: QuotaSource;
  /** ms-since-epoch when the live header was scraped; only set for source='live'. */
  liveQuotaFetchedAt?: number;
}

export interface ProviderConfig {
  provider: Provider;
  estimatedDailyBudget?: number;
  estimatedRpmCap?: number;
  /** Fallback cooldown when Retry-After header is missing. Defaults to 60s. */
  defaultCooldownMs?: number;
}

export interface PoolOptions {
  now?: () => number;
  mode?: PoolMode;
  /**
   * Optional persistent store for per-provider counters and cooldowns.
   * When set, the pool hydrates on construction and writes back after each
   * markSuccess/markRateLimited call. Daily counters reset automatically on
   * UTC-day rollover.
   */
  stateStore?: StateStore;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export class ProviderPool {
  private readonly entries: ProviderState[];
  private cursor = 0;
  private mode: PoolMode;
  private readonly now: () => number;
  private readonly stateStore: StateStore | undefined;

  constructor(providers: Array<Provider | ProviderConfig>, options?: PoolOptions) {
    this.now = options?.now ?? Date.now;
    this.mode = options?.mode ?? "round-robin";
    this.stateStore = options?.stateStore;

    const persisted = this.stateStore?.load() ?? {};
    const today = utcDay(this.now());

    this.entries = providers.map((p) => {
      const cfg = "provider" in p ? p : { provider: p };
      const existing = persisted[cfg.provider.id];
      const usage = existing ? rollover(existing, today) : emptyUsage(today);
      return {
        provider: cfg.provider,
        cooldownUntil: usage.cooldownUntil,
        successCount: usage.successCount,
        rateLimitCount: usage.rateLimitCount,
        recentRequestTimes: [],
        ...(cfg.estimatedDailyBudget !== undefined && {
          estimatedDailyBudget: cfg.estimatedDailyBudget,
        }),
        ...(cfg.estimatedRpmCap !== undefined && {
          estimatedRpmCap: cfg.estimatedRpmCap,
        }),
        ...(cfg.defaultCooldownMs !== undefined && {
          defaultCooldownMs: cfg.defaultCooldownMs,
        }),
      };
    });

    // Write back immediately so any rollover state is persisted even if no
    // calls happen this invocation.
    this.persist();
  }

  size(): number {
    return this.entries.length;
  }

  getMode(): PoolMode {
    return this.mode;
  }

  setMode(mode: PoolMode): void {
    this.mode = mode;
  }

  /**
   * Pick a provider that isn't currently cooling down.
   *
   *  - round-robin: cycle through providers, distributing load evenly.
   *  - serial:      always start from index 0; only advance when the current one cools.
   *                 Concentrates usage on one provider until it's depleted, so the
   *                 others stay fully reserved for emergencies.
   *
   * If `idAllowList` is provided, only providers whose id is in the list are
   * considered. Used by role-based routing to constrain calls to specific
   * providers (e.g., reasoning role only wants the DeepSeek R1 provider).
   */
  pickAvailable(idAllowList?: ReadonlySet<string>): PickResult | null {
    const t = this.now();
    const start = this.mode === "round-robin" ? this.cursor : 0;

    for (let i = 0; i < this.entries.length; i++) {
      const idx = (start + i) % this.entries.length;
      const entry = this.entries[idx]!;
      if (idAllowList && !idAllowList.has(entry.provider.id)) continue;
      if (entry.cooldownUntil <= t) {
        if (this.mode === "round-robin") {
          this.cursor = (idx + 1) % this.entries.length;
        }
        return { provider: entry.provider, index: idx };
      }
    }
    return null;
  }

  /** Earliest moment any provider in the (optionally-filtered) set becomes available. */
  earliestAvailableIn(idAllowList?: ReadonlySet<string>): number {
    const eligible = idAllowList
      ? this.entries.filter((e) => idAllowList.has(e.provider.id))
      : this.entries;
    if (eligible.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...eligible.map((e) => e.cooldownUntil));
  }

  /** Are any providers in the (optionally-filtered) set currently registered? */
  hasAnyOf(idAllowList: ReadonlySet<string>): boolean {
    return this.entries.some((e) => idAllowList.has(e.provider.id));
  }

  /** Prune the RPM sliding window to the last 60 seconds. */
  private pruneRpm(entry: ProviderState, t: number): void {
    const cutoff = t - 60_000;
    let i = 0;
    while (i < entry.recentRequestTimes.length && entry.recentRequestTimes[i]! < cutoff) {
      i++;
    }
    if (i > 0) entry.recentRequestTimes.splice(0, i);
  }

  markSuccess(index: number): void {
    const entry = this.entries[index];
    if (!entry) return;
    const t = this.now();
    entry.successCount++;
    this.pruneRpm(entry, t);
    entry.recentRequestTimes.push(t);
    this.persist();
  }

  markRateLimited(index: number, retryAfterMs: number | null): void {
    const entry = this.entries[index];
    if (!entry) return;
    const t = this.now();
    entry.rateLimitCount++;
    // Prefer the provider's Retry-After hint; fall back to the entry's
    // configured default (per-provider tuned), then to a global 60s floor.
    const cooldown = retryAfterMs ?? entry.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    entry.cooldownUntil = t + cooldown;
    // Rate-limited attempts DO count toward RPM — the provider saw the
    // request and rejected it. They just don't count toward RPD (since
    // most providers don't bill failed-due-to-rate-limit against the
    // daily quota).
    this.pruneRpm(entry, t);
    entry.recentRequestTimes.push(t);
    this.persist();
  }

  /** Earliest moment any provider becomes available again. */
  earliestAvailable(): number {
    return Math.min(...this.entries.map((e) => e.cooldownUntil));
  }

  snapshot(): ProviderSnapshot[] {
    const t = this.now();
    return this.entries.map((e) => {
      // Prune local RPM window on read so the estimated count reflects the
      // current window even if no calls have happened recently.
      this.pruneRpm(e, t);

      // Ask the provider for its latest header-reported quota. Providers
      // that don't expose this (Gemini SDK) return null and we fall back
      // to local counters.
      const live = (typeof e.provider.getLastQuota === "function")
        ? e.provider.getLastQuota()
        : null;

      const snap: ProviderSnapshot = {
        id: e.provider.id,
        cooldownUntil: e.cooldownUntil,
        cooldownMsRemaining: Math.max(0, e.cooldownUntil - t),
        successCount: e.successCount,
        rateLimitCount: e.rateLimitCount,
        rpmCount: e.recentRequestTimes.length,
        rpmSource: "estimated",
        rpdSource: "estimated",
      };

      // RPM — prefer live header.
      if (live && live.rpmCap !== undefined && live.rpmRemaining !== undefined) {
        snap.rpmCount = Math.max(0, live.rpmCap - live.rpmRemaining);
        snap.rpmCap = live.rpmCap;
        snap.rpmSource = "live";
        snap.liveQuotaFetchedAt = live.fetchedAt;
      } else if (e.estimatedRpmCap !== undefined) {
        snap.rpmCap = e.estimatedRpmCap;
      }

      // RPD — prefer live header. Recover what the provider reports as
      // "remaining of daily limit" if both rpdRemaining + rpdCap exist.
      if (live && live.rpdCap !== undefined && live.rpdRemaining !== undefined) {
        snap.estimatedDailyBudget = live.rpdCap;
        snap.remainingPct = Math.max(
          0,
          Math.min(100, 100 * (live.rpdRemaining / live.rpdCap)),
        );
        snap.rpdSource = "live";
        if (snap.liveQuotaFetchedAt === undefined) snap.liveQuotaFetchedAt = live.fetchedAt;
      } else if (e.estimatedDailyBudget !== undefined && e.estimatedDailyBudget > 0) {
        snap.estimatedDailyBudget = e.estimatedDailyBudget;
        snap.remainingPct = Math.max(
          0,
          Math.min(100, 100 * (1 - e.successCount / e.estimatedDailyBudget)),
        );
      }

      return snap;
    });
  }

  private persist(): void {
    if (!this.stateStore) return;
    const today = utcDay(this.now());
    const out: Record<string, ReturnType<typeof emptyUsage>> = {};
    for (const e of this.entries) {
      out[e.provider.id] = {
        successCount: e.successCount,
        rateLimitCount: e.rateLimitCount,
        cooldownUntil: e.cooldownUntil,
        lastResetUtcDay: today,
      };
    }
    this.stateStore.save(out);
  }
}
