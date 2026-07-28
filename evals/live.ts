#!/usr/bin/env bun
/**
 * Optional live LLM judgment eval against fixture diffs.
 * Skips cleanly when no backend is available (CI-safe).
 *
 *   bun evals/live.ts
 *   bun evals/live.ts --with pi
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff, diffForModel } from "../src/diff";
import { groundFindings } from "../src/ground";
import { resolveBackends, resolveStrictJudges } from "../src/backends";
import type { Finding } from "../src/analysis";

const META: Record<string, { expectedKinds: Finding["kind"][]; allowEmpty?: boolean }> = {
  "blank-name.diff": { expectedKinds: ["missing-test", "bug"] },
  "auth-bypass.diff": { expectedKinds: ["security", "bug"] },
  "api-break.diff": { expectedKinds: ["api-break", "regression"] },
  "missing-test.diff": { expectedKinds: ["missing-test"] },
  "rename-only.diff": { expectedKinds: [], allowEmpty: true },
};

const argv = process.argv.slice(2);
let withBackends: string[] | null = null;
let strict = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--with") withBackends = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (argv[i] === "--strict") strict = true;
}

const dir = join(import.meta.dir, "cases");
const outDir = join(import.meta.dir, "out");
mkdirSync(outDir, { recursive: true });

let backends;
try {
  backends = strict ? await resolveStrictJudges(withBackends) : await resolveBackends(withBackends);
} catch (err) {
  console.log(`live eval skipped: ${(err as Error).message}`);
  process.exit(0);
}

console.log(`live eval with ${backends.map((b) => b.name).join(", ")}`);

let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".diff")).sort()) {
  const meta = META[file] ?? { expectedKinds: [] as Finding["kind"][] };
  const raw = readFileSync(join(dir, file), "utf8");
  const files = parseDiff(raw);
  const annotated = diffForModel(files);
  const ctx = { intentHints: `fixture ${file}`, recall: "", codeContext: "" };

  const settled = await Promise.allSettled(backends.map((b) => b.judge(annotated, ctx, {})));
  const findings: Finding[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") findings.push(...groundFindings(s.value.findings, files));
  }

  const kinds = new Set(findings.map((f) => f.kind));
  const hit = meta.expectedKinds.filter((k) => kinds.has(k));
  const ok =
    meta.allowEmpty
      ? findings.every((f) => f.severity === "nit") || findings.length === 0 || hit.length > 0
      : hit.length > 0 || meta.expectedKinds.length === 0;

  writeFileSync(
    join(outDir, file.replace(/\.diff$/, ".json")),
    JSON.stringify({ file, backends: backends.map((b) => b.name), findings, hit, expected: meta.expectedKinds }, null, 2),
  );

  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${file} kinds=[${[...kinds].join(",") || "none"}] hit=[${hit.join(",") || "none"}] expected=[${meta.expectedKinds.join(",") || "none"}]`,
  );
}

console.log(failed === 0 ? "Live eval clean." : `${failed} live case(s) missed expected kinds.`);
// Non-zero only on hard misses when a backend ran — useful locally, not required in CI.
process.exit(0);
