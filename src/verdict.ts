import { autoStatus, type Analysis, type Finding } from "./analysis";
import type { MergedFinding } from "./merge";

export interface VerdictFinding extends Finding {
  status: "open" | "accepted" | "dismissed";
  note?: string;
  agreement?: string;
  confidence?: "high" | "medium" | "low";
  judges?: string[];
}

export interface Verdict {
  status: "approved" | "changes_requested";
  summary: string;
  intent: string;
  findings: VerdictFinding[];
  questions: string[];
  humanNotes: string;
  backend: string;
  judges?: string[];
  agreementSummary?: string;
}

export interface HumanDecision {
  findingDecisions: Record<string, { status: "accepted" | "dismissed"; note?: string }>;
  humanNotes: string;
  forceStatus?: "approved" | "changes_requested";
}

export function buildVerdict(
  analysis: Analysis,
  backend: string,
  decision?: HumanDecision,
  meta?: { judges?: string[]; agreementSummary?: string; merged?: MergedFinding[] },
): Verdict {
  const mergedById = new Map((meta?.merged ?? []).map((m) => [m.id, m]));

  const findings: VerdictFinding[] = analysis.findings.map((f) => {
    const d = decision?.findingDecisions[f.id];
    const m = mergedById.get(f.id);
    return {
      ...f,
      status: d?.status ?? "open",
      note: d?.note,
      agreement: m?.agreement,
      confidence: m?.confidence,
      judges: m?.judges,
    };
  });

  let status: "approved" | "changes_requested";
  if (decision?.forceStatus) {
    status = decision.forceStatus;
  } else if (decision) {
    const actionable = findings.filter(
      (f) => f.status !== "dismissed" && (f.severity === "blocker" || f.severity === "should-fix"),
    );
    status = actionable.length > 0 ? "changes_requested" : "approved";
  } else {
    status = autoStatus(analysis);
  }

  return {
    status,
    summary: analysis.summary,
    intent: analysis.intent,
    findings,
    questions: analysis.questions,
    humanNotes: decision?.humanNotes ?? "",
    backend,
    judges: meta?.judges,
    agreementSummary: meta?.agreementSummary,
  };
}

export function formatVerdictText(v: Verdict): string {
  const lines: string[] = [];
  lines.push(`Preflight: ${v.status === "approved" ? "APPROVED" : "CHANGES REQUESTED"}`);
  lines.push("");
  lines.push(`Summary: ${v.summary}`);
  if (v.intent) lines.push(`Intent: ${v.intent}`);
  if (v.agreementSummary) lines.push(`Judges: ${v.agreementSummary}`);

  const open = v.findings.filter((f) => f.status !== "dismissed");
  if (open.length === 0) {
    lines.push("", "Findings: none");
  } else {
    lines.push("", `Findings (${open.length}):`);
    for (const f of open) {
      lines.push("");
      const agree = f.agreement ? ` agree=${f.agreement}` : "";
      const conf = f.confidence ? ` conf=${f.confidence}` : "";
      lines.push(`${f.id} [${f.severity}/${f.kind}${agree}${conf}] ${f.title}`);
      lines.push(`  where: ${f.where}`);
      lines.push(`  why: ${f.why}`);
      lines.push(`  action: ${f.action}`);
      if (f.note) lines.push(`  note: ${f.note}`);
    }
  }

  if (v.questions.length) {
    lines.push("", "Questions:");
    for (const q of v.questions) lines.push(`- ${q}`);
  }

  if (v.humanNotes.trim()) {
    lines.push("", `Human notes: ${v.humanNotes.trim()}`);
  }

  if (v.status === "changes_requested") {
    lines.push("", "Agent instructions: fix each open blocker/should-fix finding, then re-run preflight.");
  }

  return lines.join("\n");
}

export function formatVerdictJson(v: Verdict): string {
  return JSON.stringify(
    {
      status: v.status,
      summary: v.summary,
      intent: v.intent,
      judges: v.judges,
      agreementSummary: v.agreementSummary,
      findings: v.findings
        .filter((f) => f.status !== "dismissed")
        .map((f) => ({
          id: f.id,
          severity: f.severity,
          kind: f.kind,
          title: f.title,
          why: f.why,
          where: f.where,
          action: f.action,
          status: f.status,
          note: f.note || undefined,
          agreement: f.agreement,
          confidence: f.confidence,
          judges: f.judges,
        })),
      questions: v.questions,
      humanNotes: v.humanNotes || undefined,
      backend: v.backend,
    },
    null,
    2,
  );
}
