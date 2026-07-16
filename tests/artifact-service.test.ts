import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactService } from "../src/web/artifact-service.js";
import { WebFileService } from "../src/web/file-service.js";

describe("ArtifactService", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function expectCode(action: () => unknown, code: string): void {
    try {
      action();
      throw new Error("expected action to throw");
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  }

  function makeService() {
    const root = mkdtempSync(join(tmpdir(), "multi-agent-artifact-"));
    roots.push(root);
    let activeProjectId = "project-a";
    const context = (projectId: string) => {
      if (projectId !== activeProjectId) {
        throw Object.assign(new Error("the active project changed"), { code: "PROJECT_CONTEXT_CHANGED" });
      }
      const files = new WebFileService(root);
      return {
        project: { id: activeProjectId, name: "Test project", root },
        revision: `${activeProjectId}:${files.realRoot}`,
        files,
      };
    };
    return {
      root,
      service: new ArtifactService(context),
      project: () => ({ id: activeProjectId, revision: `${activeProjectId}:${new WebFileService(root).realRoot}` }),
      switchProject: () => { activeProjectId = "project-b"; },
    };
  }

  it("applies a reviewed multi-file proposal and supports rollback", () => {
    const { root, service, project } = makeService();
    const proposal = service.create({
      projectId: project().id,
      sessionId: "session-1",
      sourceTurnId: "turn-1",
      title: "Small website",
      files: [
        { path: "index.html", content: "<h1>Welcome</h1>\n", language: "html" },
        { path: "assets/site.css", content: "body { margin: 0; }\n", language: "css" },
        { path: "scripts/app.js", content: "console.log('ready');\n", language: "js" },
      ],
    });
    expect(proposal.files).toHaveLength(3);
    expect(JSON.stringify(proposal)).not.toContain("Welcome");
    const applied = service.apply({
      proposalId: proposal.id,
      projectId: project().id,
      projectRevision: project().revision,
      confirm: true,
    });
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("Welcome");
    expect(readFileSync(join(root, "assets", "site.css"), "utf8")).toContain("margin");

    expect(service.rollback({
      transactionId: applied.transactionId,
      projectId: project().id,
      projectRevision: project().revision,
      undoToken: applied.undoToken,
      confirm: true,
    })).toEqual({ rolledBack: true });
    expect(() => readFileSync(join(root, "index.html"), "utf8")).toThrow();
  });

  it("detects a stale file before writing any selected file", () => {
    const { root, service, project } = makeService();
    writeFileSync(join(root, "existing.txt"), "before\n", "utf8");
    const proposal = service.create({
      projectId: project().id,
      sessionId: "session-1",
      sourceTurnId: "turn-1",
      files: [
        { path: "existing.txt", content: "proposal\n" },
        { path: "new.txt", content: "should not appear\n" },
      ],
    });
    writeFileSync(join(root, "existing.txt"), "outside change\n", "utf8");
    expectCode(() => service.apply({
      proposalId: proposal.id,
      projectId: project().id,
      projectRevision: project().revision,
      confirm: true,
    }), "ARTIFACT_CONFLICT");
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("outside change\n");
    expect(() => readFileSync(join(root, "new.txt"), "utf8")).toThrow();
  });

  it("rejects unsafe and duplicate paths before storing a proposal", () => {
    const { service, project } = makeService();
    const input = { projectId: project().id, sessionId: "session", sourceTurnId: "turn" };
    expectCode(() => service.create({ ...input, files: [{ path: "../secret.txt", content: "no" }] }), "INVALID_PATH");
    expectCode(() => service.create({ ...input, files: [
      { path: "Readme.md", content: "a" },
      { path: "README.md", content: "b" },
    ] }), "DUPLICATE_PATH");
  });

  it("binds proposals to the active project context", () => {
    const { service, project, switchProject } = makeService();
    const proposal = service.create({
      projectId: project().id, sessionId: "session", sourceTurnId: "turn",
      files: [{ path: "index.html", content: "hello" }],
    });
    switchProject();
    expectCode(() => service.apply({
      proposalId: proposal.id, projectId: "project-a", projectRevision: proposal.projectRevision, confirm: true,
    }), "PROJECT_CONTEXT_CHANGED");
  });
});
