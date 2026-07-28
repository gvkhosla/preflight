import { describe, expect, test } from "bun:test";
import type { Analysis } from "../src/analysis";
import { buildVerdict, classifyFindingLifecycle, formatVerdictJson, formatVerdictText } from "../src/verdict";

const base: Analysis = {
  title: "Safer greet",
  summary: "Reject blank names.",
  intent: "Avoid empty greetings.",
  sections: [],
  findings: [
    {
      id: "F1",
      severity: "blocker",
      kind: "bug",
      title: "Throws uncaught",
      why: "API will 500",
      where: "src/greet.ts:2",
      action: "Return Result instead of throw",
      hunk_id: "h1",
      from: 2,
      to: 3,
    },
    {
      id: "F2",
      severity: "nit",
      kind: "style",
      title: "Wording",
      why: "Message tone",
      where: "src/greet.ts:2",
      action: "Rephrase error",
      hunk_id: null,
      from: null,
      to: null,
    },
  ],
  questions: ["Should blank name be 400?"],
};

describe("buildVerdict", () => {
  test("auto marks changes_requested on blockers", () => {
    const v = buildVerdict(base, "anthropic");
    expect(v.status).toBe("changes_requested");
  });

  test("human approve force wins", () => {
    const v = buildVerdict(base, "anthropic", {
      forceStatus: "approved",
      humanNotes: "ship it",
      findingDecisions: {},
    });
    expect(v.status).toBe("approved");
    expect(v.humanNotes).toBe("ship it");
  });

  test("dismissing actionable findings can approve", () => {
    const v = buildVerdict(base, "pi", {
      humanNotes: "",
      findingDecisions: {
        F1: { status: "dismissed", note: "intentional" },
        F2: { status: "accepted" },
      },
    });
    expect(v.status).toBe("approved");
    expect(formatVerdictText(v)).toContain("APPROVED");
    expect(formatVerdictText(v)).not.toContain("F1 [");
  });

  test("repository check failures are authoritative over human approval", () => {
    const v = buildVerdict(
      { ...base, findings: [] },
      "test",
      { findingDecisions: {}, humanNotes: "", forceStatus: "approved" },
      {
        verification: {
          status: "failed",
          summary: "1 check failed.",
          details: [],
          failedChecks: ["package:.:test"],
          checks: [
            {
              id: "package:.:test",
              name: "test",
              command: ["npm", "test"],
              cwd: ".",
              source: "package-script",
              status: "failed",
              exitCode: 1,
            },
          ],
        },
      },
    );
    expect(v.status).toBe("changes_requested");
  });

  test("classifies persisting, new, and resolved findings", () => {
    const prior = buildVerdict({ ...base, findings: [base.findings[0]] }, "test");
    const current = [
      { ...base.findings[0], title: "Throws uncaught in API", where: "src/greet.ts:3" },
      { ...base.findings[0], id: "F2", title: "New regression", where: "src/other.ts:4" },
    ];
    const classified = classifyFindingLifecycle(current, prior);
    expect(classified.lifecycle.map((item) => item.state)).toEqual(["persisting", "new"]);
    expect(classified.resolved).toHaveLength(0);

    const resolved = classifyFindingLifecycle([], prior);
    expect(resolved.resolved[0].title).toBe("Throws uncaught");
  });

  test("json includes agreement metadata when provided", () => {
    const v = buildVerdict(base, "anthropic+codex", undefined, {
      judges: ["anthropic", "codex"],
      agreementSummary: "2 judge(s), 1 merged finding(s), 1 high-agreement",
      merged: [
        {
          ...base.findings[0],
          grounded: true,
          agreement: "2/2",
          judges: ["anthropic", "codex"],
          confidence: "high",
        },
      ],
    });
    const json = JSON.parse(formatVerdictJson(v));
    expect(json.findings[0].agreement).toBe("2/2");
    expect(json.judges).toEqual(["anthropic", "codex"]);
  });
});
