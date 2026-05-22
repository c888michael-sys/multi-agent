import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Provider, CompleteOptions } from "../provider.js";

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
