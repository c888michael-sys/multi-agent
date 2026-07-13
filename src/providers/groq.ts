import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
} from "../tools/types.js";
import {
  chatCompletion,
  chatCompletionStream,
  historyToOpenAIMessages,
  parseOpenAIToolResponse,
  extractTextFromCompletion,
  buildOpenAIToolsArray,
  toolChoiceValue,
  buildChatBody,
  looksLikeRateLimit,
  retryAfterMsFromHeaders,
  parseLiveQuotaFromHeaders,
  type LiveQuota,
} from "./openai-compat.js";

export interface GroqProviderOptions {
  id: string;
  apiKey: string;
  /** Defaults to llama-3.3-70b-versatile. */
  model?: string;
  /** Override for tests. */
  baseUrl?: string;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Groq provider — OpenAI-compatible REST API. Uses Node 18+'s built-in fetch.
 *
 * Rate limits are account-wide on the free tier (30 RPM / 6K TPM / 1000 RPD
 * across ALL models on this key). Putting multiple Groq models in the pool
 * doesn't give independent quotas — one strong Groq model per account.
 */
export class GroqProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private lastQuota: LiveQuota | null = null;

  constructor(opts: GroqProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "llama-3.3-70b-versatile";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.groq.com/openai/v1";
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  private callOpts(body: Record<string, unknown>, signal?: AbortSignal) {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      signal,
      providerName: "Groq",
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

  async completeChatStream(history: ConversationPart[], opts: CompleteOptions | undefined, onToken: (text: string) => void): Promise<string> {
    return chatCompletionStream(this.callOpts(buildChatBody(this.model, history, opts), opts?.signal), onToken);
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
    const tc = toolChoiceValue(opts?.toolChoice, "openai");
    if (tc) body.tool_choice = tc;
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

// Re-exports for back-compat (groq.test.ts imports these from this file).
export {
  OpenAICompatError as GroqError,
  historyToOpenAIMessages,
  parseOpenAIToolResponse,
} from "./openai-compat.js";
