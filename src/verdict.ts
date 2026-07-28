import { autoStatus, type Analysis, type Finding } from "./analysis";
import type { MergedFinding } from "./merge";
import type { VerifyResult } from "./verify";

export type FindingLifecycle = "new" | "persisting";

export interface VerdictFinding extends Finding {
  status: "open" | "accepted" | "dismissed";
  note?: string;
  agreement?: string;
  confidence?: "high" | "medium" | "low";
  judges?: string[];
  lifecycle?: FindingLifecycle;
  previousId?: string;
}

export interface ResolvedFinding {
  previousId: string;
  severity: Finding["severity"];
  kind: Finding["kind"];
  title: string;
  where: string;
}

export interface Verdict {
  status: "approved" | "changes_requested";
  summary: string;
  intent: string;
  findings: VerdictFinding[];
  resolvedFindings?: ResolvedFinding[];
  questions: string[];
  humanNotes: string;
  backend: string;
  judges?: string[];
  agreementSummary?: string;
  verification?: VerifyResult;
}

export interface HumanDecision {
  findingDecisions: Record<string, { status: "accepted" | "dismissed"; note?: string }>;
  humanNotes: string;
  forceStatus?: "approved" | "changes_requested";
}

function normalizedWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const left = normalizedWords(a);
  const right = normalizedWords(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

function locationPath(where: string): string {
  return where.split(":")[0].toLowerCase().trim();
}

function sameFinding(current: Finding, prior: VerdictFinding): boolean {
  const samePath = locationPath(current.where) === locationPath(prior.where);
  const sameKind = current.kind === prior.kind;
  if (current.hunk_id && prior.hunk_id && current.hunk_id === prior.hunk_id && samePath && sameKind) return true;
  if (samePath && sameKind && similarity(`${current.title} ${current.why}`, `${prior.title} ${prior.why}`) >= 0.2) return true;
  return sameKind && similarity(current.title, prior.title) >= 0.55;
}

export function classifyFindingLifecycle(
  current: Finding[],
  previous?: Verdict,
): { lifecycle: Array<{ state: FindingLifecycle; previousId?: string }>; resolved: ResolvedFinding[] } {
  if (!previous) return { lifecycle: current.map(() => ({ state: "new" })), resolved: [] };

  const prior = previous.findings.filter((finding) => finding.status !== "dismissed");
  const used = new Set<number>();
  const lifecycle = current.map((finding) => {
    const index = prior.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && sameFinding(finding, candidate));
    if (index === -1) return { state: "new" as const };
    used.add(index);
    return { state: "persisting" as const, previousId: prior[index].id };
  });
  const resolved = prior
    .filter((_, index) => !used.has(index))
    .map((finding) => ({
      previousId: finding.id,
      severity: finding.severity,
      kind: finding.kind,
      title: finding.title,
      where: finding.where,
    }));

  return { lifecycle, resolved };
}

export function buildVerdict(
  analysis: Analysis,
  backend: string,
  decision?: HumanDecision,
  meta?: {
    judges?: string[];
    agreementSummary?: string;
    merged?: MergedFinding[];
    verification?: VerifyResult;
    previousVerdict?: Verdict;
  },
): Verdict {
  const mergedById = new Map((meta?.merged ?? []).map((merged) => [merged.id, merged]));
  const classified = classifyFindingLifecycle(analysis.findings, meta?.previousVerdict);

  const findings: VerdictFinding[] = analysis.findings.map((finding, index) => {
    const human = decision?.findingDecisions[finding.id];
    const merged = mergedById.get(finding.id);
    const lifecycle = classified.lifecycle[index];
    return {
      ...finding,
      status: human?.status ?? "open",
      note: human?.note,
      agreement: merged?.agreement,
      confidence: merged?.confidence,
      judges: merged?.judges,
      lifecycle: lifecycle.state,
      previousId: lifecycle.previousId,
    };
  });

  let status: "approved" | "changes_requested";
  // Repository-native failures are authoritative. Neither a model nor a UI override can approve them.
  if (meta?.verification?.status === "failed") {
    status = "changes_requested";
  } else if (decision?.forceStatus) {
    status = decision.forceStatus;
  } else if (decision) {
    const actionable = findings.filter(
      (finding) =>
        finding.status !== "dismissed" &&
        (finding.severity === "blocker" || finding.severity === "should-fix"),
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
    resolvedFindings: classified.resolved,
    questions: analysis.questions,
    humanNotes: decision?.humanNotes ?? "",
    backend,
    judges: meta?.judges,
    agreementSummary: meta?.agreementSummary,
    verification: meta?.verification,
  };
}

export function formatVerdictText(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(`Preflight: ${verdict.status === "approved" ? "APPROVED" : "CHANGES REQUESTED"}`);
  lines.push("");
  lines.push(`Summary: ${verdict.summary}`);
  if (verdict.intent) lines.push(`Intent: ${verdict.intent}`);
  if (verdict.agreementSummary) lines.push(`Judges: ${verdict.agreementSummary}`);
  if (verdict.verification) lines.push(`Verification: ${verdict.verification.status.toUpperCase()} — ${verdict.verification.summary}`);

  const open = verdict.findings.filter((finding) => finding.status !== "dismissed");
  if (open.length === 0) {
    lines.push("", "Findings: none");
  } else {
    lines.push("", `Findings (${open.length}):`);
    for (const finding of open) {
      lines.push("");
      const agree = finding.agreement ? ` agree=${finding.agreement}` : "";
      const confidence = finding.confidence ? ` conf=${finding.confidence}` : "";
      const lifecycle = finding.lifecycle ? ` state=${finding.lifecycle}` : "";
      lines.push(`${finding.id} [${finding.severity}/${finding.kind}${agree}${confidence}${lifecycle}] ${finding.title}`);
      lines.push(`  where: ${finding.where}`);
      lines.push(`  why: ${finding.why}`);
      lines.push(`  action: ${finding.action}`);
      if (finding.note) lines.push(`  note: ${finding.note}`);
    }
  }

  if (verdict.resolvedFindings?.length) {
    lines.push("", `Resolved since last run (${verdict.resolvedFindings.length}):`);
    for (const finding of verdict.resolvedFindings) lines.push(`- ${finding.previousId} ${finding.title} @ ${finding.where}`);
  }

  if (verdict.verification?.status === "failed") {
    lines.push("", "Failed checks:");
    for (const check of verdict.verification.checks.filter((item) => item.status === "failed")) {
      lines.push(`- ${check.name}: ${check.command.join(" ")}${check.timedOut ? " (timed out)" : ""}`);
    }
  }

  if (verdict.questions.length) {
    lines.push("", "Questions:");
    for (const question of verdict.questions) lines.push(`- ${question}`);
  }
  if (verdict.humanNotes.trim()) lines.push("", `Human notes: ${verdict.humanNotes.trim()}`);
  if (verdict.status === "changes_requested") {
    lines.push("", "Agent instructions: fix failed checks and each open blocker/should-fix finding, then re-run preflight.");
  }
  return lines.join("\n");
}

export function formatVerdictJson(verdict: Verdict): string {
  return JSON.stringify(
    {
      status: verdict.status,
      summary: verdict.summary,
      intent: verdict.intent,
      judges: verdict.judges,
      agreementSummary: verdict.agreementSummary,
      verification: verdict.verification
        ? {
            status: verdict.verification.status,
            summary: verdict.verification.summary,
            failedChecks: verdict.verification.failedChecks,
            checks: verdict.verification.checks.map((check) => ({
              id: check.id,
              name: check.name,
              command: check.command,
              status: check.status,
              exitCode: check.exitCode,
              durationMs: check.durationMs,
              timedOut: check.timedOut || undefined,
              output: check.status === "failed" ? check.output : undefined,
            })),
          }
        : undefined,
      findings: verdict.findings
        .filter((finding) => finding.status !== "dismissed")
        .map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          kind: finding.kind,
          title: finding.title,
          why: finding.why,
          where: finding.where,
          action: finding.action,
          status: finding.status,
          lifecycle: finding.lifecycle,
          previousId: finding.previousId,
          note: finding.note || undefined,
          agreement: finding.agreement,
          confidence: finding.confidence,
          judges: finding.judges,
        })),
      resolvedFindings: verdict.resolvedFindings?.length ? verdict.resolvedFindings : undefined,
      questions: verdict.questions,
      humanNotes: verdict.humanNotes || undefined,
      backend: verdict.backend,
    },
    null,
    2,
  );
}
