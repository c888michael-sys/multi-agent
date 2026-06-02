import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_REASONING_MODEL,
  readReasoningModelOverride,
  resetReasoningModelOverride,
  writeReasoningModelOverride,
} from "../src/models/reasoning-model-overrides.js";

describe("reasoning model overrides", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function overridePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "multi-agent-models-"));
    dirs.push(dir);
    return join(dir, "model-overrides.json");
  }

  it("defaults to the Qwen3-Next free OpenRouter model when no override exists", () => {
    const current = readReasoningModelOverride(overridePath());

    expect(current.model).toBe(DEFAULT_OPENROUTER_REASONING_MODEL);
    expect(current.isDefault).toBe(true);
  });

  it("persists and resets the OpenRouter reasoning model", () => {
    const path = overridePath();

    const written = writeReasoningModelOverride(path, {
      model: "general/strong-chat:free",
      name: "Strong Chat",
      contextLength: 131072,
      reasoningCapable: false,
    });

    expect(written.model).toBe("general/strong-chat:free");
    expect(readReasoningModelOverride(path).model).toBe("general/strong-chat:free");

    const reset = resetReasoningModelOverride(path);
    expect(reset.model).toBe(DEFAULT_OPENROUTER_REASONING_MODEL);
    expect(reset.isDefault).toBe(true);
  });
});
