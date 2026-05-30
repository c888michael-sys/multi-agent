/** Gemini 3.x thinking levels. "minimal" effectively disables extended reasoning. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  /**
   * Enable Gemini 3.x extended reasoning. Default (unset) uses the model's
   * default. Higher levels spend more tokens internally and improve quality
   * on hard problems. On free tier, this counts against per-minute token
   * limits faster but is still 1 request per call.
   */
  thinking?: ThinkingLevel;
  /**
   * Enable Google Search grounding. The model decides whether to search and
   * may issue multiple internal queries per call. Source URLs are appended
   * to the returned text under a "Sources:" footer. Use deliberately on
   * questions that need current/factual info — not by default.
   */
  useSearch?: boolean;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  /**
   * Optional provider-specific router timeout. Local models can need much
   * longer cold-load/generation windows than cloud APIs, while cloud calls
   * should keep the router's shorter default guardrail.
   */
  readonly requestTimeoutMs?: number;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  isRateLimitError(err: unknown): boolean;
  retryAfterMs(err: unknown): number | null;
  /**
   * Optional multi-turn tool-call entry point. Providers that don't support
   * function calling can leave this undefined; the ToolRunner will reject.
   */
  completeWithTools?(
    history: import("./tools/types.js").ConversationPart[],
    tools: import("./tools/types.js").ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<import("./tools/types.js").CompleteWithToolsResult>;
  /**
   * Optional multi-turn chat entry point — same as completeWithTools but
   * without function calling. Used by ChatSession for persistent
   * conversations. Falls back to undefined providers being skipped.
   */
  completeChat?(
    history: import("./tools/types.js").ConversationPart[],
    opts?: CompleteOptions,
  ): Promise<string>;
  /**
   * Optional streaming chat entry point. Emits incremental tokens via
   * `onToken` and resolves with the full assembled string at the end.
   * Providers without true streaming should leave undefined; callers
   * fall back to completeChat() + a single onToken at the end.
   */
  completeChatStream?(
    history: import("./tools/types.js").ConversationPart[],
    opts: CompleteOptions | undefined,
    onToken: (text: string) => void,
  ): Promise<string>;
  /**
   * Optional: returns the latest rate-limit info scraped from a provider
   * response (X-RateLimit-* headers). Providers that don't expose this
   * info (e.g., the Gemini SDK) leave this undefined; the pool falls back
   * to its locally-counted RPM/RPD estimate.
   */
  getLastQuota?(): import("./providers/openai-compat.js").LiveQuota | null;
}
