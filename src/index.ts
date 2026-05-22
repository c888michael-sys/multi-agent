import { Router } from "./router.js";
import { loadGeminiProvidersFromEnv } from "./config.js";
import type { CompleteOptions } from "./provider.js";

export { Router } from "./router.js";
export { GeminiProvider } from "./providers/gemini.js";
export { ProviderPool } from "./pool.js";
export type { Provider, CompleteOptions } from "./provider.js";
export {
  RouterError,
  AllProvidersExhaustedError,
  NoProvidersConfiguredError,
} from "./errors.js";
export { loadGeminiProvidersFromEnv } from "./config.js";

let defaultRouter: Router | null = null;

function getDefaultRouter(): Router {
  if (!defaultRouter) {
    defaultRouter = new Router(loadGeminiProvidersFromEnv());
  }
  return defaultRouter;
}

/** Convenience wrapper using the env-configured default router. */
export async function complete(prompt: string, opts?: CompleteOptions): Promise<string> {
  return getDefaultRouter().complete(prompt, opts);
}
