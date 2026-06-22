import type { CompleteOptions } from "../provider.js";

/**
 * The 4 functional roles in the agent system. Roles are *capability requirements*;
 * each role can be filled by any model that meets the requirement. Action
 * subdivides because different action models specialize differently (code vs
 * structured output vs bulk repetitive work).
 */
export type RoleName =
  | "perception" // data collection (web browsing, document reading)
  | "reasoning" // plan-of-attack, hard decisions
  | "orchestration" // decide which role(s) to invoke; synthesize
  | "action-code" // code-specialized execution
  | "action-structural" // general execution; structured outputs; formatting
  | "action-repetitive" // bulk, high-volume tasks
  | "mindmap-categorize" // turn a chat reply into structured JSON for the mindmap burst
  | "vision"; // answer about pasted/attached images — internal, multimodal (Gemini), auto-forced

/** Points at a specific provider in the Router's pool, plus any per-call mode flags. */
export interface ProviderRef {
  /** Must match a Provider.id registered in the Router's pool. */
  providerId: string;
  /** Mode flags (thinking level, useSearch, etc.) applied on every call through this ref. */
  mode?: CompleteOptions;
}

export interface RoleConfig {
  name: RoleName;
  /** One-line description shown to the orchestrator when deciding routing. */
  description: string;
  /**
   * Providers eligible to fill this role, in priority order. The resolver
   * picks the first one whose provider is registered AND not currently cooling.
   * Cross-provider failover happens automatically.
   */
  candidates: ProviderRef[];
  /**
   * Optional system-prompt prefix prepended to every call through this role.
   * Common use: role-specific persona (e.g., "You are the architect agent...").
   */
  systemPromptTemplate?: string;
}

/** Surfaced via RoleResolver's onEvent callback whenever a role's call deviates from happy path. */
export type RoleEvent =
  | {
      type: "fallback-within-role";
      role: RoleName;
      primaryProviderId: string;
      usedProviderId: string;
    }
  | {
      type: "cross-role-substitution";
      role: RoleName;
      primaryProviderId: string;
      usedProviderId: string;
    }
  | { type: "role-exhausted"; role: RoleName; primaryProviderId: string };
