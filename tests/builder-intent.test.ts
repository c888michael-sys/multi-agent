import { describe, expect, it } from "vitest";
import { normalizeBuilderMode, resolveBuilderIntent } from "../src/web/builder-intent.js";

describe("Builder intent routing", () => {
  it("automatically enables Builder for a website creation request", () => {
    expect(resolveBuilderIntent({ mode: "auto", intentText: "Build me a website of your choice. Showcase your skill." })).toMatchObject({
      active: true,
      source: "auto",
      requiresStagedFile: true,
      historyScope: "turn",
      qualityProfile: "creative-web",
    });
  });

  it("keeps a deliberately simple or specifically directed build on the normal completion contract", () => {
    expect(resolveBuilderIntent({ mode: "auto", intentText: "Build a simple single-file website" }).qualityProfile).toBeUndefined();
    expect(resolveBuilderIntent({ mode: "auto", intentText: "Build a website for my cafe with a menu and booking form" }).qualityProfile).toBeUndefined();
  });

  it("does not mistake a request for an explanation or plan for a build", () => {
    expect(resolveBuilderIntent({ mode: "auto", intentText: "Explain how to build a portfolio website" }).active).toBe(false);
    expect(resolveBuilderIntent({ mode: "auto", intentText: "Plan a landing page" }).active).toBe(false);
  });

  it("honours explicit Builder mode and explicit non-code role choices", () => {
    expect(resolveBuilderIntent({ mode: "always", intentText: "write an answer", forceRole: "reasoning" }).active).toBe(true);
    expect(resolveBuilderIntent({ mode: "auto", intentText: "create a website", forceRole: "reasoning" }).active).toBe(false);
  });

  it("migrates the legacy flag without making old false settings permanently disable auto", () => {
    expect(normalizeBuilderMode(undefined, true)).toBe("always");
    expect(normalizeBuilderMode(undefined, false)).toBe("off");
    expect(normalizeBuilderMode(undefined)).toBe("auto");
  });
});
