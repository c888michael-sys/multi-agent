import type { Provider, CompleteOptions } from "./provider.js";
import { ProviderPool } from "./pool.js";
import { AllProvidersExhaustedError, NoProvidersConfiguredError } from "./errors.js";

export interface RouterOptions {
  now?: () => number;
}

export class Router {
  private readonly pool: ProviderPool;

  constructor(providers: Provider[], options?: RouterOptions) {
    if (providers.length === 0) throw new NoProvidersConfiguredError();
    this.pool = new ProviderPool(providers, { now: options?.now });
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const attempts: { providerId: string; error: unknown }[] = [];

    for (let tried = 0; tried < this.pool.size(); tried++) {
      const pick = this.pool.pickAvailable();
      if (!pick) break;

      try {
        return await pick.provider.complete(prompt, opts);
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

  snapshot() {
    return this.pool.snapshot();
  }
}
