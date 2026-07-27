import { describe, expect, test } from "bun:test";
import { autoStatus, extractAnalysis, extractJudge } from "../src/analysis";

const JUDGE = JSON.stringify({
  findings: [
    {
      id: "F1",
      severity: "should-fix",
      kind: "missing-test",
      title: "No test for blank name",
      why: "New throw path is untested",
      where: "src/greet.ts:2",
      action: "Add a unit test for blank name",
      hunk_id: "h1",
      from: 2,
      to: 3,
    },
  ],
  questions: [],
});

const FULL = JSON.stringify({
  title: "t",
  summary: "s",
  intent: "make greet safer",
  sections: [
    {
      heading: "h",
      intro: "i",
      snippets: [{ hunk_id: "h1", from: 2, to: 4, note: "" }],
    },
  ],
  findings: JSON.parse(JUDGE).findings,
  questions: [],
});

describe("extractJudge", () => {
  test("parses judge payload", () => {
    expect(extractJudge(JUDGE).findings[0].id).toBe("F1");
  });

  test("strips fences", () => {
    expect(extractJudge("```json\n" + JUDGE + "\n```").findings).toHaveLength(1);
  });
});

describe("extractAnalysis", () => {
  test("parses full analysis", () => {
    expect(extractAnalysis(FULL).title).toBe("t");
  });

  test("promotes judge-only payload", () => {
    const a = extractAnalysis(JUDGE);
    expect(a.findings[0].id).toBe("F1");
    expect(a.title).toBeTruthy();
  });

  test("throws when there is no JSON at all", () => {
    expect(() => extractAnalysis("I cannot analyze this diff.")).toThrow("no JSON object found");
  });
});

describe("autoStatus", () => {
  test("requests changes for should-fix findings", () => {
    expect(autoStatus(extractAnalysis(FULL))).toBe("changes_requested");
  });

  test("approves when empty findings", () => {
    const clean = extractAnalysis(
      JSON.stringify({
        title: "t",
        summary: "s",
        intent: "i",
        sections: [],
        findings: [],
        questions: [],
      }),
    );
    expect(autoStatus(clean)).toBe("approved");
  });
});
