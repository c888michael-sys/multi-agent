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
  buildChatBody,
  looksLikeRateLimit,
  retryAfterMsFromHeaders,
  parseLiveQuotaFromHeaders,
  type LiveQuota,
} from "./openai-compat.js";

export interface OpenRouterProviderOptions {
  id: string;
  apiKey: string;
  /**
   * Model ID. For free-tier variants of paid models, append `:free` (e.g.
   * `somemodel:free`). The default `qwen/qwen3.6-plus-preview` is an
   * inherently free preview model — no `:free` suffix needed. Override for
   * any other OpenRouter slug.
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
 * REST. Default model is Qwen 3.6 Plus Preview, a free preview model used
 * as the primary online reasoner. Append `:free` to the model slug only for
 * free variants of paid models — inherently free previews don't need it.
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
  /** Most recent rate-limit info scraped from response headers. */
  private lastQuota: LiveQuota | null = null;

  constructor(opts: OpenRouterProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "qwen/qwen3.6-plus-preview";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.extraHeaders = {};
    if (opts.appUrl) this.extraHeaders["HTTP-Referer"] = opts.appUrl;
    if (opts.appName) this.extraHeaders["X-Title"] = opts.appName;
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  /** Builds the chatCompletion args + onHeaders callback once. */
  private callOpts(body: Record<string, unknown>, signal?: AbortSignal) {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      signal,
      providerName: "OpenRouter",
      extraHeaders: this.extraHeaders,
      onHeaders: (headers: Record<string, string>) => {
        this.lastQuota = parseLiveQuotaFromHeaders(headers, Date.now());
      },
      ...(this.fetchImpl && { fetchImpl: this.fetchImpl }),
    };
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    const res = await chatCompletion(this.callOpts(body, opts?.signal));
    return extractTextFromCompletion(res);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    const body = buildChatBody(this.model, history, opts);
    const res = await chatCompletion(this.callOpts(body, opts?.signal));
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
    const res = await chatCompletion(this.callOpts(body, opts?.signal));
    return parseOpenAIToolResponse(res);
  }

  isRateLimitError(err: unknown): boolean {
    return looksLikeRateLimit(err);
  }

  retryAfterMs(err: unknown): number | null {
    return retryAfterMsFromHeaders(err);
  }

  getLastQuota(): LiveQuota | null {
    return this.lastQuota;
  }
}
