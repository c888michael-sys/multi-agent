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

export interface NvidiaProviderOptions {
  id: string;
  apiKey: string;
  /** Defaults to meta/llama-3.3-70b-instruct. */
  model?: string;
  /** Override for tests. */
  baseUrl?: string;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * NVIDIA provider — OpenAI-compatible REST API at integrate.api.nvidia.com/v1
 * (NVIDIA "build" / NIM hosted endpoints). Generous free tier for personal
 * use; auth via an `nvapi-...` key in `NVIDIA_KEY`.
 *
 * NVIDIA hosts a broad catalog (meta/llama, nvidia/nemotron, qwen coders,
 * deepseek, mistral, etc.) behind one OpenAI-compatible surface, so this is a
 * thin wrapper over the shared openai-compat helpers, identical in shape to
 * the Groq/Mistral providers. Function calling is supported on the
 * instruction-tuned chat models.
 *
 * Provider id convention: `nvidia:<short-model-name>`.
 */
export class NvidiaProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private lastQuota: LiveQuota | null = null;

  constructor(opts: NvidiaProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "meta/llama-3.3-70b-instruct";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://integrate.api.nvidia.com/v1";
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  private callOpts(body: Record<string, unknown>, signal?: AbortSignal) {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      body,
      signal,
      providerName: "NVIDIA",
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

// Re-exports for back-compat with tests, mirroring groq.ts.
export {
  OpenAICompatError as NvidiaError,
  historyToOpenAIMessages,
  parseOpenAIToolResponse,
} from "./openai-compat.js";
