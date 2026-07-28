import { basename, dirname, join } from "node:path";
import type { DiffFile } from "./diff";
import { run } from "./proc";

export interface VerifyResult {
  summary: string;
  details: string[];
}

function testCandidates(path: string): string[] {
  const base = basename(path);
  const dir = dirname(path);
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  return [
    join(dir, `${stem}.test.ts`),
    join(dir, `${stem}.test.tsx`),
    join(dir, `${stem}.spec.ts`),
    join(dir, `${stem}.spec.tsx`),
    join(dir, "__tests__", `${stem}.test.ts`),
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Cheap verification evidence for the judge (optional, best-effort). */
export async function runVerifiers(files: DiffFile[]): Promise<VerifyResult> {
  const details: string[] = [];
  const roots = await run(["git", "rev-parse", "--show-toplevel"]);
  const root = roots.code === 0 ? roots.stdout.trim() : process.cwd();

  // Collect related test files that exist.
  const tests = new Set<string>();
  for (const f of files.slice(0, 25)) {
    for (const c of testCandidates(f.path)) {
      const abs = c.startsWith("/") ? c : join(root, c);
      if (await exists(abs)) tests.add(c);
      if (tests.size >= 6) break;
    }
  }

  // Typecheck if tsconfig exists.
  if (await exists(join(root, "tsconfig.json"))) {
    const tsc = await run(["sh", "-c", "command -v tsc >/dev/null && tsc --noEmit -p . 2>&1 | tail -n 30"]);
    if (tsc.code === 0 && !tsc.stdout.trim()) {
      details.push("typecheck: pass (tsc --noEmit)");
    } else if (tsc.stdout || tsc.stderr) {
      const out = (tsc.stdout || tsc.stderr).trim().slice(0, 1500);
      details.push(`typecheck: fail\n${out}`);
    } else {
      details.push("typecheck: skipped (tsc not available)");
    }
  } else {
    details.push("typecheck: skipped (no tsconfig.json)");
  }

  // Targeted tests via bun/npm if present.
  if (tests.size > 0) {
    const list = [...tests];
    details.push(`related tests found: ${list.join(", ")}`);
    const hasBun = (await run(["sh", "-c", "command -v bun"])).code === 0;
    if (hasBun) {
      const args = ["bun", "test", ...list];
      const r = await run(args);
      const tail = (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-25).join("\n");
      details.push(r.code === 0 ? `bun test (related): pass\n${tail}` : `bun test (related): fail\n${tail}`);
    } else {
      details.push("bun test: skipped (bun not available)");
    }
  } else {
    details.push("related tests: none found by naming convention");
  }

  const failed = details.some((d) => /: fail/.test(d));
  const summary = failed
    ? "Verification found failures — treat as strong evidence for should-fix/blocker."
    : "Verification soft-pass or skipped; do not invent failures.";

  return { summary, details };
}

export function formatVerifyForPrompt(v: VerifyResult): string {
  return `${v.summary}\n\n${v.details.join("\n\n")}`.slice(0, 6000);
}
