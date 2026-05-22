import type { Router } from "../router.js";
import type { CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../tools/types.js";
import type { RoleName, RoleConfig, ProviderRef } from "./types.js";

export class UnknownRoleError extends Error {
  constructor(name: RoleName) {
    super(`No RoleConfig registered for role: ${name}`);
    this.name = "UnknownRoleError";
  }
}

export class NoCandidatesAvailableError extends Error {
  readonly role: RoleName;
  constructor(role: RoleName, requestedIds: string[], registeredIds: string[]) {
    super(
      `Role '${role}' has no candidate providers registered with the router. ` +
        `Wanted any of: [${requestedIds.join(", ")}]. ` +
        `Registered: [${registeredIds.join(", ")}].`,
    );
    this.name = "NoCandidatesAvailableError";
    this.role = role;
  }
}

/**
 * Resolves abstract roles ("perception", "reasoning", etc.) to concrete
 * Provider calls. Each role declares an ordered list of candidate providers;
 * the resolver routes calls through the router constrained to those candidates,
 * letting the router's existing rotation/cooldown/backoff logic do the rest.
 *
 * Roles whose entire candidate list is missing from the router (e.g., user
 * hasn't configured a Groq key) raise NoCandidatesAvailableError eagerly when
 * called — surfaces misconfiguration immediately rather than at first use.
 */
export class RoleResolver {
  private readonly router: Router;
  private readonly roles: Map<RoleName, RoleConfig>;
  private readonly registeredIds: Set<string>;

  constructor(router: Router, roles: RoleConfig[]) {
    this.router = router;
    this.roles = new Map(roles.map((r) => [r.name, r]));
    this.registeredIds = new Set(router.registeredProviderIds());
  }

  hasRole(name: RoleName): boolean {
    return this.roles.has(name);
  }

  /** Roles whose entire candidate list is missing from the router. */
  unsatisfiedRoles(): RoleName[] {
    const out: RoleName[] = [];
    for (const [name, cfg] of this.roles) {
      if (!cfg.candidates.some((c) => this.registeredIds.has(c.providerId))) {
        out.push(name);
      }
    }
    return out;
  }

  /** Return the first candidate whose provider is registered, in priority order. */
  resolveCandidate(name: RoleName): ProviderRef | null {
    const cfg = this.roles.get(name);
    if (!cfg) return null;
    for (const cand of cfg.candidates) {
      if (this.registeredIds.has(cand.providerId)) return cand;
    }
    return null;
  }

  /** Run a text completion through whichever candidate provider fills this role. */
  async runRole(name: RoleName, prompt: string, callerOpts?: CompleteOptions): Promise<string> {
    const cfg = this.requireRole(name);
    const eligible = cfg.candidates.filter((c) => this.registeredIds.has(c.providerId));
    if (eligible.length === 0) {
      throw new NoCandidatesAvailableError(
        name,
        cfg.candidates.map((c) => c.providerId),
        [...this.registeredIds],
      );
    }

    const allowList = new Set(eligible.map((c) => c.providerId));
    // The primary candidate's mode is applied; caller opts override. If failover
    // happens to a different candidate, its mode would only matter if it
    // differed materially — by convention all candidates for one role share
    // the relevant modes, so primary's mode is "the" role mode.
    const mergedOpts: CompleteOptions = { ...eligible[0]!.mode, ...callerOpts };
    const composed = cfg.systemPromptTemplate
      ? `${cfg.systemPromptTemplate}\n\n---\n\n${prompt}`
      : prompt;
    return this.router.complete(composed, mergedOpts, allowList);
  }

  /** Tool-use variant. Same role-to-provider resolution. */
  async runRoleWithTools(
    name: RoleName,
    history: ConversationPart[],
    tools: ToolDeclaration[],
    callerOpts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const cfg = this.requireRole(name);
    const eligible = cfg.candidates.filter((c) => this.registeredIds.has(c.providerId));
    if (eligible.length === 0) {
      throw new NoCandidatesAvailableError(
        name,
        cfg.candidates.map((c) => c.providerId),
        [...this.registeredIds],
      );
    }
    const allowList = new Set(eligible.map((c) => c.providerId));
    const mergedOpts: CompleteOptions = { ...eligible[0]!.mode, ...callerOpts };
    return this.router.completeWithTools(history, tools, mergedOpts, allowList);
  }

  /** Human-readable summary used by the orchestrator when deciding routing. */
  rosterDescription(): string {
    const lines: string[] = [];
    for (const [name, cfg] of this.roles) {
      const eligible = cfg.candidates.filter((c) => this.registeredIds.has(c.providerId));
      const status = eligible.length === 0 ? "[UNAVAILABLE]" : `(${eligible[0]!.providerId})`;
      lines.push(`- ${name} ${status}: ${cfg.description}`);
    }
    return lines.join("\n");
  }

  private requireRole(name: RoleName): RoleConfig {
    const cfg = this.roles.get(name);
    if (!cfg) throw new UnknownRoleError(name);
    return cfg;
  }
}
