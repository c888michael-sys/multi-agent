export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  isRateLimitError(err: unknown): boolean;
  retryAfterMs(err: unknown): number | null;
}
