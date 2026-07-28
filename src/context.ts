import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DiffFile } from "./diff";
import { run } from "./proc";

const SYMBOL_RE =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_][\w]*)/g;
const DEF_RE =
  /^\+.*\b(?:def|fn|func|public|private|protected|internal)\s+([A-Za-z_][\w]*)/gm;

function harvestSymbols(text: string, into: Set<string>) {
  for (const re of [SYMBOL_RE, DEF_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[1] && m[1].length > 1 && m[1] !== "from" && m[1] !== "import") into.add(m[1]);
    }
  }
}

/** Extract rough symbol names from diff lines + hunk headers. */
export function extractSymbols(files: DiffFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      harvestSymbols(hunk.header, found);
      for (const line of hunk.lines) {
        // Prefer adds; also scan context so we still name the enclosing function.
        if (line.kind === "del") continue;
        harvestSymbols(line.text, found);
      }
    }
  }
  return [...found].slice(0, 40);
}

function testPathCandidates(path: string): string[] {
  const base = basename(path);
  const dir = dirname(path);
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|rs)$/, "");
  const noExt = base.replace(/\.[^.]+$/, "");
  return [
    join(dir, `${stem}.test.ts`),
    join(dir, `${stem}.test.tsx`),
    join(dir, `${stem}.spec.ts`),
    join(dir, `${stem}_test.go`),
    join(dir, `${stem}_test.py`),
    join(dir, `__tests__`, `${stem}.test.ts`),
    join(dir, "tests", `${noExt}_test.go`),
    path.replace(/\/src\//, "/test/").replace(/\/src\//, "/tests/"),
    path.replace(/\.ts$/, ".test.ts"),
    path.replace(/\.tsx$/, ".test.tsx"),
    path.replace(/\.py$/, "_test.py"),
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readHeadFile(path: string, maxChars = 2500): Promise<string | null> {
  // Prefer working tree (includes uncommitted), fall back to HEAD.
  try {
    const cur = await readFile(path, "utf8");
    return cur.slice(0, maxChars);
  } catch {
    const shown = await run(["git", "show", `HEAD:${path}`]);
    if (shown.code === 0 && shown.stdout) return shown.stdout.slice(0, maxChars);
    return null;
  }
}

/** Related tests + symbol list + small file windows for the judge. Soft-fails. */
export async function gatherCodeContext(files: DiffFile[]): Promise<string> {
  const parts: string[] = [];
  const symbols = extractSymbols(files);
  if (symbols.length) parts.push(`changed symbols (heuristic): ${symbols.join(", ")}`);

  const testHits: string[] = [];
  const seen = new Set<string>();
  for (const f of files.slice(0, 20)) {
    for (const cand of testPathCandidates(f.path)) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      if (await fileExists(cand)) testHits.push(cand);
      if (testHits.length >= 8) break;
    }
    if (testHits.length >= 8) break;
  }

  if (testHits.length) {
    parts.push(`related test files:\n${testHits.map((p) => `- ${p}`).join("\n")}`);
    for (const t of testHits.slice(0, 4)) {
      const body = await readHeadFile(t, 1800);
      if (body) parts.push(`### test excerpt ${t}\n\`\`\`\n${body}\n\`\`\``);
    }
  } else {
    parts.push("related test files: none found by naming convention");
  }

  // Surrounding context for up to 3 non-test changed files (post-image).
  let windows = 0;
  for (const f of files) {
    if (windows >= 3) break;
    if (f.status === "deleted" || f.status === "binary") continue;
    if (/\.(test|spec)\./i.test(f.path) || /_test\./i.test(f.path)) continue;
    const body = await readHeadFile(f.path, 2200);
    if (!body) continue;
    parts.push(`### file context ${f.path} (${f.status})\n\`\`\`\n${body}\n\`\`\``);
    windows++;
  }

  // Cap total pack size.
  let out = parts.join("\n\n");
  if (out.length > 12000) out = out.slice(0, 12000) + "\n…(truncated)";
  return out;
}
