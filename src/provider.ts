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
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  isRateLimitError(err: unknown): boolean;
  retryAfterMs(err: unknown): number | null;
}
