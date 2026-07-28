import {
  findingsSummaryForExplain,
  type Analysis,
  type ContextPack,
  type Finding,
} from "./analysis";
import type { AnalyzeOpts, Backend } from "./backends";
import type { DiffFile } from "./diff";
import { groundFindings } from "./ground";
import { mergeJudgeBundles, type MergedFinding } from "./merge";

export interface PipelineResult {
  backend: string;
  analysis: Analysis;
  judges: string[];
  agreementSummary: string;
  mergedFindings: MergedFinding[];
}

function stripMerged(f: MergedFinding): Finding {
  return {
    id: f.id,
    severity: f.severity,
    kind: f.kind,
    title: f.title,
    why: f.why,
    where: f.where,
    action: f.action,
    hunk_id: f.hunk_id,
    from: f.from,
    to: f.to,
  };
}

/** Run split judge(s) → ground → merge → explain. */
export async function runPipeline(
  judges: Backend[],
  explainer: Backend,
  annotatedDiff: string,
  files: DiffFile[],
  ctx: ContextPack,
  opts: AnalyzeOpts = {},
): Promise<PipelineResult> {
  console.error(`preflight: judging with ${judges.map((j) => j.name).join(", ")}…`);

  const settled = await Promise.allSettled(
    judges.map(async (j) => {
      const raw = await j.judge(annotatedDiff, ctx, opts);
      const grounded = groundFindings(raw.findings, files);
      return { backend: j.name, findings: grounded, questions: raw.questions };
    }),
  );

  const bundles = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") bundles.push(s.value);
    else console.error(`preflight: judge ${judges[i].name} failed: ${s.reason?.message ?? s.reason}`);
  }
  if (bundles.length === 0) throw new Error("all judges failed");

  const merged = mergeJudgeBundles(bundles);
  console.error(`preflight: ${merged.summary}`);

  const findingLines = findingsSummaryForExplain(merged.findings.map(stripMerged));
  console.error(`preflight: writing walkthrough with ${explainer.name}…`);
  let explain;
  try {
    explain = await explainer.explain(annotatedDiff, ctx, findingLines, opts);
  } catch (err) {
    console.error(`preflight: explainer failed (${(err as Error).message}); using stub walkthrough`);
    explain = {
      title: "Change review",
      summary: merged.findings.length
        ? `${merged.findings.length} finding(s) after multi-judge merge.`
        : "Judges found no issues.",
      intent: "",
      sections: [],
    };
  }

  const analysis: Analysis = {
    title: explain.title,
    summary: explain.summary,
    intent: explain.intent,
    sections: explain.sections,
    findings: merged.findings.map(stripMerged),
    questions: merged.questions,
  };

  return {
    backend: judges.map((j) => j.name).join("+"),
    judges: judges.map((j) => j.name),
    agreementSummary: merged.summary,
    analysis,
    mergedFindings: merged.findings,
  };
}
