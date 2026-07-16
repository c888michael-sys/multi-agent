import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuilderStage } from "../src/web/builder-stage.js";
import { WebFileService } from "../src/web/file-service.js";

describe("BuilderStage", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function create(qualityProfile?: "creative-web") {
    const root = mkdtempSync(join(tmpdir(), "multi-agent-builder-"));
    roots.push(root);
    writeFileSync(join(root, "existing.txt"), "before", "utf8");
    const stage = new BuilderStage(new WebFileService(root), { qualityProfile });
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

  it("requires an inferred brief and rejects skeletal creative builds", async () => {
    const { stage, tools } = create("creative-web");
    expect([...tools.keys()]).toEqual(["list_project", "read_project_file", "define_build_brief", "stage_file", "review_build_quality"]);
    await tools.get("stage_file")!.execute({ path: "index.html", content: "<h1>Hello</h1>" });
    const review = await tools.get("review_build_quality")!.execute({});
    expect(review).toContain("ERROR: REVISION_REQUIRED");
    expect(review).toContain("brief");
    expect(stage.completionStatus().ok).toBe(false);
  });

  it("passes a substantial creative build and invalidates review after a later edit", async () => {
    const { stage, tools } = create("creative-web");
    expect(await tools.get("define_build_brief")!.execute({
      concept: "An interactive editorial studio portfolio for ambitious digital work.",
      audience: "Prospective product and design clients",
      visualDirection: "Warm dark editorial typography, precise grid layouts, and restrained motion.",
      sections: "Navigation; Hero; Selected work; Capabilities; Process; Contact",
      interactions: "Interactive project cards and navigation state",
      successCriteria: "Distinctive presentation; Responsive layout; Accessible controls; Finished content",
    })).toContain('"defined":true');
    const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Studio</title></head><body><header><nav aria-label="Primary">Work Process Contact</nav></header><main>${Array.from({ length: 6 }, (_, i) => `<section><h2>Section ${i + 1}</h2><img alt="Project ${i + 1}"><p>${"Meaningful finished case study content for prospective clients. ".repeat(9)}</p></section>`).join("")}</main><footer>Start a project</footer></body></html>`;
    const css = `:root{font-family:system-ui;color:#eee;background:#111}body{margin:0}section{display:grid;grid-template-columns:1fr 1fr;gap:clamp(1rem,4vw,4rem);padding:4rem;border-bottom:1px solid #555}:focus-visible{outline:3px solid orange}@media(max-width:700px){section{grid-template-columns:1fr}}${".card{display:flex;padding:1rem;margin:1rem;color:#eee;background:#222;transition:transform .2s}".repeat(18)}`;
    const js = `document.querySelector('nav').addEventListener('click',()=>document.body.classList.toggle('open'));${"document.querySelectorAll('section').forEach(node=>node.dataset.ready='true');".repeat(6)}`;
    await tools.get("stage_file")!.execute({ path: "index.html", content: html });
    await tools.get("stage_file")!.execute({ path: "style.css", content: css });
    await tools.get("stage_file")!.execute({ path: "script.js", content: js });
    expect(await tools.get("review_build_quality")!.execute({})).toContain('"ok":true');
    expect(stage.completionStatus().ok).toBe(true);
    await tools.get("stage_file")!.execute({ path: "script.js", content: `${js}\n// refined` });
    expect(stage.completionStatus().ok).toBe(false);
    expect(stage.completionStatus().feedback).toContain("review_build_quality again");
  });
});
