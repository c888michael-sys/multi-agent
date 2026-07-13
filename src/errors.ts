export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterError";
  }
}

export class AllProvidersExhaustedError extends RouterError {
  readonly attempts: { providerId: string; error: unknown }[];
  constructor(attempts: { providerId: string; error: unknown }[]) {
    const ids = attempts.map((a) => a.providerId).join(", ");
    super(`All providers exhausted (tried: ${ids})`);
    this.name = "AllProvidersExhaustedError";
    this.attempts = attempts;
  }
}

export class NoProvidersConfiguredError extends RouterError {
  constructor() {
    super("Router has no providers configured");
    this.name = "NoProvidersConfiguredError";
  }
}

/** A provider failed after sending visible output; retrying would duplicate it. */
export class StreamInterruptedError extends RouterError {
  readonly partial: string;
  constructor(partial: string, cause: unknown) {
    super(`Stream interrupted after output began: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StreamInterruptedError";
    this.partial = partial;
  }
}
