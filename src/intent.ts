import { run } from "./proc";
import type { DiffFile } from "./diff";

/** Gather lightweight intent hints from git metadata. Soft-fails to "". */
export async function gatherIntentHints(gitArgs: string[], files: DiffFile[]): Promise<string> {
  const parts: string[] = [];

  const branch = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code === 0 && branch.stdout.trim()) {
    parts.push(`branch: ${branch.stdout.trim()}`);
  }

  // If user passed a range like main...HEAD, use it for log; else recent commits on branch.
  const range = gitArgs.find((a) => a.includes("...")) ?? gitArgs.find((a) => a.includes(".."));
  const logArgs = range
    ? ["git", "log", "--oneline", "-n", "12", range]
    : ["git", "log", "--oneline", "-n", "8", "HEAD"];
  const log = await run(logArgs);
  if (log.code === 0 && log.stdout.trim()) {
    parts.push(`recent commits:\n${log.stdout.trim()}`);
  }

  if (files.length) {
    const paths = files.map((f) => f.path).slice(0, 30);
    parts.push(`changed files (${files.length}): ${paths.join(", ")}`);
  }

  return parts.join("\n");
}
