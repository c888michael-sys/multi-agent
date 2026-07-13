import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRoleInstructions,
  formatRoleInstructionsForRole,
  readRoleInstructions,
  writeRoleInstructions,
} from "../src/roles/instructions.js";

describe("role instructions storage", () => {
  it("creates a complete recommended quality instruction set by default", () => {
    const defaults = defaultRoleInstructions();
    expect(defaults.version).toBe(1);
    expect(defaults.global).toContain("rigorous expert collaborator");
    expect(Object.keys(defaults.roles).sort()).toEqual([
      "action-code",
      "action-repetitive",
      "action-structural",
      "mindmap-categorize",
      "orchestration",
      "perception",
      "reasoning",
    ]);
    for (const text of Object.values(defaults.roles)) {
      expect(text.trim().length).toBeGreaterThan(40);
    }
    expect(defaults.roles["action-code"]).toContain("Never claim");
    expect(defaults.roles["mindmap-categorize"]).toContain("valid JSON only");
  });

  it("returns a fresh preset copy so user edits cannot mutate the canonical defaults", () => {
    const first = defaultRoleInstructions();
    first.global = "custom";
    first.roles.reasoning = "custom";

    const second = defaultRoleInstructions();
    expect(second.global).toContain("rigorous expert collaborator");
    expect(second.roles.reasoning).not.toBe("custom");
  });

  it("normalizes partial JSON read from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-instructions-"));
    const file = join(dir, "instructions.json");
    try {
      writeRoleInstructions(file, {
        version: 1,
        global: "Use concise prose.",
        roles: { reasoning: "State assumptions first." },
      });

      const loaded = readRoleInstructions(file);
      expect(loaded.global).toBe("Use concise prose.");
      expect(loaded.roles.reasoning).toBe("State assumptions first.");
      expect(loaded.roles.perception).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes pretty JSON that can be edited directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-instructions-"));
    const file = join(dir, "nested", "instructions.json");
    try {
      writeRoleInstructions(file, {
        version: 1,
        global: "Keep answers practical.",
        roles: { "action-code": "Prefer TypeScript." },
      });

      const raw = readFileSync(file, "utf8");
      expect(raw).toContain("\n  \"global\": \"Keep answers practical.\"");
      expect(JSON.parse(raw).roles["action-code"]).toBe("Prefer TypeScript.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats only relevant global and role-scoped instructions", () => {
    const text = formatRoleInstructionsForRole("perception", {
      version: 1,
      global: "Use Australian English.",
      roles: {
        perception: "Cite sources.",
        reasoning: "Check assumptions.",
      },
    });

    expect(text).toContain("Global instructions");
    expect(text).toContain("Use Australian English.");
    expect(text).toContain("Role-specific instructions for perception");
    expect(text).toContain("Cite sources.");
    expect(text).not.toContain("Check assumptions.");
  });
});
