import { describe, expect, test } from "bun:test";
import { deltaPromptAddon, hashDiff } from "../src/delta";
import type { Verdict } from "../src/verdict";

const verdict = (ids: string[]): Verdict => ({
  status: "changes_requested",
  summary: "s",
  intent: "i",
  findings: ids.map((id) => ({
    id,
    severity: "should-fix",
    kind: "bug",
    title: "t",
    why: "w",
    where: "a.ts:1",
    action: "fix",
    hunk_id: null,
    from: null,
    to: null,
    status: "open",
  })),
  questions: [],
  humanNotes: "",
  backend: "test",
});

describe("delta", () => {
  test("hashDiff is stable", () => {
    expect(hashDiff("a")).toBe(hashDiff("a"));
    expect(hashDiff("a")).not.toBe(hashDiff("b"));
  });

  test("deltaPromptAddon empty without prior", () => {
    expect(deltaPromptAddon(null, "abc")).toBe("");
  });

  test("deltaPromptAddon mentions prior open ids", () => {
    const text = deltaPromptAddon(
      {
        diffHash: "old",
        savedAt: "2026-01-01T00:00:00.000Z",
        verdict: verdict(["F1", "F2"]),
        openFindingIds: ["F1", "F2"],
      },
      "new",
    );
    expect(text).toContain("F1");
    expect(text).toContain("Delta re-review");
  });
});
