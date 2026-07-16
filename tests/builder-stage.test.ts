import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuilderStage } from "../src/web/builder-stage.js";
import { WebFileService } from "../src/web/file-service.js";

describe("BuilderStage", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function create() {
    const root = mkdtempSync(join(tmpdir(), "multi-agent-builder-"));
    roots.push(root);
    writeFileSync(join(root, "existing.txt"), "before", "utf8");
    const stage = new BuilderStage(new WebFileService(root));
    return { root, stage, tools: new Map(stage.toolset().map((tool) => [tool.name, tool])) };
  }

  it("reads and stages in memory without changing the project", async () => {
    const { root, stage, tools } = create();
    const read = await tools.get("read_project_file")!.execute({ path: "existing.txt" });
    expect(read).toContain("before");
    const staged = await tools.get("stage_file")!.execute({ path: "site/index.html", content: "<h1>Hello</h1>", language: "html" });
    expect(staged).toContain('"staged":true');
    expect(stage.candidates()).toEqual([{ path: "site/index.html", content: "<h1>Hello</h1>", language: "html" }]);
    expect(() => readFileSync(join(root, "site", "index.html"), "utf8")).toThrow();
  });

  it("shares the project boundary and blocked-name checks with reviewed writes", async () => {
    const { stage, tools } = create();
    expect(await tools.get("stage_file")!.execute({ path: "../secret.txt", content: "no" })).toContain("ERROR:");
    expect(await tools.get("stage_file")!.execute({ path: ".env", content: "no" })).toContain("ERROR:");
    expect(stage.candidates()).toEqual([]);
  });
});
