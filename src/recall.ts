import { run } from "./proc";
import type { DiffFile } from "./diff";

async function havePickbrain(): Promise<boolean> {
  const which = await run(["sh", "-c", "command -v pickbrain"]);
  return which.code === 0;
}

function buildQuery(intentHints: string, files: DiffFile[]): string {
  const branch = intentHints.match(/^branch: (.+)$/m)?.[1] ?? "";
  const topFiles = files
    .map((f) => f.path.split("/").pop() ?? f.path)
    .slice(0, 6)
    .join(" ");
  const bits = [branch, topFiles, "review bug fix regression decision"].filter(Boolean);
  return bits.join(" ").trim() || "code review findings conventions";
}

/** Optional local memory via pickbrain. Never throws; returns "" if unavailable. */
export async function gatherRecall(intentHints: string, files: DiffFile[]): Promise<string> {
  if (process.env.PREFLIGHT_NO_RECALL === "1") return "";
  if (!(await havePickbrain())) return "";

  const query = buildQuery(intentHints, files);
  const args = ["pickbrain", "--exclude-current"];
  if (process.env.PREFLIGHT_RECALL_SINCE) {
    args.push("--since", process.env.PREFLIGHT_RECALL_SINCE);
  } else {
    args.push("--since", "90d");
  }
  // Keep the pack small and skimmable for the model.
  args.push(query);

  try {
    const { stdout, code } = await run(args);
    if (code !== 0 || !stdout.trim()) return "";
    // Cap so prompts stay tight.
    const lines = stdout.trim().split("\n").slice(0, 40);
    return lines.join("\n").slice(0, 3500);
  } catch {
    return "";
  }
}
