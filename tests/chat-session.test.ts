import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import { RoleResolver } from "../src/roles/resolver.js";
import { ChatSession, listSessions, parseRouteDirective } from "../src/chat/session.js";
import { FakeProvider } from "./fixtures.js";
import type { ConversationPart } from "../src/tools/types.js";

/**
 * Build a resolver where the orchestration role is backed by a FakeProvider
 * scripted with the given chat-style responses. The FakeProvider's complete()
 * isn't used; we add a completeChat handler manually via a wrapper.
 */
function chatProvider(replies: string[], id = "chat") {
  const p = new FakeProvider(id, []);
  // Stub completeChat by replacing the method on this instance.
  (p as unknown as { completeChat: (h: ConversationPart[]) => Promise<string> }).completeChat = async (
    history: ConversationPart[],
  ) => {
    p.calls.push({ prompt: JSON.stringify(history) });
    const next = replies.shift();
    if (next === undefined) throw new Error(`chatProvider(${id}): out of replies`);
    return next;
  };
  return p;
}

describe("ChatSession", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatsession-"));
    storage = join(dir, "test.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends user + model turns and persists", async () => {
    const p = chatProvider(["hi there"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "test", storagePath: storage });

    const result = await s.send("hello");
    expect(result.reply).toBe("hi there");
    expect(s.snapshot().history).toEqual([
      { kind: "user_text", text: "hello" },
      { kind: "model_text", text: "hi there" },
    ]);
    expect(existsSync(storage)).toBe(true);
  });

  it("survives a process restart by reloading from disk", async () => {
    const p1 = chatProvider(["first reply"]);
    const router1 = new Router([p1], { maxRetryWaitMs: 0 });
    const resolver1 = new RoleResolver(router1, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s1 = new ChatSession({ resolver: resolver1, id: "x", storagePath: storage });
    await s1.send("hello");

    // Brand-new session instance reading from same file.
    const p2 = chatProvider(["second reply"]);
    const router2 = new Router([p2], { maxRetryWaitMs: 0 });
    const resolver2 = new RoleResolver(router2, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s2 = new ChatSession({ resolver: resolver2, id: "x", storagePath: storage });
    expect(s2.snapshot().history).toHaveLength(2); // hello + first reply restored
    await s2.send("second");
    expect(s2.snapshot().history).toHaveLength(4);
  });

  it("clear() wipes history and persists", async () => {
    const p = chatProvider(["a", "b"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "c", storagePath: storage });
    await s.send("one");
    s.clear();
    expect(s.snapshot().history).toEqual([]);
    const onDisk = JSON.parse(readFileSync(storage, "utf8"));
    expect(onDisk.history).toEqual([]);
  });

  it("truncateToRecent keeps only the most recent N pairs", async () => {
    const p = chatProvider(["r1", "r2", "r3"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "t", storagePath: storage });
    await s.send("q1");
    await s.send("q2");
    await s.send("q3");
    s.truncateToRecent(1);
    expect(s.snapshot().history).toEqual([
      { kind: "user_text", text: "q3" },
      { kind: "model_text", text: "r3" },
    ]);
  });

  it("rolls back user message on send error", async () => {
    const p = new FakeProvider("chat", []);
    (p as unknown as { completeChat: () => Promise<string> }).completeChat = async () => {
      throw new Error("boom");
    };
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "e", storagePath: storage });
    await expect(s.send("hi")).rejects.toThrow();
    expect(s.snapshot().history).toEqual([]); // user message not retained
  });

  it("estimateTokens scales with content length and reports budgetPct in send result", async () => {
    const p = chatProvider(["reply"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    // Tiny budget so the warning trips deterministically.
    const s = new ChatSession({
      resolver,
      id: "budget",
      storagePath: storage,
      tokenBudget: 5,
      charsPerToken: 4,
    });
    const result = await s.send("0123456789012345"); // 16 chars -> ~4 tokens
    // "0123456789012345" (16) + "reply" (5) = 21 chars / 4 = 6 tokens; over budget of 5.
    expect(result.warning).toBe("over-budget");
    expect(result.budgetPct).toBeGreaterThanOrEqual(95);
  });

  it("turnCount returns number of model replies", async () => {
    const p = chatProvider(["a", "b", "c"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "tc", storagePath: storage });
    await s.send("1");
    await s.send("2");
    await s.send("3");
    expect(s.turnCount()).toBe(3);
  });
});

describe("parseRouteDirective", () => {
  it("returns null for normal text replies", () => {
    expect(parseRouteDirective("hello world")).toBeNull();
    expect(parseRouteDirective("Let me think...")).toBeNull();
  });

  it("recognizes ROUTE: directives with known roles", () => {
    expect(parseRouteDirective("ROUTE: action-code")).toBe("action-code");
    expect(parseRouteDirective("route: perception")).toBe("perception");
    expect(parseRouteDirective("  ROUTE:  reasoning  ")).toBe("reasoning");
  });

  it("rejects ROUTE: with unknown roles", () => {
    expect(parseRouteDirective("ROUTE: nope")).toBeNull();
    expect(parseRouteDirective("ROUTE: orchestration")).toBeNull(); // can't route to self
  });

  it("rejects ROUTE: with extra text after the role", () => {
    expect(parseRouteDirective("ROUTE: action-code then also do X")).toBeNull();
  });

  it("strips wrapping quotes", () => {
    expect(parseRouteDirective('"ROUTE: action-code"')).toBe("action-code");
  });
});

describe("ChatSession smart routing", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatsmart-"));
    storage = join(dir, "test.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("routes to specialist when orchestrator emits ROUTE: directive", async () => {
    // Orchestrator says ROUTE: action-code; specialist then answers.
    const orchestrator = chatProvider(["ROUTE: action-code"], "orc");
    const specialist = chatProvider(["function fib(n) { return n; }"], "code");
    const router = new Router([orchestrator, specialist], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "orc" }] },
      { name: "action-code", description: "x", candidates: [{ providerId: "code" }] },
    ]);
    const s = new ChatSession({ resolver, id: "smart", storagePath: storage });

    const result = await s.send("Write a fib function");
    expect(result.servedBy).toBe("action-code");
    expect(result.reply).toBe("function fib(n) { return n; }");
    // History contains ONLY the user message + specialist's reply.
    // The orchestrator's "ROUTE: action-code" directive is ephemeral, not persisted.
    expect(s.snapshot().history).toEqual([
      { kind: "user_text", text: "Write a fib function" },
      { kind: "model_text", text: "function fib(n) { return n; }" },
    ]);
    // Orchestrator was called with the routing preamble + history. Specialist was
    // called with the CLEAN history (no preamble).
    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0]!.prompt).toContain("CHAT-ROUTING PROTOCOL");
    expect(specialist.calls).toHaveLength(1);
    expect(specialist.calls[0]!.prompt).not.toContain("CHAT-ROUTING PROTOCOL");
  });

  it("uses orchestrator answer directly when no ROUTE: directive", async () => {
    const orchestrator = chatProvider(["just a normal reply"]);
    const router = new Router([orchestrator], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "direct", storagePath: storage });

    const result = await s.send("hi");
    expect(result.servedBy).toBe("orchestration");
    expect(result.reply).toBe("just a normal reply");
  });

  it("smartRouting=false skips the routing layer entirely", async () => {
    const p = chatProvider(["plain reply"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "simple", storagePath: storage, smartRouting: false });

    const result = await s.send("hi");
    expect(result.servedBy).toBe("orchestration");
    expect(result.reply).toBe("plain reply");
    // Single call — no routing planning overhead.
    expect(p.calls).toHaveLength(1);
  });
});

describe("listSessions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "list-sess-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty when no sessions exist", () => {
    expect(listSessions(dir)).toEqual([]);
  });

  it("lists session ids derived from .json filenames", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "alpha.json"), "{}", "utf8");
    writeFileSync(join(dir, "beta.json"), "{}", "utf8");
    writeFileSync(join(dir, "ignore.txt"), "{}", "utf8");
    expect(listSessions(dir)).toEqual(["alpha", "beta"]);
  });
});
