import { describe, expect, test } from "bun:test";
import type { Analysis } from "../src/analysis";
import { buildVerdict, formatVerdictJson, formatVerdictText } from "../src/verdict";

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
