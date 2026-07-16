import { describe, expect, it } from "vitest";
import { finalOutputLeakReason } from "../src/agents/output-integrity.js";

describe("final output integrity", () => {
  it("rejects unmistakable formatter prompt leakage", () => {
    expect(finalOutputLeakReason("As the formatter agent, I will reformat the Final action outputs:\n<<<action-code\ninternal prompt\n>>>"))
      .toContain("internal workflow");
  });

  it("does not reject a normal answer that mentions an agent once", () => {
    expect(finalOutputLeakReason("The action-structural agent is useful for tables, but this is the final answer.")).toBeNull();
  });
});
