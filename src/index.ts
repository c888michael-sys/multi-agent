import { Router } from "./router.js";
import { loadGeminiProvidersFromEnv } from "./config.js";
import type { CompleteOptions } from "./provider.js";

// Core
export { Router } from "./router.js";
export { GeminiProvider } from "./providers/gemini.js";
export {
  ProviderPool,
  type PoolMode,
  type ProviderConfig,
  type ProviderSnapshot,
} from "./pool.js";
export type { Provider, CompleteOptions } from "./provider.js";
export {
  RouterError,
  AllProvidersExhaustedError,
  NoProvidersConfiguredError,
} from "./errors.js";
export { loadGeminiProvidersFromEnv } from "./config.js";

// Conservation
export {
  ConservationPolicy,
  formatUsageReport,
  type ConservationConfig,
  type ConservationStatus,
} from "./conservation.js";

// Agents
export { Agent, type AgentOptions } from "./agents/agent.js";
export {
  Controller,
  type ControllerMode,
  type ControllerOptions,
  type RunTrace,
} from "./agents/controller.js";
export {
  CONTROLLER_PRIMING,
  buildRoutingPrompt,
  buildSynthesisPrompt,
} from "./agents/prompts.js";

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
