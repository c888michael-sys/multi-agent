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
    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        ...(opts?.maxTokens !== undefined && { maxOutputTokens: opts.maxTokens }),
        ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
      },
    });
    const result = await model.generateContent(prompt);
    return result.response.text();
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
