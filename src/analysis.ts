import { z } from "zod";

export const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["blocker", "should-fix", "nit"]),
  kind: z.enum([
    "bug",
    "regression",
    "security",
    "missing-test",
    "api-break",
    "perf",
    "style",
    "incomplete",
    "other",
  ]),
  title: z.string(),
  why: z.string(),
  where: z.string(),
  action: z.string(),
  hunk_id: z.string().nullable(),
  from: z.number().nullable(),
  to: z.number().nullable(),
});

export const JudgeSchema = z.object({
  findings: z.array(FindingSchema),
  questions: z.array(z.string()),
});

export const ExplainSchema = z.object({
  title: z.string(),
  summary: z.string(),
  intent: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      intro: z.string(),
      snippets: z.array(
        z.object({
          hunk_id: z.string(),
          from: z.number().nullable(),
          to: z.number().nullable(),
          note: z.string(),
        }),
      ),
    }),
  ),
});

/** Final report shape used by UI/verdict. */
export const AnalysisSchema = z.object({
  title: z.string(),
  summary: z.string(),
  intent: z.string(),
  sections: ExplainSchema.shape.sections,
  findings: z.array(FindingSchema),
  questions: z.array(z.string()),
});

export type Finding = z.infer<typeof FindingSchema>;
export type JudgeResult = z.infer<typeof JudgeSchema>;
export type ExplainResult = z.infer<typeof ExplainSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface AnalysisResult {
  backend: string;
  analysis: Analysis;
  judges?: string[];
  agreementSummary?: string;
}

export interface ContextPack {
  intentHints: string;
  recall: string;
}

function contextBlock(ctx: ContextPack): string {
  return [
    ctx.intentHints.trim() && `## Intent hints (from git/branch)\n${ctx.intentHints.trim()}`,
    ctx.recall.trim() && `## Precedent from local memory (pickbrain)\n${ctx.recall.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Judge-only prompt: findings, no walkthrough. */
export function judgePrompt(annotatedDiff: string, ctx: ContextPack): string {
  const ctxText = contextBlock(ctx);
  return `You are a strict code-change judge for a local ship gate. Your ONLY job is judgment quality.

Do NOT write a walkthrough or tutorial. Find real ship risks in the diff. Prefer silence over invented issues.

Each hunk is labeled "hunk hN". Lines look like "42|+code" (new file line) or "-17|-code" (deleted old line).

${ctxText ? ctxText + "\n\n" : ""}Return ONLY a JSON object:
{
  "findings": [
    {
      "id": "F1",
      "severity": "blocker" | "should-fix" | "nit",
      "kind": "bug" | "regression" | "security" | "missing-test" | "api-break" | "perf" | "style" | "incomplete" | "other",
      "title": "short title",
      "why": "why this matters before shipping",
      "where": "path:line or concise location",
      "action": "exact fix an agent should perform",
      "hunk_id": "h3" or null,
      "from": 40 or null,
      "to": 48 or null
    }
  ],
  "questions": ["only if a product/intent decision blocks judgment"]
}

Severity:
- blocker: wrong behavior, security, data loss, broken API, incomplete critical path
- should-fix: missing tests on risky branches, inconsistency, likely regression
- nit: pure taste/style

Rules:
- Max 12 findings. Empty findings is valid when clean.
- Every finding needs concrete where + action.
- hunk_id/from/to must point at real diff lines when possible; else nulls.
- Do NOT invent bugs. If unsure, omit or ask a question.
- If precedent memory shows a past incident that matches, cite it in why.
- No markdown fences, no commentary, JSON only.

The diff:

${annotatedDiff}`;
}

/** Explainer-only prompt: story for humans, no judgment. */
export function explainPrompt(annotatedDiff: string, ctx: ContextPack, findingsSummary: string): string {
  const ctxText = contextBlock(ctx);
  return `You write a brief ship-readiness walkthrough for a human. Do NOT re-litigate findings; judgment is already done.

Each hunk is labeled "hunk hN". Lines look like "42|+code" or "-17|-code".

${ctxText ? ctxText + "\n\n" : ""}## Already-decided findings (for orientation only)
${findingsSummary || "(none)"}

Return ONLY a JSON object:
{
  "title": "short title",
  "summary": "≤40 words: what changed and why it matters",
  "intent": "one sentence: what this change appears to try to do",
  "sections": [
    {
      "heading": "...",
      "intro": "1-2 sentences",
      "snippets": [
        { "hunk_id": "h3", "from": 40, "to": 48, "note": "short bridge or \\"\\"" }
      ]
    }
  ]
}

Rules:
- Max 5 sections. Snippets typically 3-12 lines.
- Group by concern, not file. Core change first.
- Mechanical noise gets at most one summary sentence.
- No findings array. No severity opinions.
- JSON only, no fences.

The diff:

${annotatedDiff}`;
}

/** @deprecated kept for simple single-pass fallback tests */
export function analysisPrompt(annotatedDiff: string, ctx: ContextPack): string {
  return judgePrompt(annotatedDiff, ctx);
}

export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error(`no JSON object found in output:\n${raw.slice(0, 500)}`);
    text = text.slice(start, end + 1);
  }
  return JSON.parse(text);
}

export function extractJudge(raw: string): JudgeResult {
  return JudgeSchema.parse(extractJsonObject(raw));
}

export function extractExplain(raw: string): ExplainResult {
  return ExplainSchema.parse(extractJsonObject(raw));
}

export function extractAnalysis(raw: string): Analysis {
  // Back-compat: full analysis or judge-only payloads.
  const obj = extractJsonObject(raw) as Record<string, unknown>;
  if (obj.findings && !obj.title) {
    const judge = JudgeSchema.parse(obj);
    return {
      title: "Change review",
      summary: judge.findings.length ? `${judge.findings.length} finding(s) to review.` : "No findings.",
      intent: "",
      sections: [],
      findings: judge.findings,
      questions: judge.questions,
    };
  }
  return AnalysisSchema.parse(obj);
}

export function autoStatus(analysis: Analysis): "approved" | "changes_requested" {
  return analysis.findings.some((f) => f.severity === "blocker" || f.severity === "should-fix")
    ? "changes_requested"
    : "approved";
}

export function findingsSummaryForExplain(findings: Finding[]): string {
  if (!findings.length) return "(none)";
  return findings
    .map((f) => `- ${f.id} [${f.severity}/${f.kind}] ${f.title} @ ${f.where}: ${f.action}`)
    .join("\n");
}
