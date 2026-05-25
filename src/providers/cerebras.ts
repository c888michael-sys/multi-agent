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

export interface CerebrasProviderOptions {
  id: string;
  apiKey: string;
  /** Defaults to llama3.1-8b — fast, free, production-stable. */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Cerebras provider — OpenAI-compatible REST API on Cerebras's LPU wafer
 * inference (the speed king: 2000+ tok/sec on small models).
 *
 * Free tier: 1M tokens/day, 30 RPM, account-wide. Production models include
 * llama3.1-8b (default, ideal for bulk repetitive work) and gpt-oss-120b
 * (heavier, slower). Llama 4 Scout, mentioned in some 2026 marketing, is
 * not currently in the standard model list — moved to dedicated endpoints.
 *
 * Provider id convention: `cerebras:<short-model-name>`.
 */
export class CerebrasProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private lastQuota: LiveQuota | null = null;

  constructor(opts: CerebrasProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "llama3.1-8b";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.cerebras.ai/v1";
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  private callOpts(body: Record<string, unknown>) {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      providerName: "Cerebras",
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
    const res = await chatCompletion(this.callOpts(body));
    return extractTextFromCompletion(res);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    const body = buildChatBody(this.model, history, opts);
    const res = await chatCompletion(this.callOpts(body));
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
    const res = await chatCompletion(this.callOpts(body));
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
