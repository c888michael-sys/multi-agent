import { describe, expect, it } from "vitest";
import { parseArtifactCandidates } from "../src/web/artifact-parser.js";

const fence = String.fromCharCode(96).repeat(3);

describe("parseArtifactCandidates", () => {
  it("reads explicit fenced file headers without changing their content", () => {
    const reply = [`${fence}html path="site/index.html"`, "<h1>Hello</h1>", fence].join("\n");
    expect(parseArtifactCandidates(reply)).toEqual([
      { path: "site/index.html", content: "<h1>Hello</h1>\n", language: "html" },
    ]);
  });

  it("supports legacy leading path comments, including HTML comments", () => {
    const reply = [
      `${fence}css`,
      "/* assets/app.css */",
      "body { color: red; }",
      fence,
      `${fence}html`,
      "<!-- index.html -->",
      "<main>Hi</main>",
      fence,
    ].join("\n");
    expect(parseArtifactCandidates(reply)).toEqual([
      { path: "assets/app.css", content: "body { color: red; }\n", language: "css" },
      { path: "index.html", content: "<main>Hi</main>\n", language: "html" },
    ]);
  });

  it("does not mistake ordinary code for an artifact", () => {
    expect(parseArtifactCandidates([fence + "ts", "const answer = 42;", fence].join("\n"))).toEqual([]);
  });
});
