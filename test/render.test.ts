import { describe, expect, test } from "bun:test";
import { renderReport } from "../src/render";

const failedVerification = {
  status: "failed" as const,
  summary: "1 of 1 repository checks failed.",
  details: [],
  failedChecks: ["package:.:test"],
  checks: [
    {
      id: "package:.:test",
      name: "test",
      command: ["npm", "test"],
      cwd: ".",
      source: "package-script" as const,
      status: "failed" as const,
      exitCode: 1,
      durationMs: 25,
      output: "1 test failed",
    },
  ],
};

describe("renderReport", () => {
  test("shows authoritative verification evidence and removes approval controls on failure", async () => {
    const html = await renderReport(
      {
        backend: "pi",
        judges: ["pi"],
        agreementSummary: "1 judge(s), 0 merged finding(s), 0 high-agreement",
        mergedFindings: [],
        verification: failedVerification,
        analysis: {
          title: "Change review",
          summary: "Updated behavior.",
          intent: "Improve behavior.",
          sections: [],
          findings: [],
          questions: [],
        },
      },
      [],
      false,
    );

    expect(html).toContain("Repository checks");
    expect(html).toContain("1 test failed");
    expect(html).toContain("Repository checks must pass before approval.");
    expect(html).not.toContain('id="approve"');
  });
});
