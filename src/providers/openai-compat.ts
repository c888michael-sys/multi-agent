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
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
  /** Used in error class name + message. */
  providerName: string;
}

/**
 * POST to <baseUrl>/chat/completions with Bearer auth. Returns parsed JSON or
 * throws OpenAICompatError with status/body/headers attached. Headers are
 * lowercased for case-insensitive Retry-After lookup.
 *
 * `onHeaders` is called on SUCCESS too — providers use it to scrape live
 * rate-limit info (X-RateLimit-*) so the pool can report real RPM/RPD
 * straight from the wire instead of estimating from a local counter.
 */
export async function chatCompletion(
  opts: ChatCompletionOptions & {
    onHeaders?: (headers: Record<string, string>) => void;
  },
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...opts.extraHeaders,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  if (!res.ok) {
    // Surface headers even on error — rate-limit info often arrives with
    // the 429 itself.
    opts.onHeaders?.(headers);
    throw new OpenAICompatError(opts.providerName, res.status, text, headers);
  }
  opts.onHeaders?.(headers);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${opts.providerName} returned non-JSON success body: ${text.slice(0, 200)}`);
  }
}

/**
 * Live rate-limit info parsed from a provider's response headers. Whatever
 * the provider didn't tell us stays undefined.
 */
export interface LiveQuota {
  /** Requests-per-minute remaining (provider-reported). */
  rpmRemaining?: number;
  /** Requests-per-minute limit (provider-reported). */
  rpmCap?: number;
  /** Requests-per-day remaining (provider-reported). */
  rpdRemaining?: number;
  /** Requests-per-day limit (provider-reported). */
  rpdCap?: number;
  /** ms-since-epoch when this snapshot was scraped. */
  fetchedAt: number;
}

/**
 * Parse the common OpenAI-compat rate-limit header families. Different
 * providers emit slightly different headers; we look at the union:
 *
 *   X-RateLimit-Remaining / X-RateLimit-Limit                (OpenRouter style)
 *   x-ratelimit-remaining-requests / x-ratelimit-limit-requests  (Groq)
 *   x-ratelimit-remaining / x-ratelimit-limit                (Cerebras / Mistral)
 *
 * Plus the *-day suffixes some providers expose for daily caps:
 *   x-ratelimit-remaining-requests-day / -limit-day
 *
 * Headers are case-insensitive; the chatCompletion helper lowercases them
 * before calling us, so we only look at the lowercase form.
 */
export function parseLiveQuotaFromHeaders(
  headers: Record<string, string>,
  fetchedAt: number,
): LiveQuota {
  const q: LiveQuota = { fetchedAt };

  // Per-minute window. Try the Groq-style "requests" variant first
  // (most explicit), then fall back to the bare key.
  const rpmRemaining =
    headers["x-ratelimit-remaining-requests"] ??
    headers["x-ratelimit-remaining"] ??
    headers["x-ratelimit-remaining-requests-minute"];
  const rpmCap =
    headers["x-ratelimit-limit-requests"] ??
    headers["x-ratelimit-limit"] ??
    headers["x-ratelimit-limit-requests-minute"];
  if (rpmRemaining !== undefined) {
    const n = Number(rpmRemaining);
    if (Number.isFinite(n)) q.rpmRemaining = n;
  }
  if (rpmCap !== undefined) {
    const n = Number(rpmCap);
    if (Number.isFinite(n)) q.rpmCap = n;
  }

  // Per-day window (when provider exposes it separately).
  const rpdRemaining =
    headers["x-ratelimit-remaining-requests-day"] ??
    headers["x-ratelimit-remaining-day"];
  const rpdCap =
    headers["x-ratelimit-limit-requests-day"] ??
    headers["x-ratelimit-limit-day"];
  if (rpdRemaining !== undefined) {
    const n = Number(rpdRemaining);
    if (Number.isFinite(n)) q.rpdRemaining = n;
  }
  if (rpdCap !== undefined) {
    const n = Number(rpdCap);
    if (Number.isFinite(n)) q.rpdCap = n;
  }

  return q;
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

/** Chat-style request body builder. Used by the completeChat path on OpenAI-compat providers. */
export function buildChatBody(
  model: string,
  history: ConversationPart[],
  opts?: { maxTokens?: number; temperature?: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: historyToOpenAIMessages(history),
  };
  if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  return body;
}

/**
 * Map our generic toolChoice to the provider's wire value. Most OpenAI-compat
 * providers (OpenAI, Groq, Cerebras, OpenRouter) use "required"; Mistral uses
 * "any" for the same meaning. Returns undefined when unset so the body stays
 * clean and the provider's own default ("auto") applies.
 */
export function toolChoiceValue(
  choice: "auto" | "required" | "none" | undefined,
  dialect: "openai" | "mistral",
): string | undefined {
  if (!choice) return undefined;
  if (choice === "required" && dialect === "mistral") return "any";
  return choice;
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
