import { describe, it, expect } from "vitest";
import { RoleOverrideProvider } from "../src/providers/role-override.js";
import type { Provider } from "../src/provider.js";
import type { CompleteWithToolsResult, ConversationPart } from "../src/tools/types.js";
import type { RoleModelSelection } from "../src/models/reasoning-model-overrides.js";

class FakeDelegate implements Provider {
  readonly id: string;
  readonly model: string;
  complete = async (): Promise<string> => `text:${this.model}`;
  completeChat = async (): Promise<string> => `chat:${this.model}`;
  completeWithTools = async (): Promise<CompleteWithToolsResult> => ({ kind: "text", text: `tools:${this.model}` });
  isRateLimitError = (): boolean => false;
  retryAfterMs = (): number | null => null;
  constructor(id: string, model: string) {
    this.id = id;
    this.model = model;
  }
}

/** Delegate with no completeWithTools / completeChatStream to test degradation. */
class ChatOnlyDelegate implements Provider {
  readonly id = "chat-only";
  readonly model = "chat-only-model";
  complete = async (): Promise<string> => "complete";
  completeChat = async (): Promise<string> => "chat-only-reply";
  isRateLimitError = (): boolean => false;
  retryAfterMs = (): number | null => null;
}

describe("RoleOverrideProvider", () => {
  it("is inactive when no selection is set, active when one is", () => {
    let selection: RoleModelSelection | null = null;
    const p = new RoleOverrideProvider({
      role: "reasoning",
      readSelection: () => selection,
      buildDelegate: (sel) => new FakeDelegate("d", sel.model),
    });
    expect(p.isActive()).toBe(false);
    expect(p.model).toBe("(no override)");

    selection = { provider: "nvidia", model: "m1" };
    expect(p.isActive()).toBe(true);
    expect(p.model).toBe("nvidia · m1");
  });

  it("is inactive when buildDelegate returns null (missing key)", () => {
    const p = new RoleOverrideProvider({
      role: "action-code",
      readSelection: () => ({ provider: "nvidia", model: "m" }),
      buildDelegate: () => null,
    });
    expect(p.isActive()).toBe(false);
  });

  it("delegates calls and reflects live model switches", async () => {
    let selection: RoleModelSelection = { provider: "nvidia", model: "m1" };
    const p = new RoleOverrideProvider({
      role: "reasoning",
      readSelection: () => selection,
      buildDelegate: (sel) => new FakeDelegate("d", sel.model),
    });
    expect(await p.completeChat([] as ConversationPart[])).toBe("chat:m1");
    selection = { provider: "nvidia", model: "m2" };
    expect(await p.completeChat([] as ConversationPart[])).toBe("chat:m2");
  });

  it("caches one delegate per provider:model combo", async () => {
    let built = 0;
    let selection: RoleModelSelection = { provider: "nvidia", model: "m1" };
    const p = new RoleOverrideProvider({
      role: "reasoning",
      readSelection: () => selection,
      buildDelegate: (sel) => {
        built++;
        return new FakeDelegate("d", sel.model);
      },
    });
    await p.completeChat([] as ConversationPart[]);
    await p.completeChat([] as ConversationPart[]); // same combo → cached
    expect(built).toBe(1);
    selection = { provider: "nvidia", model: "m2" };
    await p.completeChat([] as ConversationPart[]); // new combo → rebuild
    expect(built).toBe(2);
    selection = { provider: "nvidia", model: "m1" };
    await p.completeChat([] as ConversationPart[]); // back to m1 → still cached
    expect(built).toBe(2);
  });

  it("degrades completeWithTools to chat text when the delegate can't call tools", async () => {
    const p = new RoleOverrideProvider({
      role: "action-code",
      readSelection: () => ({ provider: "gemini", model: "x" }),
      buildDelegate: () => new ChatOnlyDelegate(),
    });
    const result = await p.completeWithTools([] as ConversationPart[], []);
    expect(result).toEqual({ kind: "text", text: "chat-only-reply" });
  });

  it("streams via completeChat fallback when the delegate has no streaming", async () => {
    const tokens: string[] = [];
    const p = new RoleOverrideProvider({
      role: "action-code",
      readSelection: () => ({ provider: "gemini", model: "x" }),
      buildDelegate: () => new ChatOnlyDelegate(),
    });
    const full = await p.completeChatStream([] as ConversationPart[], undefined, (t) => tokens.push(t));
    expect(full).toBe("chat-only-reply");
    expect(tokens).toEqual(["chat-only-reply"]);
  });
});
