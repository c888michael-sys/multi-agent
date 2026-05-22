import type { Provider, CompleteOptions } from "./provider.js";
import { ProviderPool, type ProviderConfig, type PoolMode } from "./pool.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError } from "./errors.js";

export interface RouterOptions {
  now?: () => number;
  mode?: PoolMode;
}

export class Router {
  private readonly pool: ProviderPool;

  constructor(providers: Array<Provider | ProviderConfig>, options?: RouterOptions) {
    if (providers.length === 0) throw new NoProvidersConfiguredError();
    this.pool = new ProviderPool(providers, {
      ...(options?.now && { now: options.now }),
      ...(options?.mode && { mode: options.mode }),
    });
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];

    for (let tried = 0; tried < this.pool.size(); tried++) {
      const pick = this.pool.pickAvailable();
      if (!pick) break;

      try {
        const result = await pick.provider.complete(prompt, opts);
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

    throw new AllProvidersExhaustedError(attempts);
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
