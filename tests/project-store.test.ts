import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  assertWithinAllowList,
  getActiveProject,
  listProjects,
  pathContains,
  readProjects,
  removeProject,
  setActiveProject,
  setPinnedFile,
  writeProjects,
} from "../src/project/store.js";

function tmpStore(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "project-store-"));
  const file = join(dir, "projects.json");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// pathContains
// ---------------------------------------------------------------------------
describe("pathContains", () => {
  it("returns true for exact match", () => {
    expect(pathContains("/a/b", "/a/b")).toBe(true);
  });

  it("returns true when candidate is nested", () => {
    expect(pathContains("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("returns false for sibling directories", () => {
    // Note: on Windows paths like C:\a\b and C:\a\c, but we test with current-dir logic.
    // Use the current drive/root to stay OS-agnostic.
    const tmp = tmpdir();
    expect(pathContains(join(tmp, "x"), join(tmp, "y"))).toBe(false);
  });

  it("returns false for traversal attempt", () => {
    expect(pathContains("/a/b", "/a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readProjects / writeProjects
// ---------------------------------------------------------------------------
describe("readProjects / writeProjects", () => {
  it("returns a seeded default when file does not exist", () => {
    const { file, cleanup } = tmpStore();
    try {
      const set = readProjects(file);
      expect(set.version).toBe(1);
      expect(set.projects).toHaveLength(1);
      expect(set.projects[0]!.id).toMatch(/^p_[0-9a-f]{8}$/);
      expect(set.activeId).toBe(set.projects[0]!.id);
    } finally {
      cleanup();
    }
  });

  it("returns a seeded default on corrupt JSON", () => {
    const { file, cleanup } = tmpStore();
    try {
      writeFileSync(file, "not json");
      const set = readProjects(file);
      expect(set.projects).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("returns a seeded default on wrong version", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      writeProjects(file, {
        version: 1,
        activeId: "p_aaa",
        projects: [{ id: "p_aaa", name: "x", root: dir, pinnedFile: null, createdAt: 0, updatedAt: 0 }],
      });
      // Manually corrupt the version
      writeFileSync(file, JSON.stringify({ version: 99, projects: [] }));
      const set = readProjects(file);
      expect(set.projects).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("round-trips a valid set", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const input = {
        version: 1 as const,
        activeId: "p_0001",
        projects: [
          { id: "p_0001", name: "alpha", root: dir, pinnedFile: null, createdAt: 1, updatedAt: 2 },
        ],
      };
      writeProjects(file, input);
      const loaded = readProjects(file);
      expect(loaded).toEqual(input);
    } finally {
      cleanup();
    }
  });

  it("heals a set where activeId doesn't match any project", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          activeId: "p_missing",
          projects: [{ id: "p_0001", name: "alpha", root: dir, pinnedFile: null, createdAt: 0, updatedAt: 0 }],
        }),
      );
      const set = readProjects(file);
      expect(set.activeId).toBe("p_0001");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------
describe("assertWithinAllowList", () => {
  it("passes when root is under an allowed base", () => {
    const base = tmpdir();
    const nested = join(base, "sub", "project");
    expect(() => assertWithinAllowList(nested, [base])).not.toThrow();
  });

  it("passes for exact match with allow-list base", () => {
    const base = tmpdir();
    expect(() => assertWithinAllowList(base, [base])).not.toThrow();
  });

  it("throws OUTSIDE_ALLOWLIST for unrelated path", () => {
    const tmp = tmpdir();
    // Use a clearly different base that doesn't contain tmp
    const unrelatedBase = "/this-path-does-not-exist-test-sentinel";
    expect(() => assertWithinAllowList(tmp, [unrelatedBase])).toThrow(/outside allowed/);
  });
});

// ---------------------------------------------------------------------------
// addProject
// ---------------------------------------------------------------------------
describe("addProject", () => {
  it("adds a project and makes it reachable via listProjects", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const p = addProject({ name: "test", root: dir, allowList: [tmpdir()] }, file);
      expect(p.name).toBe("test");
      expect(p.root).toBe(dir);
      expect(p.id).toMatch(/^p_/);
      const list = listProjects(file);
      // default + new
      expect(list.some((x) => x.id === p.id)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects duplicate name (case-insensitive)", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      addProject({ name: "Alpha", root: dir, allowList: [tmpdir()] }, file);
      expect(() =>
        addProject({ name: "alpha", root: dir, allowList: [tmpdir()] }, file),
      ).toThrow(/already in use/);
    } finally {
      cleanup();
    }
  });

  it("rejects root outside allow-list", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      expect(() =>
        addProject({ name: "x", root: dir, allowList: ["/nonexistent-base-sentinel"] }, file),
      ).toThrow(/outside allowed/);
    } finally {
      cleanup();
    }
  });

  it("rejects traversal in pinnedFile", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      expect(() =>
        addProject({ name: "x", root: dir, pinnedFile: "../escape.ts", allowList: [tmpdir()] }, file),
      ).toThrow(/escapes/);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// setActiveProject
// ---------------------------------------------------------------------------
describe("setActiveProject", () => {
  it("switches the active project", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const p = addProject({ name: "second", root: dir, allowList: [tmpdir()] }, file);
      setActiveProject(p.id, file);
      expect(getActiveProject(file).id).toBe(p.id);
    } finally {
      cleanup();
    }
  });

  it("throws NOT_FOUND for unknown id", () => {
    const { file, cleanup } = tmpStore();
    try {
      expect(() => setActiveProject("p_unknown", file)).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// removeProject
// ---------------------------------------------------------------------------
describe("removeProject", () => {
  it("removes a non-active project", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const p = addProject({ name: "extra", root: dir, allowList: [tmpdir()] }, file);
      removeProject(p.id, file);
      expect(listProjects(file).some((x) => x.id === p.id)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reassigns activeId to first remaining when active is removed", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const second = addProject({ name: "second", root: dir, allowList: [tmpdir()] }, file);
      setActiveProject(second.id, file);
      removeProject(second.id, file);
      const active = getActiveProject(file);
      expect(active.id).not.toBe(second.id);
    } finally {
      cleanup();
    }
  });

  it("refuses to remove the last project", () => {
    const { file, cleanup } = tmpStore();
    try {
      const only = getActiveProject(file);
      expect(() => removeProject(only.id, file)).toThrow(/last project/);
    } finally {
      cleanup();
    }
  });

  it("throws NOT_FOUND for unknown id", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      addProject({ name: "extra", root: dir, allowList: [tmpdir()] }, file);
      expect(() => removeProject("p_unknown", file)).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// setPinnedFile
// ---------------------------------------------------------------------------
describe("setPinnedFile", () => {
  it("sets and clears a pinned file", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const p = addProject({ name: "pintest", root: dir, allowList: [tmpdir()] }, file);
      setPinnedFile(p.id, "src/index.ts", file);
      expect(listProjects(file).find((x) => x.id === p.id)!.pinnedFile).toBe("src/index.ts");
      setPinnedFile(p.id, null, file);
      expect(listProjects(file).find((x) => x.id === p.id)!.pinnedFile).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("rejects traversal in pinnedFile path", () => {
    const { dir, file, cleanup } = tmpStore();
    try {
      const p = addProject({ name: "pintest", root: dir, allowList: [tmpdir()] }, file);
      expect(() => setPinnedFile(p.id, "../../etc/passwd", file)).toThrow(/escapes/);
    } finally {
      cleanup();
    }
  });

  it("throws NOT_FOUND for unknown project", () => {
    const { file, cleanup } = tmpStore();
    try {
      expect(() => setPinnedFile("p_unknown", "file.ts", file)).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });
});
