import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./proc";
import type { Verdict } from "./verdict";

export interface DeltaState {
  diffHash: string;
  savedAt: string;
  verdict: Verdict;
  openFindingIds: string[];
}

async function stateDir(): Promise<string | null> {
  const root = await run(["git", "rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return null;
  return join(root.stdout.trim(), ".preflight");
}

export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 16);
}

export async function loadDeltaState(): Promise<DeltaState | null> {
  try {
    const dir = await stateDir();
    if (!dir) return null;
    const raw = await readFile(join(dir, "last-verdict.json"), "utf8");
    return JSON.parse(raw) as DeltaState;
  } catch {
    return null;
  }
}

export async function saveDeltaState(diff: string, verdict: Verdict): Promise<void> {
  const dir = await stateDir();
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const openFindingIds = verdict.findings
    .filter((f) => f.status !== "dismissed" && (f.severity === "blocker" || f.severity === "should-fix"))
    .map((f) => f.id);
  const state: DeltaState = {
    diffHash: hashDiff(diff),
    savedAt: new Date().toISOString(),
    verdict,
    openFindingIds,
  };
  await writeFile(join(dir, "last-verdict.json"), JSON.stringify(state, null, 2));
}

/**
 * Build a delta-focused pack for the judge when re-reviewing after fixes.
 * Returns null when no prior state or diff unchanged in a useless way.
 */
export function deltaPromptAddon(prev: DeltaState | null, currentDiffHash: string): string {
  if (!prev) return "";
  if (prev.diffHash === currentDiffHash) {
    return `## Delta re-review
Current diff hash matches the previous review (${prev.diffHash}). Focus on whether prior open findings are truly fixed; avoid re-opening pure nits.`;
  }
  const open = prev.openFindingIds.length ? prev.openFindingIds.join(", ") : "(none)";
  const prior = prev.verdict.findings
    .filter((f) => f.status !== "dismissed")
    .slice(0, 12)
    .map((f) => `- ${f.id} [${f.severity}/${f.kind}] ${f.title} @ ${f.where} → ${f.action}`)
    .join("\n");
  return `## Delta re-review
Previous review (${prev.savedAt}) hash=${prev.diffHash}; current hash=${currentDiffHash}.
Open finding ids last time: ${open}
Prior findings:
${prior || "(none)"}

Instructions:
- Prefer checking whether prior open findings are fixed.
- Only add new findings for new risks introduced since last review.
- If a prior finding is fixed, do not restate it.`;
}
