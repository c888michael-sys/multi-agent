import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../tools/types.js";
import type { LiveQuota } from "./openai-compat.js";
import type { CustomisableRole, RoleModelSelection } from "../models/reasoning-model-overrides.js";

export interface RoleOverrideProviderOptions {
  role: CustomisableRole;
  /** Reads the current saved selection for this role (live, on every call). */
  readSelection: () => RoleModelSelection | null;
  /**
   * Builds the concrete delegate provider for a selection, or returns null when
   * the chosen provider's API key / daemon isn't configured. Delegates are
   * cached by `${provider}:${model}`, so this is called once per distinct combo.
   */
  buildDelegate: (selection: RoleModelSelection) => Provider | null;
}

/**
 * A per-role "override slot" provider. Registered once per customisable role
 * under id `override:<role>` and prepended to that role's candidate chain.
 *
 * On every call it reads the role's saved {provider, model} selection, lazily
 * builds + caches the matching underlying provider, and delegates to it. This
 * makes both provider AND model switches apply live without rebuilding the
 * pool. When no override is set (or the chosen provider has no key) it reports
 * `isActive() === false`, and the RoleResolver skips it so the role's default
 * chain serves instead.
 *
 * Quota/rate-limit signals are forwarded from the most-recently-used delegate
 * so the sidebar gauge reflects whatever provider the slot is currently
 * pointing at.
 */
export class RoleOverrideProvider implements Provider {
  readonly id: string;
  private readonly opts: RoleOverrideProviderOptions;
  private readonly cache = new Map<string, Provider>();
  private lastDelegate: Provider | null = null;

  constructor(opts: RoleOverrideProviderOptions) {
    this.opts = opts;
    this.id = `override:${opts.role}`;
  }

  /** Current delegate for the saved selection, or null when none/unconfigured. */
  private delegate(): Provider | null {
    const sel = this.opts.readSelection();
    if (!sel) return null;
    const key = `${sel.provider}:${sel.model}`;
    let delegate = this.cache.get(key);
    if (!delegate) {
      const built = this.opts.buildDelegate(sel);
      if (!built) return null;
      this.cache.set(key, built);
      delegate = built;
    }
    this.lastDelegate = delegate;
    return delegate;
  }

  private requireDelegate(): Provider {
    const delegate = this.delegate();
    if (!delegate) {
      throw new Error(
        `Role override '${this.id}' has no usable selection (no override set or the chosen provider's key is missing).`,
      );
    }
    return delegate;
  }

  isActive(): boolean {
    return this.delegate() !== null;
  }

  get model(): string {
    const sel = this.opts.readSelection();
    return sel ? `${sel.provider} · ${sel.model}` : "(no override)";
  }

  get requestTimeoutMs(): number | undefined {
    return this.delegate()?.requestTimeoutMs;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    return this.requireDelegate().complete(prompt, opts);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    const delegate = this.requireDelegate();
    if (delegate.completeChat) return delegate.completeChat(history, opts);
    // Last resort: single-shot the latest user turn through complete().
    const lastUser = [...history].reverse().find((p) => p.kind === "user_text");
    return delegate.complete(lastUser && lastUser.kind === "user_text" ? lastUser.text : "", opts);
  }

  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const delegate = this.requireDelegate();
    if (delegate.completeWithTools) return delegate.completeWithTools(history, tools, opts);
    // Delegate can't call tools — degrade to plain chat text (no tool calls).
    const text = await this.completeChat(history, opts);
    return { kind: "text", text };
  }

  async completeChatStream(
    history: ConversationPart[],
    opts: CompleteOptions | undefined,
    onToken: (text: string) => void,
  ): Promise<string> {
    const delegate = this.requireDelegate();
    if (delegate.completeChatStream) return delegate.completeChatStream(history, opts, onToken);
    // Delegate has no streaming — emit the full reply as one final token.
    const text = await this.completeChat(history, opts);
    if (text) onToken(text);
    return text;
  }

  isRateLimitError(err: unknown): boolean {
    return this.lastDelegate?.isRateLimitError(err) ?? false;
  }

  retryAfterMs(err: unknown): number | null {
    return this.lastDelegate?.retryAfterMs(err) ?? null;
  }

  getLastQuota(): LiveQuota | null {
    return this.lastDelegate?.getLastQuota?.() ?? null;
  }
}
