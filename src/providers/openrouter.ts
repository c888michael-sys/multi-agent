import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../tools/types.js";
import {
  chatCompletion,
  historyToOpenAIMessages,
  parseOpenAIToolResponse,
  extractTextFromCompletion,
  buildOpenAIToolsArray,
  looksLikeRateLimit,
  retryAfterMsFromHeaders,
} from "./openai-compat.js";

export interface OpenRouterProviderOptions {
  id: string;
  apiKey: string;
  /**
   * Model ID. For free-tier models, MUST end with `:free` or you'll be billed
   * (and refused, if no credits). Defaults to deepseek/deepseek-v4-flash:free
   * (the strongest free reasoning model on OpenRouter as of May 2026 — 284B
   * MoE / 13B active, 1M context, native reasoning).
   */
  model?: string;
  /** Optional attribution headers — OpenRouter uses these for analytics; not required. */
  appName?: string;
  appUrl?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * OpenRouter provider — routes to many backend models via OpenAI-compatible
 * REST. Free-tier free models share a daily budget (~50/day total across all
 * `:free` models on an account, or ~1000/day after a $10 lifetime top-up).
 * So OpenRouter is best used for one rare-but-important role (e.g., reasoning
 * with DeepSeek R1), not for high-volume work.
 *
 * Provider id convention: `openrouter:<short-model-name>`.
 */
export class OpenRouterProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OpenRouterProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "deepseek/deepseek-v4-flash:free";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.extraHeaders = {};
    if (opts.appUrl) this.extraHeaders["HTTP-Referer"] = opts.appUrl;
    if (opts.appName) this.extraHeaders["X-Title"] = opts.appName;
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const res = await chatCompletion({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      providerName: "OpenRouter",
      extraHeaders: this.extraHeaders,
      ...(this.fetchImpl && { fetchImpl: this.fetchImpl }),
    });
    return extractTextFromCompletion(res);
  }

  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: historyToOpenAIMessages(history),
      tools: buildOpenAIToolsArray(tools),
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const res = await chatCompletion({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      providerName: "OpenRouter",
      extraHeaders: this.extraHeaders,
      ...(this.fetchImpl && { fetchImpl: this.fetchImpl }),
    });
    return parseOpenAIToolResponse(res);
  }

  isRateLimitError(err: unknown): boolean {
    return looksLikeRateLimit(err);
  }

  retryAfterMs(err: unknown): number | null {
    return retryAfterMsFromHeaders(err);
  }
}
