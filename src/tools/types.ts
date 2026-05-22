/**
 * Generic tool-use types. The shapes here mirror Gemini's function-calling
 * surface but are deliberately decoupled so future providers (Groq, OpenAI,
 * etc.) can implement the same interface without leaking Gemini specifics.
 */

/** Minimal JSON Schema subset we use to describe tool parameters. */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean";
      description?: string;
    }
  >;
  required?: string[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface Tool extends ToolDeclaration {
  /** Invoke the tool. May throw; errors are surfaced back to the model as text. */
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  /**
   * Opaque provider-supplied token (Gemini 3.x calls this `thoughtSignature`)
   * that MUST be sent back alongside the call when the model's prior turn is
   * included in conversation history. Treat as opaque — don't inspect or modify.
   */
  signature?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
}

/**
 * One turn in a tool-use conversation. Maps roughly to Gemini's Content[]
 * but provider-agnostic.
 */
export type ConversationPart =
  | { kind: "user_text"; text: string }
  | { kind: "model_text"; text: string }
  | { kind: "model_calls"; calls: ToolCallRequest[] }
  | { kind: "tool_result"; name: string; result: string };

/** What completeWithTools returns: either we're done, or the model wants tools called. */
export type CompleteWithToolsResult =
  | { kind: "text"; text: string }
  | { kind: "calls"; calls: ToolCallRequest[] };
