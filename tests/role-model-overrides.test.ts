import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAllRoleModelOverrides,
  readRoleModelOverride,
  writeRoleModelOverride,
  clearRoleModelOverride,
  readReasoningModelOverride,
  DEFAULT_OPENROUTER_REASONING_MODEL,
} from "../src/models/reasoning-model-overrides.js";

describe("per-role model overrides", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function overridePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "multi-agent-roleovr-"));
    dirs.push(dir);
    return join(dir, "model-overrides.json");
  }

  it("returns no override for a role with nothing saved", () => {
    expect(readRoleModelOverride("action-code", overridePath())).toBeNull();
    expect(readAllRoleModelOverrides(overridePath())).toEqual({});
  });

  it("persists, reads, and clears a per-role provider + model", () => {
    const path = overridePath();
    const saved = writeRoleModelOverride(
      "action-code",
      { provider: "nvidia", model: "qwen/qwen2.5-coder-32b-instruct", name: "Qwen Coder" },
      path,
    );
    expect(saved.provider).toBe("nvidia");
    expect(saved.model).toBe("qwen/qwen2.5-coder-32b-instruct");

    const read = readRoleModelOverride("action-code", path);
    expect(read?.provider).toBe("nvidia");
    expect(read?.model).toBe("qwen/qwen2.5-coder-32b-instruct");

    clearRoleModelOverride("action-code", path);
    expect(readRoleModelOverride("action-code", path)).toBeNull();
  });

  it("keeps multiple role overrides independent", () => {
    const path = overridePath();
    writeRoleModelOverride("reasoning", { provider: "openrouter", model: "a/b:free" }, path);
    writeRoleModelOverride("action-structural", { provider: "groq", model: "llama-3.3-70b-versatile" }, path);

    const all = readAllRoleModelOverrides(path);
    expect(all.reasoning?.provider).toBe("openrouter");
    expect(all["action-structural"]?.provider).toBe("groq");
    expect(all["action-code"]).toBeUndefined();
  });

  it("rejects unknown providers and non-customisable roles on read", () => {
    const path = overridePath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        roles: {
          reasoning: { provider: "totally-made-up", model: "x" },
          perception: { provider: "gemini", model: "y" },
          "action-code": { provider: "mistral", model: "mistral-large-latest" },
        },
      }),
      "utf8",
    );
    const all = readAllRoleModelOverrides(path);
    expect(all.reasoning).toBeUndefined(); // invalid provider dropped
    expect((all as Record<string, unknown>).perception).toBeUndefined(); // not customisable
    expect(all["action-code"]?.provider).toBe("mistral");
  });

  it("migrates a v1 reasoning-only file to the v2 role map", () => {
    const path = overridePath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        reasoning: { provider: "openrouter", model: "general/strong-chat:free", name: "Strong Chat" },
      }),
      "utf8",
    );

    // Generalized read sees it as roles.reasoning.
    expect(readRoleModelOverride("reasoning", path)?.model).toBe("general/strong-chat:free");

    // Back-compat reasoning shim still works against the migrated value.
    const legacy = readReasoningModelOverride(path);
    expect(legacy.model).toBe("general/strong-chat:free");
    expect(legacy.isDefault).toBe(false);
  });

  it("back-compat reasoning shim ignores a non-OpenRouter reasoning override", () => {
    const path = overridePath();
    writeRoleModelOverride("reasoning", { provider: "nvidia", model: "meta/llama-3.3-70b-instruct" }, path);
    // The OpenRouter-only legacy surface can't represent NVIDIA, so it reports default.
    const legacy = readReasoningModelOverride(path);
    expect(legacy.model).toBe(DEFAULT_OPENROUTER_REASONING_MODEL);
    expect(legacy.isDefault).toBe(true);
    // The generalized read still returns the real NVIDIA selection.
    expect(readRoleModelOverride("reasoning", path)?.provider).toBe("nvidia");
  });
});
