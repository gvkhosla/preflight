import type { Finding } from "./analysis";
import type { GroundedFinding } from "./ground";

export interface JudgeBundle {
  backend: string;
  findings: GroundedFinding[];
  questions: string[];
}

export interface MergedFinding extends Finding {
  grounded: boolean;
  groundReason?: string;
  agreement: string; // e.g. "2/2"
  judges: string[];
  confidence: "high" | "medium" | "low";
}

const SEV_RANK = { blocker: 3, "should-fix": 2, nit: 1 } as const;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(/\s+/).filter((t) => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function whereKey(where: string): string {
  // path:line → path
  return norm(where.split(":")[0] ?? where);
}

function similar(a: Finding, b: Finding): boolean {
  if (a.hunk_id && b.hunk_id && a.hunk_id === b.hunk_id) {
    if (a.from != null && b.from != null && a.to != null && b.to != null) {
      const overlap = !(a.to < b.from || b.to < a.from);
      if (overlap) return true;
    } else {
      return true;
    }
  }
  if (whereKey(a.where) && whereKey(a.where) === whereKey(b.where) && a.kind === b.kind) return true;

  const ta = tokens(`${a.title} ${a.why} ${a.action}`);
  const tb = tokens(`${b.title} ${b.why} ${b.action}`);
  if (jaccard(ta, tb) >= 0.34 && (a.kind === b.kind || whereKey(a.where) === whereKey(b.where))) return true;
  return false;
}

function maxSev(a: Finding["severity"], b: Finding["severity"]): Finding["severity"] {
  return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

function medianSev(sevs: Finding["severity"][]): Finding["severity"] {
  const sorted = [...sevs].sort((x, y) => SEV_RANK[x] - SEV_RANK[y]);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Merge multi-judge findings into one ranked list with agreement. */
export function mergeJudgeBundles(bundles: JudgeBundle[]): {
  findings: MergedFinding[];
  questions: string[];
  summary: string;
} {
  if (bundles.length === 0) return { findings: [], questions: [], summary: "0 judges" };
  const judgeCount = bundles.length;

  type Cluster = {
    items: { finding: GroundedFinding; backend: string }[];
  };
  const clusters: Cluster[] = [];

  for (const b of bundles) {
    for (const f of b.findings) {
      let placed = false;
      for (const c of clusters) {
        if (similar(c.items[0].finding, f)) {
          c.items.push({ finding: f, backend: b.backend });
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ items: [{ finding: f, backend: b.backend }] });
    }
  }

  const merged: MergedFinding[] = [];
  let id = 1;

  for (const c of clusters) {
    const backends = [...new Set(c.items.map((i) => i.backend))];
    const agreeN = backends.length;
    const sevs = c.items.map((i) => i.finding.severity);
    // Agreement-aware severity:
    // - single-judge blocker → should-fix (unless only one judge total)
    // - multi agree → max/median blend
    let severity: Finding["severity"] = medianSev(sevs);
    if (judgeCount >= 2 && agreeN === 1 && severity === "blocker") severity = "should-fix";
    if (agreeN >= 2) severity = maxSev(severity, medianSev(sevs));

    // Drop lone nits when multiple judges and only one mentioned it.
    if (judgeCount >= 2 && agreeN === 1 && severity === "nit") continue;

    const confidence: MergedFinding["confidence"] =
      agreeN >= 2 && judgeCount >= 2 ? "high" : agreeN === 1 && judgeCount >= 2 ? "low" : "medium";

    // Prefer grounded exemplar with highest original severity.
    const exemplar = [...c.items].sort((a, b) => {
      const g = Number(b.finding.grounded) - Number(a.finding.grounded);
      if (g) return g;
      return SEV_RANK[b.finding.severity] - SEV_RANK[a.finding.severity];
    })[0].finding;

    const titles = c.items.map((i) => i.finding.title);
    const title = titles.sort((a, b) => b.length - a.length)[0];

    merged.push({
      id: `F${id++}`,
      severity,
      kind: exemplar.kind,
      title,
      why: exemplar.why,
      where: exemplar.where,
      action: exemplar.action,
      hunk_id: exemplar.hunk_id,
      from: exemplar.from,
      to: exemplar.to,
      grounded: exemplar.grounded,
      groundReason: exemplar.groundReason,
      agreement: `${agreeN}/${judgeCount}`,
      judges: backends,
      confidence,
    });
  }

  merged.sort((a, b) => {
    const s = SEV_RANK[b.severity] - SEV_RANK[a.severity];
    if (s) return s;
    const conf = { high: 3, medium: 2, low: 1 }[b.confidence] - { high: 3, medium: 2, low: 1 }[a.confidence];
    return conf;
  });

  // Renumber after sort
  merged.forEach((f, i) => {
    f.id = `F${i + 1}`;
  });

  const questions = [...new Set(bundles.flatMap((b) => b.questions.map((q) => q.trim()).filter(Boolean)))];
  const high = merged.filter((f) => f.confidence === "high").length;
  const summary = `${judgeCount} judge(s), ${merged.length} merged finding(s), ${high} high-agreement`;

  return { findings: merged, questions, summary };
}
