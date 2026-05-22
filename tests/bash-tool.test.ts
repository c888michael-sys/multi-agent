import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "../src/tools/bash-tool.js";

const isWindows = process.platform === "win32";

/** Returns a one-line shell command that produces given stdout. Portable. */
function echo(text: string): string {
  // Both cmd.exe and /bin/sh handle `echo <text>` similarly for ASCII strings.
  return `echo ${text}`;
}

/** Returns a command guaranteed to exit non-zero. */
function fail(): string {
  return isWindows ? "exit 7" : "exit 7";
}

describe("BashTool", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bashtool-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("rejects construction with a relative workdir", () => {
    expect(() => new BashTool({ workdir: "./relative" })).toThrow(/must be absolute/);
  });

  it("runs a basic command and returns stdout + exit code 0", async () => {
    const t = new BashTool({ workdir });
    const out = await t.runOnce(echo("hello-bash"));
    expect(out).toContain("hello-bash");
    expect(out).toContain("exit code: 0");
  });

  it("returns the non-zero exit code on failure", async () => {
    const t = new BashTool({ workdir });
    const out = await t.runOnce(fail());
    expect(out).toContain("exit code: 7");
  });

  it("runs commands in the supplied workdir (writes go into it)", async () => {
    const t = new BashTool({ workdir });
    // Portable enough: redirection works on both cmd.exe and sh.
    await t.runOnce(`${echo("written")} > marker.txt`);
    expect(existsSync(join(workdir, "marker.txt"))).toBe(true);
    expect(readFileSync(join(workdir, "marker.txt"), "utf8")).toMatch(/written/);
  });

  it("kills and reports timeout when the command runs too long", async () => {
    const t = new BashTool({ workdir, timeoutMs: 200 });
    // Avoid shell-escaping headaches with -e: write a tiny script and invoke
    // it by path. Workdir already contains it after this write.
    writeFileSync(join(workdir, "sleep.cjs"), "setTimeout(()=>{},5000);");
    const out = await t.runOnce(`node sleep.cjs`);
    expect(out).toContain("timed out after 200ms");
  });

  it("caps output at maxBytes and reports truncation", async () => {
    const t = new BashTool({ workdir, maxBytes: 20 });
    writeFileSync(join(workdir, "spam.cjs"), "process.stdout.write('x'.repeat(5000));");
    const out = await t.runOnce(`node spam.cjs`);
    expect(out).toContain("truncated at 20 bytes");
  });

  it("asTool() returns a Tool with the expected name and a working execute()", async () => {
    const t = new BashTool({ workdir });
    const tool = t.asTool();
    expect(tool.name).toBe("bash");
    expect(tool.parameters.required).toEqual(["command"]);
    const out = await tool.execute({ command: echo("via-asTool") });
    expect(out).toContain("via-asTool");
  });

  it("execute() rejects an empty command with ERROR:", async () => {
    const tool = new BashTool({ workdir }).asTool();
    expect(await tool.execute({})).toMatch(/^ERROR: missing 'command'/);
  });
});
