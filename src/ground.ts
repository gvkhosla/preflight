import type { Finding } from "./analysis";
import { hunkById, type DiffFile } from "./diff";

export interface GroundedFinding extends Finding {
  grounded: boolean;
  groundReason?: string;
}

function rangeHitsHunk(
  files: DiffFile[],
  hunkId: string,
  from: number | null,
  to: number | null,
): { ok: boolean; reason?: string } {
  const map = hunkById(files);
  const entry = map.get(hunkId);
  if (!entry) return { ok: false, reason: `unknown hunk ${hunkId}` };

  if (from == null && to == null) return { ok: true };
  if (from == null || to == null) return { ok: false, reason: "partial range" };
  if (from > to) return { ok: false, reason: "from > to" };

  const hit = entry.hunk.lines.some((l) => {
    const n = l.newNo ?? l.oldNo;
    return n != null && n >= from && n <= to;
  });
  return hit ? { ok: true } : { ok: false, reason: `range ${from}-${to} misses hunk lines` };
}

/** Validate finding anchors against the real diff. Ungrounded findings are downgraded/dropped. */
export function groundFindings(findings: Finding[], files: DiffFile[]): GroundedFinding[] {
  const paths = new Set(files.map((f) => f.path));
  const out: GroundedFinding[] = [];

  for (const f of findings) {
    let grounded = true;
    let groundReason: string | undefined;

    if (f.hunk_id) {
      const check = rangeHitsHunk(files, f.hunk_id, f.from, f.to);
      if (!check.ok) {
        grounded = false;
        groundReason = check.reason;
      }
    } else if (f.where.includes(":")) {
      const path = f.where.split(":")[0];
      if (path && ![...paths].some((p) => p === path || p.endsWith("/" + path) || p.endsWith(path))) {
        // soft: where path not in changed files
        grounded = false;
        groundReason = `where path not in diff: ${path}`;
      }
    }

    // Nits that don't anchor to the diff are dropped.
    if (!grounded && f.severity === "nit") continue;

    // Ungrounded blocker/should-fix keep but marked; caller may downgrade.
    out.push({
      ...f,
      // Clear bad anchors so UI doesn't point at nonsense.
      hunk_id: grounded ? f.hunk_id : f.hunk_id && hunkById(files).has(f.hunk_id) ? f.hunk_id : null,
      from: grounded ? f.from : null,
      to: grounded ? f.to : null,
      grounded,
      groundReason,
      severity:
        !grounded && f.severity === "blocker"
          ? "should-fix"
          : f.severity,
      why: !grounded && groundReason ? `${f.why} (ungrounded: ${groundReason})` : f.why,
    });
  }

  return out;
}
