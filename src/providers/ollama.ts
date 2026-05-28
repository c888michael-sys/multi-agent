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

  constructor(opts: OllamaProviderOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    return this.completeChat([{ kind: "user_text", text: prompt }], opts);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    const fetchImpl = this.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: historyToOllamaMessages(history),
      stream: false,
      options: this.buildOllamaOptions(opts),
    };
    const res = await fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
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
    const fetchImpl = this.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: historyToOllamaMessages(history),
      stream: true,
      options: this.buildOllamaOptions(opts),
    };
    const res = await fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : "";
      throw new Error(`Ollama API ${res.status}: ${text.slice(0, 200)}`);
    }
    // Ollama streams newline-delimited JSON objects. Buffer partial lines
    // across chunk boundaries — a single network read can split a JSON
    // record down the middle.
    const reader = res.body.getReader();
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
    // Stream ended without an explicit done marker — return whatever we got.
    return full;
  }

  isRateLimitError(_err: unknown): boolean {
    return false;
  }

  retryAfterMs(_err: unknown): number | null {
    return null;
  }

  private buildOllamaOptions(opts?: CompleteOptions): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (opts?.temperature !== undefined) o.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) o.num_predict = opts.maxTokens;
    return o;
  }
}
