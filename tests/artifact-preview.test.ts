import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function previewBuilder(): (files: Array<{ path: string; content: string }>) => { ok: boolean; document?: string; error?: string } {
  const source = readFileSync(join(process.cwd(), "src", "web", "static", "artifact-preview.js"), "utf8");
  const context: { window: Record<string, unknown>; Map: MapConstructor } = { window: {}, Map };
  vm.runInNewContext(source, context);
  return (context.window.ArtifactPreview as { buildPreviewDocument: typeof previewBuilder }).buildPreviewDocument as never;
}

describe("artifact static preview", () => {
  it("embeds local styles and scripts behind a network-blocking CSP", () => {
    const result = previewBuilder()([
      { path: "index.html", content: '<!doctype html><html><head><base href="https://example.test/"><link rel="stylesheet" href="assets/site.css"></head><body><h1>Hello</h1><script src="scripts/app.js"></script></body></html>' },
      { path: "assets/site.css", content: "body { color: green; }" },
      { path: "scripts/app.js", content: "window.previewReady = true;" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.document).toContain("connect-src 'none'");
    expect(result.document).toContain("body { color: green; }");
    expect(result.document).toContain("window.previewReady = true;");
    expect(result.document).not.toContain("<base");
  });

  it("does not offer a preview for a non-static file set", () => {
    const result = previewBuilder()([{ path: "server.ts", content: "export {};" }]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("static HTML") });
  });

  it("uses an opaque-origin script-only iframe", () => {
    const review = readFileSync(join(process.cwd(), "src", "web", "static", "artifact-review.jsx"), "utf8");
    expect(review).toContain('sandbox="allow-scripts"');
    expect(review).not.toContain("allow-same-origin");
    expect(review).toContain('referrerPolicy="no-referrer"');
  });
});
