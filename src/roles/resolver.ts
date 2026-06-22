import type { Router, CallAttribution } from "../router.js";
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

  /**
   * A registered candidate is eligible only when its provider also reports
   * itself active. Normal providers have no isActive() (treated active); the
   * per-role override slot (`override:<role>`) reports inactive when no override
   * is set, so it's skipped and the role's default chain serves instead.
   */
  private isCandidateActive(providerId: string): boolean {
    const provider = this.router.getProvider(providerId);
    if (!provider || typeof provider.isActive !== "function") return true;
    return provider.isActive();
  }

  private isCandidateUsable(providerId: string): boolean {
    return this.registeredIds.has(providerId) && this.isCandidateActive(providerId);
  }

  /**
   * Snapshot of every role's current candidate chain. Used by the web
   * server's `/api/usage.json` endpoint so the sidebar shows the chain
   * for the currently-active mode (cloud vs local-prepend) rather than
   * always reading from `DEFAULT_ROLES`.
   */
  listRoles(): RoleConfig[] {
    return [...this.roles.values()];
  }

  unsatisfiedRoles(): RoleName[] {
    const out: RoleName[] = [];
    for (const [name, cfg] of this.roles) {
      if (!cfg.candidates.some((c) => this.isCandidateUsable(c.providerId))) {
        out.push(name);
      }
    }
    return out;
  }

  resolveCandidate(name: RoleName): ProviderRef | null {
    const cfg = this.roles.get(name);
    if (!cfg) return null;
    for (const cand of cfg.candidates) {
      if (this.isCandidateUsable(cand.providerId)) return cand;
    }
    return null;
  }

  async runRole(name: RoleName, prompt: string, callerOpts?: CompleteOptions): Promise<string> {
    return this.runWithStrategy(name, callerOpts, (allowList, opts, attribution) =>
      this.router.complete(this.compose(name, prompt), opts, allowList, attribution),
    );
  }

  async runRoleWithTools(
    name: RoleName,
    history: ConversationPart[],
    tools: ToolDeclaration[],
    callerOpts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    return this.runWithStrategy<CompleteWithToolsResult>(
      name,
      callerOpts,
      (allowList, opts, attribution) =>
        this.router.completeWithTools(history, tools, opts, allowList, attribution),
    );
  }

  /** Multi-turn chat through a role. No tools; just back-and-forth history. */
  async runRoleChat(
    name: RoleName,
    history: ConversationPart[],
    callerOpts?: CompleteOptions,
  ): Promise<string> {
    return this.runWithStrategy<string>(name, callerOpts, (allowList, opts, attribution) =>
      this.router.completeChat(history, opts, allowList, attribution),
    );
  }

  /**
   * Chat through a role, but let callers adjust the history per concrete
   * candidate. Used for perception fallback: Gemini primary keeps native
   * grounding, while Gemma/non-native fallbacks can receive pre-fetched
   * Brave/DuckDuckGo search results.
   */
  async runRoleChatWithCandidateHistory(
    name: RoleName,
    history: ConversationPart[],
    transform: (candidate: ProviderRef, history: ConversationPart[]) => Promise<ConversationPart[]> | ConversationPart[],
    callerOpts?: CompleteOptions,
  ): Promise<string> {
    return this.runWithStrategy<string>(name, callerOpts, async (allowList, opts, attribution, candidate) =>
      this.router.completeChat(await transform(candidate, history), opts, allowList, attribution),
    );
  }

  /**
   * Streaming variant — same fallback logic as runRoleChat, but emits
   * incremental tokens via onToken. Falls back to non-streaming
   * completeChat + one final onToken when the chosen provider does
   * not implement completeChatStream.
   */
  async runRoleChatStream(
    name: RoleName,
    history: ConversationPart[],
    onToken: (text: string) => void,
    callerOpts?: CompleteOptions,
  ): Promise<string> {
    return this.runWithStrategy<string>(name, callerOpts, (allowList, opts, attribution) =>
      this.router.completeChatStream(history, opts, allowList, attribution, onToken),
    );
  }

  async runRoleChatStreamWithCandidateHistory(
    name: RoleName,
    history: ConversationPart[],
    transform: (candidate: ProviderRef, history: ConversationPart[]) => Promise<ConversationPart[]> | ConversationPart[],
    onToken: (text: string) => void,
    callerOpts?: CompleteOptions,
  ): Promise<string> {
    return this.runWithStrategy<string>(name, callerOpts, async (allowList, opts, attribution, candidate) =>
      this.router.completeChatStream(
        await transform(candidate, history),
        opts,
        allowList,
        attribution,
        onToken,
      ),
    );
  }

  /** Roster summary used by the orchestrator when deciding routing. */
  rosterDescription(): string {
    const lines: string[] = [];
    for (const [name, cfg] of this.roles) {
      // `vision` is an internal, auto-forced multimodal role (image turns) —
      // never offer it to the orchestrator planner for text routing.
      if (name === "vision") continue;
      const eligible = cfg.candidates.filter((c) => this.isCandidateUsable(c.providerId));
      const status = eligible.length === 0 ? "[UNAVAILABLE]" : `(${eligible[0]!.providerId})`;
      lines.push(`- ${name} ${status}: ${cfg.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Shared retry-across-candidates wrapper used by both text and tool-use paths.
   * The `attempt` callback is parameterized over allowList, merged opts, and an
   * attribution out-param so the resolver can learn which provider actually
   * served the call (used by the cross-role-substitution event).
   *
   * Failed attempts are aggregated across all candidates. If everything
   * exhausts, the thrown AllProvidersExhaustedError contains the union of
   * per-candidate attempts — not just the last one's.
   */
  private async runWithStrategy<T>(
    name: RoleName,
    callerOpts: CompleteOptions | undefined,
    attempt: (
      allowList: ReadonlySet<string>,
      opts: CompleteOptions,
      attribution: CallAttribution,
      candidate: ProviderRef,
    ) => Promise<T>,
  ): Promise<T> {
    const cfg = this.requireRole(name);
    const eligible = this.eligibleCandidates(name, cfg);
    const primaryId = eligible[0]!.providerId;
    const aggregateAttempts: { providerId: string; error: unknown }[] = [];

    for (let i = 0; i < eligible.length; i++) {
      const candidate = eligible[i]!;
      const allowList = new Set([candidate.providerId]);
      const mergedOpts: CompleteOptions = { ...candidate.mode, ...callerOpts };
      const attribution: CallAttribution = {};
      try {
        const result = await attempt(allowList, mergedOpts, attribution, candidate);
        if (i > 0) {
          this.onEvent({
            type: "fallback-within-role",
            role: name,
            primaryProviderId: primaryId,
            usedProviderId: attribution.providerId ?? candidate.providerId,
          });
        }
        return result;
      } catch (err) {
        if (err instanceof AllProvidersExhaustedError) {
          aggregateAttempts.push(...err.attempts);
          continue;
        }
        throw err;
      }
    }

    // Role's own candidates exhausted. Try cross-role substitution if enabled.
    if (this.crossRoleFailover) {
      const roleIds = new Set(eligible.map((c) => c.providerId));
      const foreignIds = [...this.registeredIds].filter(
        (id) => !roleIds.has(id) && this.isCandidateActive(id),
      );
      if (foreignIds.length > 0) {
        const subOpts: CompleteOptions = { ...eligible[0]!.mode, ...callerOpts };
        const attribution: CallAttribution = {};
        try {
          const result = await attempt(
            new Set(foreignIds),
            subOpts,
            attribution,
            eligible[0]!,
          );
          this.onEvent({
            type: "cross-role-substitution",
            role: name,
            primaryProviderId: primaryId,
            usedProviderId: attribution.providerId ?? foreignIds.join("|"),
          });
          return result;
        } catch (err) {
          if (err instanceof AllProvidersExhaustedError) {
            aggregateAttempts.push(...err.attempts);
          } else {
            throw err;
          }
        }
      }
    }

    this.onEvent({ type: "role-exhausted", role: name, primaryProviderId: primaryId });
    throw new AllProvidersExhaustedError(
      aggregateAttempts.length > 0
        ? aggregateAttempts
        : eligible.map((c) => ({ providerId: c.providerId, error: new Error("unreached") })),
    );
  }

  private compose(name: RoleName, prompt: string): string {
    const cfg = this.roles.get(name);
    if (!cfg || !cfg.systemPromptTemplate) return prompt;
    return `${cfg.systemPromptTemplate}\n\n---\n\n${prompt}`;
  }

  private eligibleCandidates(name: RoleName, cfg: RoleConfig): ProviderRef[] {
    const eligible = cfg.candidates.filter((c) => this.isCandidateUsable(c.providerId));
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
