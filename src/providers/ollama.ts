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
} from "../tools/types.js";

export interface OllamaProviderOptions {
  id: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in milliseconds. Defaults to 180_000 (3 min) —
   * generous enough that a cold 32B model loading from disk on a slow
   * machine still gets through, but bounded so a wedged daemon can't
   * hang the categorize-prefetch pipeline indefinitely. Override per
   * test or per-deploy.
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
}

function historyToOllamaMessages(history: ConversationPart[]): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  for (const part of history) {
    if (part.kind === "user_text") {
      messages.push({ role: "user", content: part.text });
    } else if (part.kind === "model_text") {
      messages.push({ role: "assistant", content: part.text });
    } else if (part.kind === "tool_result") {
      messages.push({ role: "tool", content: part.result });
    }
  }
  return messages;
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
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000;
    this.numCtx = opts.numCtx ?? 8192;
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Run a fetch with an AbortController-backed timeout. Without this,
   * a stalled Ollama daemon (model still loading, GPU contention) would
   * keep the call pending forever and leave the higher-level prefetch
   * promise unresolved.
   */
  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    return fetchImpl(url, { ...init, signal: controller.signal })
      .finally(() => clearTimeout(timer));
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
    });
    if (!res.ok) {
      const text = await res.text();
      const alias = await this.resolveInstalledAlias(res.status, text);
      if (alias) {
        this.resolvedModel = alias;
        body = { ...body, model: alias };
        res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : "";
      const alias = await this.resolveInstalledAlias(res.status, text);
      if (alias) {
        this.resolvedModel = alias;
        body = { ...body, model: alias };
        res = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

  private async resolveInstalledAlias(status: number, bodyText: string): Promise<string | null> {
    if (status !== 404 || !/not found/i.test(bodyText)) return null;
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, { method: "GET" });
      if (!res.ok) return null;
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const installed = (json.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
      const exact = installed.find((name) => name === this.model);
      if (exact) return exact;
      return installed.find((name) => name.startsWith(`${this.model}-`)) ?? null;
    } catch {
      return null;
    }
  }
}
