import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTools } from "../src/tools/file-tools.js";

describe("FileTools — path sandboxing", () => {
  let root: string;
  let outside: string;
  let tools: FileTools;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "filetools-"));
    outside = mkdtempSync(join(tmpdir(), "filetools-outside-"));
    writeFileSync(join(root, "hello.txt"), "hi there");
    writeFileSync(join(outside, "secret.txt"), "not for you");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "nested.txt"), "nested content");
    tools = new FileTools(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects relative paths that escape with ..", () => {
    expect(() => tools.resolveSafe("../secret.txt")).toThrow(/escapes workdir/);
    expect(() => tools.resolveSafe("sub/../../outside.txt")).toThrow(/escapes workdir/);
  });

  it("rejects absolute paths outside workdir", () => {
    expect(() => tools.resolveSafe(outside)).toThrow(/escapes workdir/);
  });

  it("accepts relative paths inside workdir", () => {
    expect(tools.resolveSafe("hello.txt")).toBe(join(root, "hello.txt"));
    expect(tools.resolveSafe("sub/nested.txt")).toBe(join(root, "sub", "nested.txt"));
  });

  it("rejects construction with a relative workdir", () => {
    expect(() => new FileTools("./relative")).toThrow(/must be absolute/);
  });
});

describe("FileTools.readFileTool", () => {
  let root: string;
  let tools: FileTools;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ft-read-"));
    writeFileSync(join(root, "hi.txt"), "hello world");
    mkdirSync(join(root, "d"), { recursive: true });
    tools = new FileTools(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads an existing file", async () => {
    expect(await tools.readFileTool().execute({ path: "hi.txt" })).toBe("hello world");
  });

  it("returns ERROR for nonexistent path", async () => {
    expect(await tools.readFileTool().execute({ path: "nope.txt" })).toMatch(/^ERROR: file not found/);
  });

  it("returns ERROR when path is a directory", async () => {
    expect(await tools.readFileTool().execute({ path: "d" })).toMatch(/^ERROR: path is a directory/);
  });

  it("returns ERROR for escape attempt instead of throwing", async () => {
    expect(await tools.readFileTool().execute({ path: "../escape.txt" })).toMatch(/^ERROR: .*escapes/);
  });

  it("returns ERROR for files larger than maxBytes", async () => {
    const t = new FileTools(root, { maxBytes: 5 });
    expect(await t.readFileTool().execute({ path: "hi.txt" })).toMatch(/^ERROR: file too large/);
  });
});

describe("FileTools.writeFileTool", () => {
  let root: string;
  let tools: FileTools;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ft-write-"));
    tools = new FileTools(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates new files and reports byte count", async () => {
    const res = await tools.writeFileTool().execute({ path: "a.txt", content: "hello" });
    expect(res).toMatch(/^OK: wrote 5 bytes/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
  });

  it("creates intermediate directories", async () => {
    await tools.writeFileTool().execute({ path: "deep/nested/x.txt", content: "x" });
    expect(existsSync(join(root, "deep", "nested", "x.txt"))).toBe(true);
  });

  it("overwrites existing files", async () => {
    writeFileSync(join(root, "b.txt"), "old");
    await tools.writeFileTool().execute({ path: "b.txt", content: "new" });
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new");
  });

  it("returns ERROR for escape attempts", async () => {
    const res = await tools.writeFileTool().execute({ path: "../pwn.txt", content: "x" });
    expect(res).toMatch(/^ERROR: .*escapes/);
  });
});

describe("FileTools.listDirTool", () => {
  let root: string;
  let tools: FileTools;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ft-ls-"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    mkdirSync(join(root, "subdir"));
    tools = new FileTools(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists files and dirs in the root", async () => {
    const out = await tools.listDirTool().execute({ path: "." });
    expect(out).toContain("[file] a.txt");
    expect(out).toContain("[file] b.txt");
    expect(out).toContain("[dir]  subdir");
  });

  it("reports empty dirs", async () => {
    expect(await tools.listDirTool().execute({ path: "subdir" })).toBe("(empty)");
  });

  it("returns ERROR for nonexistent or non-directory paths", async () => {
    expect(await tools.listDirTool().execute({ path: "missing" })).toMatch(/not found/);
    expect(await tools.listDirTool().execute({ path: "a.txt" })).toMatch(/not a directory/);
  });
});
