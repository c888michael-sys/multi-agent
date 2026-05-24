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
    if (status === 429) return true;
    const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("quota") ||
      msg.includes("resource_exhausted")
    );
  }

  retryAfterMs(err: unknown): number | null {
    const e = err as { headers?: Record<string, string>; retryAfter?: number };
    const header = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    if (typeof e?.retryAfter === "number") return e.retryAfter * 1000;
    return null;
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
      case "user_text":
        contents.push({ role: "user", parts: [{ text: part.text }] });
        break;
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
