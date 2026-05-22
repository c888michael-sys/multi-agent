import type { Provider } from "./provider.js";

interface ProviderState {
  provider: Provider;
  cooldownUntil: number;
}

export interface PickResult {
  provider: Provider;
  index: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export class ProviderPool {
  private readonly entries: ProviderState[];
  private cursor = 0;
  private readonly now: () => number;

  constructor(providers: Provider[], options?: { now?: () => number }) {
    this.entries = providers.map((provider) => ({ provider, cooldownUntil: 0 }));
    this.now = options?.now ?? Date.now;
  }

  size(): number {
    return this.entries.length;
  }

  /** Round-robin next provider that isn't in cooldown. Returns null if all are cooling. */
  pickAvailable(): PickResult | null {
    const t = this.now();
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (this.cursor + i) % this.entries.length;
      const entry = this.entries[idx]!;
      if (entry.cooldownUntil <= t) {
        this.cursor = (idx + 1) % this.entries.length;
        return { provider: entry.provider, index: idx };
      }
    }
    return null;
  }

  markRateLimited(index: number, retryAfterMs: number | null): void {
    const entry = this.entries[index];
    if (!entry) return;
    const cooldown = retryAfterMs ?? DEFAULT_COOLDOWN_MS;
    entry.cooldownUntil = this.now() + cooldown;
  }

  /** Earliest moment any provider becomes available again. */
  earliestAvailable(): number {
    return Math.min(...this.entries.map((e) => e.cooldownUntil));
  }

  snapshot(): { id: string; cooldownUntil: number }[] {
    return this.entries.map((e) => ({ id: e.provider.id, cooldownUntil: e.cooldownUntil }));
  }
}
