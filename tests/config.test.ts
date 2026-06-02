import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllProviderConfigsFromEnv } from "../src/config.js";
import { writeReasoningModelOverride } from "../src/models/reasoning-model-overrides.js";

const ENV_KEYS = [
  "GEMINI_KEY_1",
  "GEMINI_KEY_2",
  "GEMINI_KEY_3",
  "GROQ_KEY",
  "OPENROUTER_KEY",
  "CEREBRAS_KEY",
  "MISTRAL_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetProviderEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("provider config defaults", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetProviderEnv();
    delete process.env.MULTI_AGENT_MODEL_OVERRIDES;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses a stable OpenRouter reasoning provider id", () => {
    resetProviderEnv();
    process.env.OPENROUTER_KEY = "test-openrouter";

    const config = loadAllProviderConfigsFromEnv().find(
      (entry) => entry.provider.id === "openrouter:reasoning",
    );

    expect(config).toBeDefined();
    expect(config!.provider.model).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    expect(config!.estimatedDailyBudget).toBe(50);
    expect(config!.estimatedRpmCap).toBe(20);
  });

  it("loads the selected OpenRouter reasoning model from the override file", () => {
    resetProviderEnv();
    process.env.OPENROUTER_KEY = "test-openrouter";
    const dir = mkdtempSync(join(tmpdir(), "multi-agent-config-"));
    tempDirs.push(dir);
    process.env.MULTI_AGENT_MODEL_OVERRIDES = join(dir, "models.json");
    writeReasoningModelOverride(process.env.MULTI_AGENT_MODEL_OVERRIDES, {
      model: "general/strong-chat:free",
      name: "Strong Chat",
      contextLength: 131072,
      reasoningCapable: false,
    });

    const config = loadAllProviderConfigsFromEnv().find(
      (entry) => entry.provider.id === "openrouter:reasoning",
    );

    expect(config).toBeDefined();
    expect(config!.provider.model).toBe("general/strong-chat:free");
  });
});
