import { describe, expect, test } from "bun:test";
import { mergeJudgeBundles } from "../src/merge";
import type { GroundedFinding } from "../src/ground";

const f = (over: Partial<GroundedFinding> = {}): GroundedFinding => ({
  id: "F1",
  severity: "blocker",
  kind: "bug",
  title: "Double charge on retry",
  why: "idempotency missing",
  where: "stripe.ts:88",
  action: "key by payment intent",
  hunk_id: "h1",
  from: 88,
  to: 100,
  grounded: true,
  ...over,
});

describe("mergeJudgeBundles", () => {
  test("single judge passes through", () => {
    const { findings, summary } = mergeJudgeBundles([
      { backend: "anthropic", findings: [f()], questions: [] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].agreement).toBe("1/1");
    expect(summary).toContain("1 judge");
  });

  test("agrees and keeps high confidence blocker", () => {
    const { findings } = mergeJudgeBundles([
      { backend: "anthropic", findings: [f({ id: "A1" })], questions: [] },
      {
        backend: "codex",
        findings: [f({ id: "B1", title: "Retry can double charge", why: "no idempotency key" })],
        questions: [],
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].agreement).toBe("2/2");
    expect(findings[0].confidence).toBe("high");
    expect(findings[0].severity).toBe("blocker");
  });

  test("lone blocker with two judges is downgraded", () => {
    const { findings } = mergeJudgeBundles([
      { backend: "anthropic", findings: [f({ id: "A1" })], questions: [] },
      { backend: "codex", findings: [], questions: [] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("should-fix");
    expect(findings[0].confidence).toBe("low");
  });

  test("drops lone nits under multi-judge", () => {
    const { findings } = mergeJudgeBundles([
      {
        backend: "anthropic",
        findings: [f({ id: "A1", severity: "nit", kind: "style", title: "rename var" })],
        questions: [],
      },
      { backend: "codex", findings: [], questions: [] },
    ]);
    expect(findings).toHaveLength(0);
  });

  test("unions questions", () => {
    const { questions } = mergeJudgeBundles([
      { backend: "a", findings: [], questions: ["Ship without feature flag?"] },
      { backend: "b", findings: [], questions: ["Ship without feature flag?", "Also mobile?"] },
    ]);
    expect(questions).toEqual(["Ship without feature flag?", "Also mobile?"]);
  });
});
