import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import { RoleResolver } from "../src/roles/resolver.js";
import { ChatSession, listSessions } from "../src/chat/session.js";
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
    const s = new ChatSession({ resolver, id: "test", storagePath: storage, smartRouting: false });

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
    const s1 = new ChatSession({ resolver: resolver1, id: "x", storagePath: storage, smartRouting: false });
    await s1.send("hello");

    // Brand-new session instance reading from same file.
    const p2 = chatProvider(["second reply"]);
    const router2 = new Router([p2], { maxRetryWaitMs: 0 });
    const resolver2 = new RoleResolver(router2, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s2 = new ChatSession({ resolver: resolver2, id: "x", storagePath: storage, smartRouting: false });
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
    const s = new ChatSession({ resolver, id: "c", storagePath: storage, smartRouting: false });
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
    const s = new ChatSession({ resolver, id: "t", storagePath: storage, smartRouting: false });
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
    const s = new ChatSession({ resolver, id: "e", storagePath: storage, smartRouting: false });
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
      smartRouting: false,
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
    const s = new ChatSession({ resolver, id: "tc", storagePath: storage, smartRouting: false });
    await s.send("1");
    await s.send("2");
    await s.send("3");
    expect(s.turnCount()).toBe(3);
  });
});

describe("ChatSession smart routing (plan-based)", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatsmart-"));
    storage = join(dir, "test.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("kind=direct: orchestrator answers itself with no specialist call", async () => {
    const orc = chatProvider(['{"kind":"direct","answer":"hello back"}'], "orc");
    const router = new Router([orc], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "orc" }] },
    ]);
    const s = new ChatSession({ resolver, id: "direct", storagePath: storage });

    const result = await s.send("hi");
    expect(result.servedBy).toEqual(["orchestration"]);
    expect(result.reply).toBe("hello back");
    expect(orc.calls).toHaveLength(1); // only the planning call
  });

  it("kind=single: dispatches to one specialist with clean history", async () => {
    const orc = chatProvider(
      ['{"kind":"single","role":"action-code","prompt":""}'],
      "orc",
    );
    const code = chatProvider(["function fib(n) { return n; }"], "code");
    const router = new Router([orc, code], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "orc" }] },
      { name: "action-code", description: "x", candidates: [{ providerId: "code" }] },
    ]);
    const s = new ChatSession({ resolver, id: "single", storagePath: storage });

    const result = await s.send("Write a fib function");
    expect(result.servedBy).toEqual(["action-code"]);
    expect(result.reply).toBe("function fib(n) { return n; }");
    expect(s.snapshot().history).toEqual([
      { kind: "user_text", text: "Write a fib function" },
      { kind: "model_text", text: "function fib(n) { return n; }" },
    ]);
    expect(orc.calls).toHaveLength(1);
    expect(orc.calls[0]!.prompt).toContain("CHAT-PLAN PROTOCOL");
    expect(code.calls).toHaveLength(1);
    expect(code.calls[0]!.prompt).not.toContain("CHAT-PLAN PROTOCOL");
  });

  it("kind=parallel: dispatches to N specialists then synthesizes via orchestration", async () => {
    const orc = chatProvider(
      [
        // 1. plan
        '{"kind":"parallel","tasks":[{"role":"perception","prompt":"facts"},{"role":"reasoning","prompt":"analyze"}]}',
        // 2. synthesis (last orchestration call)
        "synthesized answer combining both",
      ],
      "orc",
    );
    const perception = chatProvider(["facts: A B C"], "perc");
    const reasoning = chatProvider(["analysis: X"], "reas");
    const router = new Router([orc, perception, reasoning], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "orc" }] },
      { name: "perception", description: "x", candidates: [{ providerId: "perc" }] },
      { name: "reasoning", description: "x", candidates: [{ providerId: "reas" }] },
    ]);
    const s = new ChatSession({ resolver, id: "para", storagePath: storage });

    const result = await s.send("Tell me about X");
    expect(result.plan?.kind).toBe("parallel");
    expect(result.servedBy).toEqual(["perception", "reasoning", "orchestration"]);
    expect(result.reply).toBe("synthesized answer combining both");
    // History contains user + final synthesis — not the per-specialist outputs.
    expect(s.snapshot().history).toEqual([
      { kind: "user_text", text: "Tell me about X" },
      { kind: "model_text", text: "synthesized answer combining both" },
    ]);
    expect(perception.calls).toHaveLength(1);
    expect(reasoning.calls).toHaveLength(1);
    expect(orc.calls).toHaveLength(2); // plan + synthesis
  });

  it("malformed plan falls through to single action-structural call", async () => {
    // parsePlan returns single+action-structural fallback for garbage; the
    // specialist (action-structural here) then answers.
    const orc = chatProvider(["not valid json at all"], "orc");
    const fallback = chatProvider(["recovered answer"], "struct");
    const router = new Router([orc, fallback], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "orc" }] },
      { name: "action-structural", description: "x", candidates: [{ providerId: "struct" }] },
    ]);
    const s = new ChatSession({ resolver, id: "fb", storagePath: storage });

    const result = await s.send("anything");
    expect(result.plan?.kind).toBe("single");
    expect(result.servedBy).toEqual(["action-structural"]);
    expect(result.reply).toBe("recovered answer");
  });

  it("smartRouting=false skips planning and calls the entry role directly", async () => {
    const p = chatProvider(["plain reply"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "simple", storagePath: storage, smartRouting: false });

    const result = await s.send("hi");
    expect(result.servedBy).toEqual(["orchestration"]);
    expect(result.reply).toBe("plain reply");
    expect(p.calls).toHaveLength(1); // no planning step
    expect(result.plan).toBeUndefined();
  });

  it("routing mode multi-agent uses reasoning plan, optional checker, and structural formatting", async () => {
    const p = chatProvider([
      JSON.stringify({
        needsResearch: false,
        researchPrompt: "",
        actions: [{ role: "action-code", prompt: "draft answer" }],
        useChecker: true,
        checkerPrompt: "check it",
        maxRepairAttempts: 0,
      }),
      "draft answer",
      JSON.stringify({ status: "ok", issues: [], summary: "clean" }),
      "formatted answer",
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "reasoning", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "action-code", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "action-repetitive", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "action-structural", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const events: string[] = [];
    const s = new ChatSession({ resolver, id: "ma", storagePath: storage });

    const result = await s.send(
      "build something",
      undefined,
      (evt) => {
        if (evt.kind === "role-start") events.push(`${evt.role}:${evt.phase}`);
      },
      { mode: "multi-agent" },
    );

    expect(result.plan?.kind).toBe("multi-agent");
    expect(result.servedBy).toEqual([
      "reasoning",
      "action-code",
      "action-repetitive",
      "action-structural",
    ]);
    expect(result.reply).toBe("formatted answer");
    expect(events).toEqual([
      "reasoning:planning",
      "action-code:action",
      "action-repetitive:check",
      "action-structural:format",
    ]);
  });

  it("routing mode brainstorming uses the research-oriented perception panel", async () => {
    const p = chatProvider([
      "research opinion",
      "reasoning opinion",
      "code opinion",
      "structure opinion",
      "synthesized brainstorm",
    ]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "perception", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "reasoning", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "action-code", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "action-structural", description: "x", candidates: [{ providerId: "chat" }] },
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "brain", storagePath: storage });

    const result = await s.send("ideate", undefined, undefined, { mode: "brainstorming" });

    expect(result.plan?.kind).toBe("parallel");
    expect(result.servedBy).toEqual([
      "perception",
      "reasoning",
      "action-code",
      "action-structural",
      "orchestration",
    ]);
    expect(result.reply).toBe("synthesized brainstorm");
    expect(p.calls[0]!.prompt).toContain("research-based perspective");
  });
});

describe("ChatSession powerful mode", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatpow-"));
    storage = join(dir, "test.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("isPowerful reflects constructor option and setPowerful toggles it", () => {
    const p = chatProvider([]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);

    const s = new ChatSession({ resolver, id: "pow", storagePath: storage, powerful: true });
    expect(s.isPowerful()).toBe(true);
    s.setPowerful(false);
    expect(s.isPowerful()).toBe(false);
    s.setPowerful(true);
    expect(s.isPowerful()).toBe(true);
  });

  it("defaults powerful=false when option not provided", () => {
    const p = chatProvider([]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "pow", storagePath: storage });
    expect(s.isPowerful()).toBe(false);
  });

  it("powerful=true injects thinking: 'high' into provider calls", async () => {
    // Capture what opts the provider receives.
    const p = new FakeProvider("chat", []);
    let capturedOpts: unknown;
    (p as unknown as { completeChat: (h: ConversationPart[], o: unknown) => Promise<string> }).completeChat =
      async (_h, o) => {
        capturedOpts = o;
        return '{"kind":"direct","answer":"hi"}';
      };
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "pow", storagePath: storage, powerful: true });

    await s.send("hello");
    expect((capturedOpts as { thinking?: string }).thinking).toBe("high");
  });

  it("caller-provided opts override powerful mode's thinking setting", async () => {
    const p = new FakeProvider("chat", []);
    let capturedOpts: unknown;
    (p as unknown as { completeChat: (h: ConversationPart[], o: unknown) => Promise<string> }).completeChat =
      async (_h, o) => {
        capturedOpts = o;
        return '{"kind":"direct","answer":"hi"}';
      };
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({ resolver, id: "pow", storagePath: storage, powerful: true });

    await s.send("hello", { thinking: "minimal" });
    expect((capturedOpts as { thinking?: string }).thinking).toBe("minimal");
  });
});

describe("ChatSession saveAs / loadFrom", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatsl-"));
    storage = join(dir, "original.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saveAs copies history to a new session file without disturbing the original", async () => {
    const p = chatProvider(["a"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({
      resolver,
      id: "original",
      storagePath: storage,
      smartRouting: false,
    });
    await s.send("hello");

    const branchPath = s.saveAs("branch");
    expect(existsSync(branchPath)).toBe(true);
    const branchJson = JSON.parse(readFileSync(branchPath, "utf8"));
    expect(branchJson.history).toHaveLength(2);
    // Original session file untouched and current in-memory state unchanged.
    expect(s.snapshot().history).toHaveLength(2);
  });

  it("loadFrom replaces current history with another session's history and persists", async () => {
    const p = chatProvider(["a", "b"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s1 = new ChatSession({
      resolver,
      id: "original",
      storagePath: storage,
      smartRouting: false,
    });
    await s1.send("hi");
    s1.saveAs("snapshot");

    // Now mutate the original session.
    await s1.send("more");
    expect(s1.snapshot().history).toHaveLength(4);

    // Load the snapshot back — should overwrite current to 2 messages.
    const ok = s1.loadFrom("snapshot");
    expect(ok).toBe(true);
    expect(s1.snapshot().history).toHaveLength(2);
    // Original file on disk also reflects the loaded state.
    const onDisk = JSON.parse(readFileSync(storage, "utf8"));
    expect(onDisk.history).toHaveLength(2);
  });

  it("loadFrom returns false when the source session doesn't exist", () => {
    const p = chatProvider([]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({
      resolver,
      id: "original",
      storagePath: storage,
      smartRouting: false,
    });
    expect(s.loadFrom("does-not-exist")).toBe(false);
  });
});

describe("ChatSession auto-summarization", () => {
  let dir: string;
  let storage: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chatsum-"));
    storage = join(dir, "test.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("triggers summarization when projected usage exceeds the threshold", async () => {
    const p = chatProvider(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    // The summarizer calls runRole → provider.complete (NOT completeChat).
    // Override that to always return a stub summary.
    (p as unknown as { complete: () => Promise<string> }).complete = async () => "stub summary";
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({
      resolver,
      id: "sum",
      storagePath: storage,
      smartRouting: false,
      tokenBudget: 100,
      charsPerToken: 4,
      autoSummarize: true,
      autoSummarizeAtPct: 50,
      keepRecentTurns: 1,
    });

    // Send long-ish messages; at some point summarization must trigger.
    let sawSummary = false;
    for (let i = 0; i < 6; i++) {
      const r = await s.send("x".repeat(60));
      if (r.summarizedTurns && r.summarizedTurns > 0) sawSummary = true;
    }
    expect(sawSummary).toBe(true);

    // After at least one summarization, history starts with the synthetic summary.
    const h = s.snapshot().history;
    expect((h[0]! as { text: string }).text).toContain("auto-summarized");
    expect((h[1]! as { text: string }).text).toContain("Earlier conversation summary");
  });

  it("does not summarize when below threshold", async () => {
    const p = chatProvider(["a", "b", "c"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({
      resolver,
      id: "nosum",
      storagePath: storage,
      smartRouting: false,
      autoSummarize: true,
      tokenBudget: 100_000, // huge — never trips
    });
    const result = await s.send("hi");
    expect(result.summarizedTurns).toBeUndefined();
  });

  it("autoSummarize=false disables the feature entirely", async () => {
    const p = chatProvider(["a", "b", "c"]);
    const router = new Router([p], { maxRetryWaitMs: 0 });
    const resolver = new RoleResolver(router, [
      { name: "orchestration", description: "x", candidates: [{ providerId: "chat" }] },
    ]);
    const s = new ChatSession({
      resolver,
      id: "nosum2",
      storagePath: storage,
      smartRouting: false,
      autoSummarize: false,
      tokenBudget: 5, // tiny — would trigger if enabled
    });
    const result = await s.send("hello world this is long");
    expect(result.summarizedTurns).toBeUndefined();
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
