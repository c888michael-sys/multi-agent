import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("CLI diagnose-routing", () => {
  it("does not create persistent usage state during config-only diagnostics", () => {
    const home = mkdtempSync(join(tmpdir(), "multi-agent-diagnose-home-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          "src/cli.ts",
          "diagnose-routing",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            OPENROUTER_KEY: "test-openrouter",
            GEMINI_KEY_1: "test-gemini-1",
            GEMINI_KEY_2: "test-gemini-2",
            GEMINI_KEY_3: "test-gemini-3",
            // Keep this cheap and deterministic even if the developer has a
            // real Ollama daemon on localhost.
            OLLAMA_HOST: "http://127.0.0.1:9",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("reasoning");
      expect(result.stdout).toContain("openrouter:reasoning");
      expect(result.stderr).not.toContain("[state] failed to write");
      expect(existsSync(join(home, ".multi-agent", "state.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
