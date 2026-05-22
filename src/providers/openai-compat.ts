/**
 * Shared helpers for OpenAI-compatible REST APIs (Groq, OpenRouter,
 * Cerebras, Mistral, etc.). Each concrete provider class is a thin wrapper
 * over these, customizing baseUrl, default model, attribution headers, and
 * error message style.
 *
 * Why functions, not a base class: providers vary in small ways (extra
 * headers, model-id conventions, response quirks) and inheritance with
 * overridable hooks would obscure those differences. Functional composition
 * keeps each provider's specifics visible at the top of its file.
 */
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
  ToolCallRequest,
} from "../tools/types.js";

export class OpenAICompatError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
  constructor(providerName: string, status: number, body: string, headers: Record<string, string>) {
    super(`${providerName} API ${status}: ${body.slice(0, 200)}`);
    this.name = `${providerName}Error`;
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export interface ChatCompletionOptions {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
  /** Used in error class name + message. */
  providerName: string;
}

/**
 * POST to <baseUrl>/chat/completions with Bearer auth. Returns parsed JSON or
 * throws OpenAICompatError with status/body/headers attached. Headers are
 * lowercased for case-insensitive Retry-After lookup.
 */
export async function chatCompletion(opts: ChatCompletionOptions): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...opts.extraHeaders,
    },
    body: JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    throw new OpenAICompatError(opts.providerName, res.status, text, headers);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${opts.providerName} returned non-JSON success body: ${text.slice(0, 200)}`);
  }
}

/** Convert our provider-agnostic history into OpenAI chat messages. */
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

/** Parse an OpenAI-style chat completion response into our generic shape. */
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

export function extractTextFromCompletion(response: unknown): string {
  const r = response as { choices?: Array<{ message?: { content?: string | null } }> };
  return r.choices?.[0]?.message?.content ?? "";
}

/** Build the OpenAI-style tools array from our generic ToolDeclaration. */
export function buildOpenAIToolsArray(tools: ToolDeclaration[]): unknown {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Heuristic rate-limit classifier used by most OpenAI-compatible providers. */
export function looksLikeRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) return true;
  const msg = String(e?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("too many requests")
  );
}

/** Parse Retry-After header (seconds) into milliseconds. Returns null if absent. */
export function retryAfterMsFromHeaders(err: unknown): number | null {
  const e = err as { headers?: Record<string, string> };
  const header = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return null;
}
