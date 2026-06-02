import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

describe("CLI models command", () => {
  it("sets and resets the reasoning OpenRouter model from the cached free-model list", () => {
    const dir = mkdtempSync(join(tmpdir(), "multi-agent-cli-models-"));
    try {
      const overrides = join(dir, "model-overrides.json");
      const cache = join(dir, "openrouter-free-models.json");
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(
        cache,
        JSON.stringify(
          {
            version: 1,
            fetchedAt: Date.now(),
            models: [
              {
                id: "general/strong-chat:free",
                name: "Strong Chat",
                contextLength: 131072,
                created: 2,
                reasoningCapable: false,
              },
            ],
          },
          null,
          2,
        ),
      );
      const env = {
        MULTI_AGENT_MODEL_OVERRIDES: overrides,
        MULTI_AGENT_OPENROUTER_MODELS_CACHE: cache,
        OPENROUTER_KEY: "test-openrouter",
      };

      const set = runCli(["models", "reasoning", "set", "general/strong-chat:free"], env);
      expect(set.status).toBe(0);
      expect(set.stdout).toContain("general/strong-chat:free");

      const get = runCli(["models", "reasoning", "get"], env);
      expect(get.status).toBe(0);
      expect(get.stdout).toContain("general/strong-chat:free");

      const reset = runCli(["models", "reasoning", "reset"], env);
      expect(reset.status).toBe(0);
      expect(reset.stdout).toContain("qwen/qwen3-next-80b-a3b-instruct:free");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
