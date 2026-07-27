import { describe, expect, test } from "bun:test";
import { buildVerdict, formatVerdictText } from "../src/verdict";
import type { Analysis } from "../src/analysis";

const clean: Analysis = {
  title: "t",
  summary: "clean change",
  intent: "refactor",
  sections: [],
  findings: [],
  questions: [],
};

describe("formatVerdictText", () => {
  test("approves clean analysis", () => {
    const text = formatVerdictText(buildVerdict(clean, "claude"));
    expect(text).toContain("APPROVED");
    expect(text).toContain("Findings: none");
  });
});
