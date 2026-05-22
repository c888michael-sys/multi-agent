import { Router } from "./router.js";
import { loadAllProvidersFromEnv } from "./config.js";
import { FileStateStore } from "./state.js";
import type { CompleteOptions } from "./provider.js";

// Core
export { Router } from "./router.js";
export { GeminiProvider } from "./providers/gemini.js";
export { GroqProvider, GroqError } from "./providers/groq.js";
export { OpenRouterProvider } from "./providers/openrouter.js";
export { CerebrasProvider } from "./providers/cerebras.js";
export { MistralProvider } from "./providers/mistral.js";
export { OpenAICompatError } from "./providers/openai-compat.js";
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
export {
  loadGeminiProvidersFromEnv,
  loadGroqProvidersFromEnv,
  loadOpenRouterProvidersFromEnv,
  loadCerebrasProvidersFromEnv,
  loadMistralProvidersFromEnv,
  loadAllProvidersFromEnv,
} from "./config.js";
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
export { BashTool, type BashToolOptions } from "./tools/bash-tool.js";
export { ToolRunner, type ToolRunnerOptions, type ToolRunResult } from "./tools/runner.js";
export type {
  Tool,
  ToolDeclaration,
  ToolCallRequest,
  ToolCallRecord,
  ConversationPart,
  CompleteWithToolsResult,
} from "./tools/types.js";

// Roles (Stage 6)
export {
  RoleResolver,
  UnknownRoleError,
  NoCandidatesAvailableError,
} from "./roles/resolver.js";
export type { RoleName, RoleConfig, ProviderRef, RoleEvent } from "./roles/types.js";
export type { RoleResolverOptions } from "./roles/resolver.js";
export { DEFAULT_ROLES } from "./roles/default-registry.js";

// Agents
export { Agent, type AgentOptions } from "./agents/agent.js";
export {
  Controller,
  type ControllerMode,
  type ControllerOptions,
  type RunTrace,
} from "./agents/controller.js";
export {
  RoleOrchestrator,
  parsePlan,
  type RoleOrchestratorOptions,
  type Plan,
  type RoleRunTrace,
} from "./agents/role-orchestrator.js";
export {
  CONTROLLER_PRIMING,
  buildRoutingPrompt,
  buildSynthesisPrompt,
} from "./agents/prompts.js";

let defaultRouter: Router | null = null;

function getDefaultRouter(): Router {
  if (!defaultRouter) {
    defaultRouter = new Router(loadAllProvidersFromEnv(), {
      stateStore: new FileStateStore(),
    });
  }
  return defaultRouter;
}

/** Convenience wrapper using the env-configured default router. */
export async function complete(prompt: string, opts?: CompleteOptions): Promise<string> {
  return getDefaultRouter().complete(prompt, opts);
}
