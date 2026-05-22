import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
  ToolCallRequest,
} from "../tools/types.js";

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
 * Groq provider — OpenAI-compatible chat completions API. Uses Node 18+'s
 * built-in fetch; no new dependency required.
 *
 * Rate limits are account-wide on the free tier (30 RPM / 6K TPM / 1000 RPD
 * across ALL models on this key). Putting multiple Groq models in the pool
 * doesn't give independent quotas — use one strong Groq model per account.
 *
 * Function calling: OpenAI-style `tools` array, response carries `tool_calls`
 * with provider-assigned IDs that must be echoed back as `tool_call_id` on
 * subsequent turns.
 */
export class GroqProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GroqProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "llama-3.3-70b-versatile";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.groq.com/openai/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const res = await this.post("/chat/completions", body);
    return extractText(res);
  }

  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: historyToOpenAIMessages(history),
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    };
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const res = await this.post("/chat/completions", body);
    return parseOpenAIToolResponse(res);
  }

  isRateLimitError(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    if (e?.status === 429) return true;
    const msg = String(e?.message ?? err ?? "").toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("quota")
    );
  }

  retryAfterMs(err: unknown): number | null {
    const e = err as { headers?: Record<string, string> };
    const header = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    return null;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      throw new GroqError(res.status, text, headers);
    }
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Groq returned non-JSON success body: ${text.slice(0, 200)}`);
    }
  }
}

export class GroqError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
  constructor(status: number, body: string, headers: Record<string, string>) {
    super(`Groq API ${status}: ${body.slice(0, 200)}`);
    this.name = "GroqError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Convert our provider-agnostic history into OpenAI chat messages. Exported for tests. */
export function historyToOpenAIMessages(history: ConversationPart[]): unknown[] {
  const messages: unknown[] = [];
  for (const part of history) {
    switch (part.kind) {
      case "user_text":
        messages.push({ role: "user", content: part.text });
        break;
      case "model_text":
        messages.push({ role: "assistant", content: part.text });
        break;
      case "model_calls":
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: part.calls.map((c, i) => ({
            id: c.toolCallId ?? `call_${i}_${c.name}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        break;
      case "tool_result":
        messages.push({
          role: "tool",
          tool_call_id: part.toolCallId ?? `call_0_${part.name}`,
          content: part.result,
        });
        break;
    }
  }
  return messages;
}

/** Parse an OpenAI-style chat completion into our generic shape. Exported for tests. */
export function parseOpenAIToolResponse(response: unknown): CompleteWithToolsResult {
  const r = response as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const msg = r.choices?.[0]?.message ?? {};
  const rawCalls = msg.tool_calls ?? [];
  const calls: ToolCallRequest[] = [];
  for (const c of rawCalls) {
    if (c.type !== "function" || !c.function?.name) continue;
    let args: Record<string, unknown> = {};
    if (c.function.arguments) {
      try {
        args = JSON.parse(c.function.arguments);
      } catch {
        // Model returned non-JSON args; surface as empty rather than throw.
        args = {};
      }
    }
    const call: ToolCallRequest = { name: c.function.name, args };
    if (c.id) call.toolCallId = c.id;
    calls.push(call);
  }
  if (calls.length > 0) return { kind: "calls", calls };
  return { kind: "text", text: msg.content ?? "" };
}

function extractText(response: unknown): string {
  const r = response as { choices?: Array<{ message?: { content?: string | null } }> };
  return r.choices?.[0]?.message?.content ?? "";
}
