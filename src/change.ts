import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { run } from "./proc";

const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
const LARGE_DIFF_BYTES = 750 * 1024;

export interface ChangeCapture {
  diff: string;
  root: string;
  untrackedFiles: string[];
  warnings: string[];
}

function normalizePath(root: string, path: string): string {
  return relative(root, resolve(root, path)).replaceAll("\\", "/");
}

async function looksBinary(path: string): Promise<boolean> {
  const body = await readFile(path);
  const sample = body.subarray(0, Math.min(body.length, 8192));
  return sample.includes(0);
}

function syntheticBinaryDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    `Binary files /dev/null and b/${path} differ`,
    "",
  ].join("\n");
}

function syntheticLargeFileDiff(path: string, bytes: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+[preflight omitted untracked file body: ${bytes} bytes]`,
    "",
  ].join("\n");
}

async function untrackedDiff(root: string, path: string, warnings: string[]): Promise<string> {
  const normalized = normalizePath(root, path);
  const absolute = resolve(root, normalized);
  const info = await stat(absolute);

  if (!info.isFile()) return "";
  if (await looksBinary(absolute)) return syntheticBinaryDiff(normalized);
  if (info.size > MAX_UNTRACKED_FILE_BYTES) {
    warnings.push(`${normalized}: untracked body omitted (${info.size} bytes; limit ${MAX_UNTRACKED_FILE_BYTES})`);
    return syntheticLargeFileDiff(normalized, info.size);
  }

  const patch = await run(
    ["git", "diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", normalized],
    undefined,
    { cwd: root },
  );
  // git diff --no-index returns 1 when a difference exists.
  if (patch.code !== 0 && patch.code !== 1) {
    warnings.push(`${normalized}: could not generate untracked patch (${patch.stderr.trim() || `exit ${patch.code}`})`);
    return syntheticLargeFileDiff(normalized, info.size);
  }
  return patch.stdout;
}

/**
 * Capture the Git change without mutating the index.
 * The default working-tree review includes staged, unstaged, and untracked files.
 * Explicit ranges/flags preserve normal `git diff` semantics and do not add untracked files.
 */
export async function captureGitChange(gitArgs: string[], cwd = process.cwd()): Promise<ChangeCapture> {
  const rootResult = await run(["git", "rev-parse", "--show-toplevel"], undefined, { cwd });
  if (rootResult.code !== 0) throw new Error(`not a git repository: ${rootResult.stderr.trim()}`);
  const root = rootResult.stdout.trim();
  const args = gitArgs.length > 0 ? gitArgs : ["HEAD"];
  const tracked = await run(["git", "diff", "--no-color", "--binary", ...args], undefined, { cwd: root });
  if (tracked.code !== 0) throw new Error(`git diff failed: ${tracked.stderr.trim()}`);

  const warnings: string[] = [];
  const untrackedFiles: string[] = [];
  const patches: string[] = [tracked.stdout];

  if (gitArgs.length === 0) {
    const listed = await run(["git", "ls-files", "--others", "--exclude-standard", "-z"], undefined, { cwd: root });
    if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
    for (const raw of listed.stdout.split("\0").filter(Boolean)) {
      const path = normalizePath(root, raw);
      untrackedFiles.push(path);
      const patch = await untrackedDiff(root, path, warnings);
      if (patch) patches.push(patch);
    }
  }

  const diff = patches.filter((p) => p.trim()).join("\n");
  if (Buffer.byteLength(diff) > LARGE_DIFF_BYTES) {
    warnings.push(`large review payload: ${Buffer.byteLength(diff)} bytes; model context may be truncated`);
  }

  return { diff, root, untrackedFiles, warnings };
}
