import type { Provider } from "./provider.js";

export type PoolMode = "round-robin" | "serial";

interface ProviderState {
  provider: Provider;
  cooldownUntil: number;
  successCount: number;
  rateLimitCount: number;
  /** Caller-supplied estimate of total daily requests this provider can serve, or undefined. */
  estimatedDailyBudget?: number;
}

export interface PickResult {
  provider: Provider;
  index: number;
}

export interface ProviderSnapshot {
  id: string;
  cooldownUntil: number;
  successCount: number;
  rateLimitCount: number;
  estimatedDailyBudget?: number;
  /** Percent of estimated daily budget remaining (0-100), or undefined if no budget set. */
  remainingPct?: number;
}

export interface ProviderConfig {
  provider: Provider;
  estimatedDailyBudget?: number;
}

export interface PoolOptions {
  now?: () => number;
  mode?: PoolMode;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export class ProviderPool {
  private readonly entries: ProviderState[];
  private cursor = 0;
  private mode: PoolMode;
  private readonly now: () => number;

  constructor(providers: Array<Provider | ProviderConfig>, options?: PoolOptions) {
    this.entries = providers.map((p) => {
      const cfg = "provider" in p ? p : { provider: p };
      return {
        provider: cfg.provider,
        cooldownUntil: 0,
        successCount: 0,
        rateLimitCount: 0,
        ...(cfg.estimatedDailyBudget !== undefined && {
          estimatedDailyBudget: cfg.estimatedDailyBudget,
        }),
      };
    });
    this.now = options?.now ?? Date.now;
    this.mode = options?.mode ?? "round-robin";
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
   */
  pickAvailable(): PickResult | null {
    const t = this.now();
    const start = this.mode === "round-robin" ? this.cursor : 0;

    for (let i = 0; i < this.entries.length; i++) {
      const idx = (start + i) % this.entries.length;
      const entry = this.entries[idx]!;
      if (entry.cooldownUntil <= t) {
        if (this.mode === "round-robin") {
          this.cursor = (idx + 1) % this.entries.length;
        }
        return { provider: entry.provider, index: idx };
      }
    }
    return null;
  }

  markSuccess(index: number): void {
    const entry = this.entries[index];
    if (entry) entry.successCount++;
  }

  markRateLimited(index: number, retryAfterMs: number | null): void {
    const entry = this.entries[index];
    if (!entry) return;
    entry.rateLimitCount++;
    const cooldown = retryAfterMs ?? DEFAULT_COOLDOWN_MS;
    entry.cooldownUntil = this.now() + cooldown;
  }

  /** Earliest moment any provider becomes available again. */
  earliestAvailable(): number {
    return Math.min(...this.entries.map((e) => e.cooldownUntil));
  }

  snapshot(): ProviderSnapshot[] {
    return this.entries.map((e) => {
      const snap: ProviderSnapshot = {
        id: e.provider.id,
        cooldownUntil: e.cooldownUntil,
        successCount: e.successCount,
        rateLimitCount: e.rateLimitCount,
      };
      if (e.estimatedDailyBudget !== undefined) {
        snap.estimatedDailyBudget = e.estimatedDailyBudget;
        const used = e.successCount + e.rateLimitCount;
        snap.remainingPct = Math.max(0, Math.min(100, 100 * (1 - used / e.estimatedDailyBudget)));
      }
      return snap;
    });
  }
}
