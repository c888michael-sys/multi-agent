import type { Router } from "../router.js";
import type { CompleteOptions } from "../provider.js";
import type { Tool, ToolCallRecord, ConversationPart, ToolDeclaration } from "./types.js";

export interface ToolRunnerOptions {
  router: Router;
  tools: Tool[];
  /** Hard cap on tool-call iterations to prevent infinite loops. Default 10. */
  maxIterations?: number;
}

export interface ToolRunResult {
  /** Final natural-language answer from the model. */
  finalText: string;
  /** Every tool call made during the run, in order. */
  toolCalls: ToolCallRecord[];
  /** Whether maxIterations was hit (loop bailed without a final text). */
  truncated: boolean;
  /** Full conversation history including all turns. */
  history: ConversationPart[];
}

/**
 * Runs a multi-turn loop:
 *   1. Send user prompt + tool declarations to the router.
 *   2. If model wants to call tools, execute them locally, send results back.
 *   3. Repeat until model produces text or we hit maxIterations.
 *
 * Unknown tool names are surfaced back to the model as "ERROR: unknown tool"
 * rather than throwing — gives the model a chance to recover.
 */
export class ToolRunner {
  private readonly router: Router;
  private readonly toolsByName: Map<string, Tool>;
  private readonly toolDecls: ToolDeclaration[];
  private readonly maxIterations: number;

  constructor(opts: ToolRunnerOptions) {
    this.router = opts.router;
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
    this.toolDecls = opts.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    this.maxIterations = opts.maxIterations ?? 10;
  }

  async run(prompt: string, opts?: CompleteOptions): Promise<ToolRunResult> {
    const history: ConversationPart[] = [{ kind: "user_text", text: prompt }];
    const toolCalls: ToolCallRecord[] = [];

    for (let i = 0; i < this.maxIterations; i++) {
      const result = await this.router.completeWithTools(history, this.toolDecls, opts);

      if (result.kind === "text") {
        history.push({ kind: "model_text", text: result.text });
        return { finalText: result.text, toolCalls, truncated: false, history };
      }

      // Tool calls. Execute each, accumulate, feed back.
      history.push({ kind: "model_calls", calls: result.calls });
      for (const call of result.calls) {
        const tool = this.toolsByName.get(call.name);
        let resultText: string;
        let ok = true;
        if (!tool) {
          resultText = `ERROR: unknown tool '${call.name}'. Available: ${[...this.toolsByName.keys()].join(", ")}`;
          ok = false;
        } else {
          try {
            resultText = await tool.execute(call.args);
            // Tools return "ERROR: ..." for recoverable failures; mark accordingly.
            ok = !resultText.startsWith("ERROR:");
          } catch (err) {
            resultText = `ERROR: ${(err as Error).message}`;
            ok = false;
          }
        }
        toolCalls.push({ name: call.name, args: call.args, result: resultText, ok });
        history.push({
          kind: "tool_result",
          name: call.name,
          result: resultText,
          ...(call.toolCallId !== undefined && { toolCallId: call.toolCallId }),
        });
      }
    }

    return {
      finalText: `[truncated after ${this.maxIterations} tool iterations]`,
      toolCalls,
      truncated: true,
      history,
    };
  }
}
