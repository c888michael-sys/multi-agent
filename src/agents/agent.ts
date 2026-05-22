import type { Router } from "../router.js";
import type { CompleteOptions } from "../provider.js";

export interface AgentOptions {
  id: string;
  role: string;
  systemPrompt: string;
  router: Router;
  defaultCompleteOptions?: CompleteOptions;
}

/**
 * A stateless wrapper: applies a system prompt, calls the router.
 * Stateless on purpose — the controller manages multi-turn flow if needed.
 */
export class Agent {
  readonly id: string;
  readonly role: string;
  readonly systemPrompt: string;
  private readonly router: Router;
  private readonly defaults?: CompleteOptions;

  constructor(opts: AgentOptions) {
    this.id = opts.id;
    this.role = opts.role;
    this.systemPrompt = opts.systemPrompt;
    this.router = opts.router;
    this.defaults = opts.defaultCompleteOptions;
  }

  async run(input: string, opts?: CompleteOptions): Promise<string> {
    const composed = `${this.systemPrompt}\n\n---\n\n${input}`;
    return this.router.complete(composed, { ...this.defaults, ...opts });
  }
}
