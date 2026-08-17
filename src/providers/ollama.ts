/**
 * Ollama provider — talks to a locally-running Ollama daemon (default
 * http://localhost:11434) via its native `/api/chat` and `/api/generate`
 * endpoints. Used to wire local models (DeepSeek-R1, Qwen2.5-Coder, etc.)
 * into the same role/router pipeline as cloud providers.
 *
 * Local models never rate-limit, so isRateLimitError always returns false
 * and retryAfterMs returns null. A network failure (Ollama not running)
 * surfaces as a plain Error which the router treats as fatal — same way
 * a misconfigured API key would surface from a cloud provider.
 */
import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  ToolCallRequest,
  CompleteWithToolsResult,
} from "../tools/types.js";

export interface OllamaProviderOptions {
  id: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Optional fixed request deadline in milliseconds. Local generation has no
   * fixed deadline by default because model loading and long reasoning can be
   * slow. A caller AbortSignal still cancels the underlying Ollama request.
   */
  requestTimeoutMs?: number;
  /**
   * Context window in tokens. Ollama's hard default is 2048, which
   * silently truncates inputs longer than that — disastrous for the
   * categorize prefetch (which embeds the entire chat reply plus a
   * schema in the prompt). We default to 8192 at the provider level;
   * config-created role providers pass explicit, model-appropriate
   * values such as 32768 for the safer 14B local defaults.
   */
  numCtx?: number;
}

interface OllamaMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Base64 image payloads accepted by Ollama's multimodal chat endpoint. */
  images?: string[];
  /** Present on assistant turns that requested tool calls. */
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

function historyToOllamaMessages(history: ConversationPart[]): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  for (const part of history) {
    if (part.kind === "user_text") {
      messages.push({
        role: "user",
        content: part.text,
        ...(part.images?.length
          ? { images: part.images.map((image) => image.dataBase64) }
          : {}),
      });
    } else if (part.kind === "model_text") {
      messages.push({ role: "assistant", content: part.text });
    } else if (part.kind === "model_calls") {
      // Replay a prior assistant tool-call turn so the model can see its history.
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: part.calls.map((c) => ({
          function: { name: c.name, arguments: c.args },
        })),
      });
    } else if (part.kind === "tool_result") {
      messages.push({ role: "tool", content: part.result });
    }
  }
  return messages;
}

/**
 * Extract balanced top-level JSON objects/arrays from a string, ignoring
 * braces that appear inside JSON string literals. Handles content that has
 * surrounding prose or markdown ```json fences. Returns each candidate's
 * parsed value.
 */
function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const stripped = text.replace(/```(?:json)?/gi, "");
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = stripped.slice(start, i + 1);
        try { out.push(JSON.parse(slice)); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Coerce one parsed JSON value into a tool call if it matches the common
 * inline shapes models emit: `{ name, arguments }`, `{ name, parameters }`,
 * `{ tool, args }`, or an OpenAI-style `{ function: { name, arguments } }`.
 * Returns null when it doesn't name one of the offered tools.
 */
function coerceToolCall(value: unknown, offered: ReadonlySet<string>): ToolCallRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const fn = (v.function && typeof v.function === "object") ? (v.function as Record<string, unknown>) : v;
  const name = fn.name ?? fn.tool ?? fn.tool_name;
  if (typeof name !== "string" || !offered.has(name)) return null;
  let rawArgs = fn.arguments ?? fn.args ?? fn.parameters ?? fn.input ?? {};
  if (typeof rawArgs === "string") {
    try { rawArgs = JSON.parse(rawArgs); } catch { rawArgs = {}; }
  }
  const args =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { name, args };
}

/**
 * Parse tool calls that a model emitted as text in the content field rather
 * than in the structured tool_calls field. Scans for JSON objects/arrays and
 * coerces any that name an offered tool. Returns [] when none are found.
 */
export function parseInlineToolCalls(content: string, offered: ReadonlySet<string>): ToolCallRequest[] {
  if (!content.trim()) return [];
  const calls: ToolCallRequest[] = [];
  for (const candidate of extractJsonCandidates(content)) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const c = coerceToolCall(item, offered);
        if (c) calls.push(c);
      }
    } else {
      const c = coerceToolCall(candidate, offered);
      if (c) calls.push(c);
    }
  }
  return calls;
}

export class OllamaProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs: number;
  private readonly numCtx: number;
  private resolvedModel: string;

  constructor(opts: OllamaProviderOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.resolvedModel = opts.model;
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? Number.POSITIVE_INFINITY;
    this.numCtx = opts.numCtx ?? 8192;
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  /** Run a fetch with caller cancellation and an optional fixed deadline. */
  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.fetchImpl ?? fetch;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      return fetchImpl(url, init);
    }

    const controller = new AbortController();
    const parentSignal = init.signal;
    const abortFromParent = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    return fetchImpl(url, { ...init, signal: controller.signal })
      .finally(() => {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
      });
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    return this.completeChat([{ kind: "user_text", text: prompt }], opts);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    let body: Record<string, unknown> = {
      model: this.resolvedModel,
      messages: historyToOllamaMessages(history),
      stream: false,
      options: this.buildOllamaOptions(opts),
    };
    let res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      const alias = await this.resolveInstalledAlias(res.status, text, opts?.signal);
      if (alias) {
        this.resolvedModel = alias;
        body = { ...body, model: alias };
        res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        if (res.ok) {
          const json = (await res.json()) as { message?: { content?: string } };
          return json.message?.content ?? "";
        }
        const retryText = await res.text();
        throw new Error(`Ollama API ${res.status}: ${retryText.slice(0, 200)}`);
      }
      throw new Error(`Ollama API ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? "";
  }

  async completeChatStream(
    history: ConversationPart[],
    opts: CompleteOptions | undefined,
    onToken: (text: string) => void,
  ): Promise<string> {
    let body: Record<string, unknown> = {
      model: this.resolvedModel,
      messages: historyToOllamaMessages(history),
      stream: true,
      options: this.buildOllamaOptions(opts),
    };
    let res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : "";
      const alias = await this.resolveInstalledAlias(res.status, text, opts?.signal);
      if (alias) {
        this.resolvedModel = alias;
        body = { ...body, model: alias };
        res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        if (res.ok && res.body) {
          return this.readStreamResponse(res, onToken);
        }
        const retryText = res.body ? await res.text() : "";
        throw new Error(`Ollama API ${res.status}: ${retryText.slice(0, 200)}`);
      }
      throw new Error(`Ollama API ${res.status}: ${text.slice(0, 200)}`);
    }
    return this.readStreamResponse(res, onToken);
  }

  private async readStreamResponse(
    res: Response,
    onToken: (text: string) => void,
  ): Promise<string> {
    // Ollama streams newline-delimited JSON objects. Buffer partial lines
    // across chunk boundaries ? a single network read can split a JSON
    // record down the middle.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let evt: { message?: { content?: string }; done?: boolean };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        const tok = evt.message?.content ?? "";
        if (tok) {
          full += tok;
          onToken(tok);
        }
        if (evt.done) {
          return full;
        }
      }
    }
    // Stream ended without an explicit done marker ? return whatever we got.
    return full;
  }

  /**
   * Tool-calling via Ollama's native `/api/chat` `tools` field (supported
   * since Ollama 0.3.0). Passes tool declarations as OpenAI-compatible
   * function descriptors; reads back `message.tool_calls` when the model
   * decides to invoke a tool, or `message.content` when it produces text.
   *
   * Not all local models support function calling — ones that don't will
   * either return an empty tool_calls array (treated as text) or produce
   * garbled output. qwen2.5-coder and qwen3.5 support it natively.
   */
  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const ollamaTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const body = {
      model: this.resolvedModel,
      messages: historyToOllamaMessages(history),
      tools: ollamaTools,
      stream: false,
      options: this.buildOllamaOptions(opts),
    };
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: unknown };
        }>;
      };
    };
    const msg = json.message;
    if (!msg) return { kind: "text", text: "" };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const calls: ToolCallRequest[] = msg.tool_calls
        .filter((c) => typeof c.function?.name === "string")
        .map((c) => {
          const args = c.function!.arguments;
          return {
            name: c.function!.name as string,
            args:
              typeof args === "object" && args !== null && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
          };
        });
      if (calls.length > 0) return { kind: "calls", calls };
    }

    // Fallback: some local models (qwen2.5-coder among them) emit tool calls
    // as a JSON object in the CONTENT field instead of the structured
    // tool_calls field, depending on the model's chat template. Detect and
    // parse those so the loop can still execute the tool. Only treats the
    // content as a call when it names a tool we actually offered.
    const content = msg.content ?? "";
    const inlineCalls = parseInlineToolCalls(content, new Set(tools.map((t) => t.name)));
    if (inlineCalls.length > 0) return { kind: "calls", calls: inlineCalls };

    return { kind: "text", text: content };
  }

  isRateLimitError(_err: unknown): boolean {
    return false;
  }

  retryAfterMs(_err: unknown): number | null {
    return null;
  }

  private buildOllamaOptions(opts?: CompleteOptions): Record<string, unknown> {
    // Always send num_ctx — Ollama's daemon default is 2048 tokens, which
    // silently truncates the categorize prefetch's prompt (it embeds the
    // entire chat reply plus the template schema). With truncation the
    // model emits garbage, JSON parse fails, and the mindmap surfaces
    // "couldn't structure this reply". The constructor option overrides
    // this per model; config-created local role providers usually pass a
    // larger value than the provider's standalone fallback.
    const o: Record<string, unknown> = { num_ctx: this.numCtx };
    if (opts?.temperature !== undefined) o.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) o.num_predict = opts.maxTokens;
    return o;
  }

  private async resolveInstalledAlias(
    status: number,
    bodyText: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (status !== 404 || !/not found/i.test(bodyText)) return null;
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const installed = (json.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
      const exact = installed.find((name) => name === this.model);
      if (exact) return exact;
      return installed.find((name) => name.startsWith(`${this.model}-`)) ?? null;
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
  }
}
