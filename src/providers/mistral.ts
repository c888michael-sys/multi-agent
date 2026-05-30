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

export interface MistralProviderOptions {
  id: string;
  apiKey: string;
  /** Defaults to codestral-latest — code-specialized variant. */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Mistral provider — OpenAI-compatible REST API at api.mistral.ai/v1.
 *
 * Free tier: "Experiment" plan, ~1B tokens/month account-wide, requires
 * phone verification at signup. Codestral is the code-specialized variant
 * (filling our action-code role); Mistral also offers Large, Small, and
 * other general-purpose models if needed later.
 *
 * Provider id convention: `mistral:<short-model-name>`.
 */
export class MistralProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private lastQuota: LiveQuota | null = null;

  constructor(opts: MistralProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "codestral-latest";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.mistral.ai/v1";
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  private callOpts(body: Record<string, unknown>, signal?: AbortSignal) {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      signal,
      providerName: "Mistral",
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
