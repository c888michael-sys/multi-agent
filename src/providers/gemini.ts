import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Provider, CompleteOptions } from "../provider.js";
import type {
  ConversationPart,
  ToolDeclaration,
  CompleteWithToolsResult,
  ToolCallRequest,
} from "../tools/types.js";

export interface GeminiProviderOptions {
  id: string;
  apiKey: string;
  model?: string;
}

export class GeminiProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly client: GoogleGenerativeAI;

  constructor(opts: GeminiProviderOptions) {
    this.id = opts.id;
    this.model = opts.model ?? "gemini-3.5-flash";
    this.client = new GoogleGenerativeAI(opts.apiKey);
  }

  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    // Both thinkingConfig and tools are Gemini 3.x features the older SDK's
    // typed surface doesn't fully cover. The API itself forwards them — cast
    // and drop once @google/generative-ai catches up to 3.x.
    const generationConfig: Record<string, unknown> = {
      ...(opts?.maxTokens !== undefined && { maxOutputTokens: opts.maxTokens }),
      ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts?.thinking !== undefined && {
        thinkingConfig: { thinkingLevel: opts.thinking },
      }),
    };
    const modelArgs: Record<string, unknown> = {
      model: this.model,
      generationConfig,
    };
    if (opts?.useSearch) {
      // Google Search grounding. Model decides whether to search and may
      // issue multiple internal queries per call.
      modelArgs.tools = [{ googleSearch: {} }];
    }
    const model = this.client.getGenerativeModel(modelArgs as never);
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    if (!opts?.useSearch) return text;
    return appendSources(text, result.response);
  }

  isRateLimitError(err: unknown): boolean {
    const status = extractStatus(err);
    if (status === 429 || status === 503) return true;
    const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
    // Defensive failover for retired/unsupported model slugs. When Google
    // retires a model (e.g. `gemma-3-27b-it` was pulled from AI Studio by
    // May 2026), generateContent returns `404 ... is not found for API
    // version v1beta, or is not supported for generateContent`. Rather than
    // throwing out of the entire role, treat it as a failover-able
    // condition so the resolver rotates to the next candidate (e.g.
    // Cerebras or the next Gemma slot). This means a model retirement
    // degrades gracefully — the chain keeps serving from healthy slots
    // until someone updates the slug. A chain whose every candidate 404s
    // still surfaces AllProvidersExhaustedError, the correct failure mode.
    if (
      status === 404 &&
      (msg.includes("generatecontent") || msg.includes("is not found for api version"))
    ) {
      return true;
    }
    return (
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("service unavailable") ||
      msg.includes("high demand") ||
      msg.includes("rate limit") ||
      msg.includes("quota") ||
      msg.includes("resource_exhausted")
    );
  }

  retryAfterMs(err: unknown): number | null {
    const e = err as { headers?: Record<string, string>; retryAfter?: number; message?: string };
    // 1) Standard Retry-After header (rare with the SDK but free if it's there).
    const header = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    // 2) Direct `retryAfter` field on the error (some SDK paths populate this).
    if (typeof e?.retryAfter === "number") return e.retryAfter * 1000;
    // 3) Gemini SDK embeds RetryInfo inside the error MESSAGE as a JSON
    //    array. Sample:
    //      "...Please retry in 35.9s. [{...},{"@type":"...RetryInfo","retryDelay":"35s"}]"
    //    Parse the embedded JSON for the structured retryDelay; fall back to
    //    the human-readable "retry in X.Ys" phrase if the JSON shape isn't there.
    const msg = String(e?.message ?? err ?? "");
    return parseGeminiRetryDelayMs(msg);
  }

  async completeChat(history: ConversationPart[], opts?: CompleteOptions): Promise<string> {
    const generationConfig: Record<string, unknown> = {
      ...(opts?.maxTokens !== undefined && { maxOutputTokens: opts.maxTokens }),
      ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts?.thinking !== undefined && {
        thinkingConfig: { thinkingLevel: opts.thinking },
      }),
    };
    const modelArgs: Record<string, unknown> = {
      model: this.model,
      generationConfig,
    };
    if (opts?.useSearch) modelArgs.tools = [{ googleSearch: {} }];
    const model = this.client.getGenerativeModel(modelArgs as never);
    const contents = historyToGeminiContents(history);
    const result = await model.generateContent({ contents } as never);
    const text = result.response.text();
    if (!opts?.useSearch) return text;
    return appendSources(text, result.response);
  }

  /**
   * Streaming variant of completeChat. Iterates the SDK's stream and
   * emits each chunk's text via onToken; returns the full assembled
   * string at the end. Google Search grounding still appends a Sources
   * footer once (not streamed).
   */
  async completeChatStream(
    history: ConversationPart[],
    opts: CompleteOptions | undefined,
    onToken: (text: string) => void,
  ): Promise<string> {
    const generationConfig: Record<string, unknown> = {
      ...(opts?.maxTokens !== undefined && { maxOutputTokens: opts.maxTokens }),
      ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts?.thinking !== undefined && {
        thinkingConfig: { thinkingLevel: opts.thinking },
      }),
    };
    const modelArgs: Record<string, unknown> = {
      model: this.model,
      generationConfig,
    };
    if (opts?.useSearch) modelArgs.tools = [{ googleSearch: {} }];
    const model = this.client.getGenerativeModel(modelArgs as never);
    const contents = historyToGeminiContents(history);
    // generateContentStream returns { stream, response } where stream is an
    // async iterable of chunks. Each chunk.text() is the incremental delta.
    const streamed = (await (model as never as {
      generateContentStream: (req: unknown) => Promise<{
        stream: AsyncIterable<{ text: () => string }>;
        response: Promise<unknown>;
      }>;
    }).generateContentStream({ contents }));
    let full = "";
    for await (const chunk of streamed.stream) {
      const piece = chunk.text();
      if (piece) {
        full += piece;
        onToken(piece);
      }
    }
    if (!opts?.useSearch) return full;
    const finalResponse = await streamed.response;
    return appendSources(full, finalResponse as never);
  }

  async completeWithTools(
    history: ConversationPart[],
    tools: ToolDeclaration[],
    opts?: CompleteOptions,
  ): Promise<CompleteWithToolsResult> {
    const generationConfig: Record<string, unknown> = {
      ...(opts?.maxTokens !== undefined && { maxOutputTokens: opts.maxTokens }),
      ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts?.thinking !== undefined && {
        thinkingConfig: { thinkingLevel: opts.thinking },
      }),
    };
    const modelArgs: Record<string, unknown> = {
      model: this.model,
      generationConfig,
      tools: [{ functionDeclarations: tools }],
    };
    const model = this.client.getGenerativeModel(modelArgs as never);
    const contents = historyToGeminiContents(history);
    const result = await model.generateContent({ contents } as never);
    return parseToolResponse(result.response);
  }
}

/** Convert our provider-agnostic history into Gemini's Content[] shape. */
export function historyToGeminiContents(history: ConversationPart[]): unknown[] {
  const contents: unknown[] = [];
  for (const part of history) {
    switch (part.kind) {
      case "user_text": {
        const parts: unknown[] = [{ text: part.text }];
        // Multimodal: append each attached image as an inlineData part so
        // Gemini Flash sees pasted screenshots alongside the prompt text.
        for (const img of part.images ?? []) {
          parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } });
        }
        contents.push({ role: "user", parts });
        break;
      }
      case "model_text":
        contents.push({ role: "model", parts: [{ text: part.text }] });
        break;
      case "model_calls":
        contents.push({
          role: "model",
          parts: part.calls.map((c) => {
            const fcPart: Record<string, unknown> = {
              functionCall: { name: c.name, args: c.args },
            };
            // Gemini 3.x requires thoughtSignature on functionCall parts in
            // multi-turn history. Re-attach exactly as received.
            if (c.signature) fcPart.thoughtSignature = c.signature;
            return fcPart;
          }),
        });
        break;
      case "tool_result":
        contents.push({
          role: "user",
          parts: [
            { functionResponse: { name: part.name, response: { result: part.result } } },
          ],
        });
        break;
    }
  }
  return contents;
}

/** Read the model's response: if any functionCall parts, return calls; else return text. */
export function parseToolResponse(response: unknown): CompleteWithToolsResult {
  const r = response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          thoughtSignature?: string;
          functionCall?: { name?: string; args?: Record<string, unknown> };
        }>;
      };
    }>;
    text?: () => string;
  };
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  const calls: ToolCallRequest[] = [];
  let text = "";
  for (const p of parts) {
    if (p.functionCall?.name) {
      const call: ToolCallRequest = {
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      };
      // Gemini 3.x sends thoughtSignature as a sibling of functionCall on the
      // same part. We must echo it back on the next turn or the API 400s.
      if (p.thoughtSignature) call.signature = p.thoughtSignature;
      calls.push(call);
    } else if (typeof p.text === "string") {
      text += p.text;
    }
  }
  if (calls.length > 0) return { kind: "calls", calls };
  // Fall back to response.text() if parts didn't give us anything (older SDK paths).
  if (!text && typeof r.text === "function") text = r.text();
  return { kind: "text", text };
}

function extractStatus(err: unknown): number | null {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status ?? null;
}

/**
 * Pull groundingMetadata off a grounded response and append a Markdown-ish
 * "Sources" footer. Defensive: if structure isn't what we expect, return
 * text unchanged rather than throwing.
 *
 * Exported for unit testing.
 */
export function appendSources(text: string, response: unknown): string {
  try {
    const r = response as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
          webSearchQueries?: string[];
        };
      }>;
    };
    const meta = r.candidates?.[0]?.groundingMetadata;
    const chunks = meta?.groundingChunks ?? [];
    if (chunks.length === 0) return text;

    const seen = new Set<string>();
    const sources: string[] = [];
    for (const c of chunks) {
      const uri = c.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      const title = c.web?.title ?? uri;
      sources.push(`- [${title}](${uri})`);
    }
    if (sources.length === 0) return text;

    const queries = meta?.webSearchQueries ?? [];
    const queryLine = queries.length > 0 ? `  (searched: ${queries.join(" | ")})\n` : "";
    return `${text}\n\nSources:\n${queryLine}${sources.join("\n")}`;
  } catch {
    return text;
  }
}

/**
 * Parse Gemini's error message for the actual retry hint Google sent.
 *
 * The SDK error includes both an English sentence ("Please retry in 35.9s.")
 * and a structured RetryInfo JSON object inside square brackets:
 *
 *   [{"@type":"...RetryInfo","retryDelay":"35s"}]
 *
 * Prefer the structured form (more precise — supports "35s" / "1.5s" /
 * "1234ms"); fall back to the English phrase if the JSON isn't there;
 * return null if neither pattern matches.
 *
 * Exported for test coverage; the GeminiProvider also calls it from
 * retryAfterMs().
 */
export function parseGeminiRetryDelayMs(message: string): number | null {
  if (!message) return null;

  // 1) Structured retryDelay. The SDK serializes the rpc.Status details
  //    into a JSON array in the message text; rather than parse the whole
  //    array (which is fragile when sibling objects have nested brackets
  //    like `"links":[]`), we match the `"retryDelay": "..."` field
  //    directly — it's the only field we actually need and the substring
  //    is unambiguous within Google's error format.
  const structured = message.match(/"retryDelay"\s*:\s*"([^"]+)"/);
  if (structured) {
    const ms = parseDurationToMs(structured[1]!);
    if (ms !== null) return ms;
  }

  // 2) English fallback — "Please retry in 35.9s" / "retry in 35s".
  const englishMatch = message.match(/retry in\s+([\d.]+)\s*s/i);
  if (englishMatch) {
    const seconds = Number(englishMatch[1]);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }

  return null;
}

/** Parse Google's protobuf Duration string ("35s", "1.5s", "1234ms") to ms. */
function parseDurationToMs(s: string): number | null {
  // Matches: digits + optional decimal + unit (s | ms | m | h | ns).
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ns|ms|s|m|h)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  switch (m[2]) {
    case "ns": return Math.round(value / 1_000_000);
    case "ms": return Math.round(value);
    case "s":  return Math.round(value * 1000);
    case "m":  return Math.round(value * 60_000);
    case "h":  return Math.round(value * 3_600_000);
    default:   return null;
  }
}
