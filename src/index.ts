import { Router } from "./router.js";
import { loadGeminiProvidersFromEnv } from "./config.js";
import { FileStateStore } from "./state.js";
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
export type { Provider, CompleteOptions, ThinkingLevel } from "./provider.js";
export {
  RouterError,
  AllProvidersExhaustedError,
  NoProvidersConfiguredError,
} from "./errors.js";
export { loadGeminiProvidersFromEnv } from "./config.js";
export {
  FileStateStore,
  InMemoryStateStore,
  type StateStore,
  type ProviderUsage,
  utcDay,
} from "./state.js";

// Conservation
export {
  ConservationPolicy,
  formatUsageReport,
  type ConservationConfig,
  type ConservationStatus,
} from "./conservation.js";

// Tools
export { FileTools } from "./tools/file-tools.js";
export { ToolRunner, type ToolRunnerOptions, type ToolRunResult } from "./tools/runner.js";
export type {
  Tool,
  ToolDeclaration,
  ToolCallRequest,
  ToolCallRecord,
  ConversationPart,
  CompleteWithToolsResult,
} from "./tools/types.js";

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
    defaultRouter = new Router(loadGeminiProvidersFromEnv(), {
      stateStore: new FileStateStore(),
    });
  }
  return defaultRouter;
}

/** Convenience wrapper using the env-configured default router. */
export async function complete(prompt: string, opts?: CompleteOptions): Promise<string> {
  return getDefaultRouter().complete(prompt, opts);
}
