import type { Router } from "../router.js";
import type { CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../tools/types.js";
import { AllProvidersExhaustedError } from "../errors.js";
import type { RoleName, RoleConfig, ProviderRef, RoleEvent } from "./types.js";

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

export interface RoleResolverOptions {
  /**
   * When ALL of a role's own candidates are exhausted, may the resolver borrow
   * any healthy provider in the pool (even ones that don't belong to this
   * role's candidate list) as a last-resort substitute? Default true.
   * Role-specific modes (useSearch, thinking, etc.) are passed through —
   * substitutes that don't understand them just ignore them, which may mean
   * degraded capability (e.g., no live web data for perception).
   */
  crossRoleFailover?: boolean;
  /**
   * Called for every non-happy-path event during role resolution:
   *   - "fallback-within-role": primary cooling, used a backup candidate from the role's list
   *   - "cross-role-substitution": role exhausted entirely; borrowed a foreign provider
   *   - "role-exhausted": no provider could serve the role; about to throw
   * Wire to console.error from the CLI for visibility; collect for assertions in tests.
   */
  onEvent?: (event: RoleEvent) => void;
}

/**
 * Resolves abstract roles to concrete Provider calls. Each role declares an
 * ordered list of candidate providers; the resolver routes through the router
 * constrained to those candidates, falling back through the list when the
 * primary is exhausted, and optionally borrowing a foreign provider as a
 * last resort.
 *
 * Roles whose entire candidate list is missing from the router raise
 * NoCandidatesAvailableError eagerly when called.
 */
export class RoleResolver {
  private readonly router: Router;
  private readonly roles: Map<RoleName, RoleConfig>;
  private readonly registeredIds: Set<string>;
  private readonly crossRoleFailover: boolean;
  private readonly onEvent: (event: RoleEvent) => void;

  constructor(router: Router, roles: RoleConfig[], options?: RoleResolverOptions) {
    this.router = router;
    this.roles = new Map(roles.map((r) => [r.name, r]));
    this.registeredIds = new Set(router.registeredProviderIds());
    this.crossRoleFailover = options?.crossRoleFailover ?? true;
    this.onEvent = options?.onEvent ?? (() => {});
  }

  hasRole(name: RoleName): boolean {
    return this.roles.has(name);
  }

  unsatisfiedRoles(): RoleName[] {
    const out: RoleName[] = [];
    for (const [name, cfg] of this.roles) {
      if (!cfg.candidates.some((c) => this.registeredIds.has(c.providerId))) {
        out.push(name);
      }
    }
    return out;
  }

  resolveCandidate(name: RoleName): ProviderRef | null {
    const cfg = this.roles.get(name);
    if (!cfg) return null;
    for (const cand of cfg.candidates) {
      if (this.registeredIds.has(cand.providerId)) return cand;
    }
    return null;
  }

  async runRole(name: RoleName, prompt: string, callerOpts?: CompleteOptions): Promise<string> {
    return this.runWithStrategy(name, callerOpts, (allowList, opts) =>
      this.router.complete(this.compose(name, prompt), opts, allowList),
    );
  }

  async runRoleWithTools(
    name: RoleName,
    history: ConversationPart[],
    tools: ToolDeclaration[],
    callerOpts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    return this.runWithStrategy<CompleteWithToolsResult>(name, callerOpts, (allowList, opts) =>
      this.router.completeWithTools(history, tools, opts, allowList),
    );
  }

  /** Roster summary used by the orchestrator when deciding routing. */
  rosterDescription(): string {
    const lines: string[] = [];
    for (const [name, cfg] of this.roles) {
      const eligible = cfg.candidates.filter((c) => this.registeredIds.has(c.providerId));
      const status = eligible.length === 0 ? "[UNAVAILABLE]" : `(${eligible[0]!.providerId})`;
      lines.push(`- ${name} ${status}: ${cfg.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Shared retry-across-candidates wrapper used by both text and tool-use paths.
   * The `attempt` callback is parameterized over allowList + merged opts so it
   * can call whichever Router method the caller needs (complete vs completeWithTools).
   */
  private async runWithStrategy<T>(
    name: RoleName,
    callerOpts: CompleteOptions | undefined,
    attempt: (allowList: ReadonlySet<string>, opts: CompleteOptions) => Promise<T>,
  ): Promise<T> {
    const cfg = this.requireRole(name);
    const eligible = this.eligibleCandidates(name, cfg);
    const primaryId = eligible[0]!.providerId;

    let lastErr: unknown;
    for (let i = 0; i < eligible.length; i++) {
      const candidate = eligible[i]!;
      const allowList = new Set([candidate.providerId]);
      const mergedOpts: CompleteOptions = { ...candidate.mode, ...callerOpts };
      try {
        const result = await attempt(allowList, mergedOpts);
        // Fallback within the role's own list — emit warning if we used a non-primary.
        if (i > 0) {
          this.onEvent({
            type: "fallback-within-role",
            role: name,
            primaryProviderId: primaryId,
            usedProviderId: candidate.providerId,
          });
        }
        return result;
      } catch (err) {
        if (err instanceof AllProvidersExhaustedError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    // Role's own candidates exhausted. Try cross-role substitution if enabled.
    if (this.crossRoleFailover) {
      const roleIds = new Set(eligible.map((c) => c.providerId));
      const foreignIds = [...this.registeredIds].filter((id) => !roleIds.has(id));
      if (foreignIds.length > 0) {
        try {
          // Substitute uses the primary candidate's mode (best guess about role's intent).
          const subOpts: CompleteOptions = { ...eligible[0]!.mode, ...callerOpts };
          const result = await attempt(new Set(foreignIds), subOpts);
          // Determine which foreign provider actually ran the call by snapshotting
          // counts before and after. Simple heuristic: any provider whose success
          // count is greater than its prior won. We don't track that here; just
          // emit the substitution event with "<one of the foreigns>" as a marker.
          this.onEvent({
            type: "cross-role-substitution",
            role: name,
            primaryProviderId: primaryId,
            usedProviderId: foreignIds.join("|"),
          });
          return result;
        } catch (err) {
          if (err instanceof AllProvidersExhaustedError) {
            lastErr = err;
          } else {
            throw err;
          }
        }
      }
    }

    this.onEvent({ type: "role-exhausted", role: name, primaryProviderId: primaryId });
    throw (
      lastErr ??
      new AllProvidersExhaustedError(
        eligible.map((c) => ({ providerId: c.providerId, error: new Error("unreached") })),
      )
    );
  }

  private compose(name: RoleName, prompt: string): string {
    const cfg = this.roles.get(name);
    if (!cfg || !cfg.systemPromptTemplate) return prompt;
    return `${cfg.systemPromptTemplate}\n\n---\n\n${prompt}`;
  }

  private eligibleCandidates(name: RoleName, cfg: RoleConfig): ProviderRef[] {
    const eligible = cfg.candidates.filter((c) => this.registeredIds.has(c.providerId));
    if (eligible.length === 0) {
      throw new NoCandidatesAvailableError(
        name,
        cfg.candidates.map((c) => c.providerId),
        [...this.registeredIds],
      );
    }
    return eligible;
  }

  private requireRole(name: RoleName): RoleConfig {
    const cfg = this.roles.get(name);
    if (!cfg) throw new UnknownRoleError(name);
    return cfg;
  }
}
