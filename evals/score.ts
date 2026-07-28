#!/usr/bin/env bun
/**
 * Offline structural + expectation scoring for fixture diffs.
 * Does not call LLMs — validates parse/ground/merge plumbing and documents
 * what a good judge *should* catch (expectedKinds) for live eval later.
 *
 *   bun evals/score.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff, diffForModel, hunkById } from "../src/diff";
import { groundFindings } from "../src/ground";
import { mergeJudgeBundles } from "../src/merge";
import { extractSymbols } from "../src/context";
import type { Finding } from "../src/analysis";

interface CaseMeta {
  id: string;
  /** Kinds a strong judge should consider (documentation + live harness target). */
  expectedKinds: Finding["kind"][];
  /** Max severity a clean/mechanical change should produce when judged well. */
  maxExpectedSeverity?: Finding["severity"];
}

const META: Record<string, CaseMeta> = {
  "blank-name.diff": {
    id: "blank-name",
    expectedKinds: ["missing-test", "bug"],
  },
  "auth-bypass.diff": {
    id: "auth-bypass",
    expectedKinds: ["security", "bug"],
  },
  "api-break.diff": {
    id: "api-break",
    expectedKinds: ["api-break", "regression"],
  },
  "missing-test.diff": {
    id: "missing-test",
    expectedKinds: ["missing-test"],
  },
  "rename-only.diff": {
    id: "rename-only",
    expectedKinds: [],
    maxExpectedSeverity: "nit",
  },
};

function fakeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    severity: "should-fix",
    kind: "missing-test",
    title: "t",
    why: "w",
    where: "src/x.ts:1",
    action: "a",
    hunk_id: "h1",
    from: 1,
    to: 3,
    ...over,
  };
}

function check(name: string, pass: boolean, detail = ""): { name: string; pass: boolean; detail: string } {
  return { name, pass, detail };
}

const dir = join(import.meta.dir, "cases");
const files = readdirSync(dir).filter((f) => f.endsWith(".diff")).sort();

let failed = 0;
for (const file of files) {
  const raw = readFileSync(join(dir, file), "utf8");
  const parsed = parseDiff(raw);
  const meta = META[file] ?? { id: file, expectedKinds: [] };
  const annotated = diffForModel(parsed);
  const symbols = extractSymbols(parsed);
  const map = hunkById(parsed);

  const checks = [
    check("parses files", parsed.length >= 1, `${parsed.length} file(s)`),
    check("has hunks", parsed.some((f) => f.hunks.length > 0) || /rename/.test(raw), `${[...map.keys()].join(",")}`),
    check("annotated non-empty", annotated.length > 0 || /rename/.test(raw)),
    check(
      "expectedKinds documented",
      Array.isArray(meta.expectedKinds),
      meta.expectedKinds.join(",") || "(none — clean change)",
    ),
  ];

  // Grounding: valid anchor stays; bogus drops/downgrades.
  if (map.size > 0) {
    const hid = [...map.keys()][0];
    const hunk = map.get(hid)!;
    const line = hunk.hunk.lines.find((l) => l.newNo != null)?.newNo ?? 1;
    const good = groundFindings([fakeFinding({ hunk_id: hid, from: line, to: line, where: `${hunk.file.path}:${line}` })], parsed);
    const bad = groundFindings([fakeFinding({ hunk_id: "h999", severity: "blocker" })], parsed);
    checks.push(check("ground keeps valid anchor", good.length === 1 && good[0].grounded));
    checks.push(check("ground downgrades bad blocker", bad.length === 1 && bad[0].severity === "should-fix" && !bad[0].grounded));
  }

  // Merge: agreement on duplicate findings.
  const g = groundFindings(
    map.size
      ? [fakeFinding({ id: "A", hunk_id: [...map.keys()][0], title: "Double charge risk" })]
      : [fakeFinding({ id: "A", hunk_id: null, from: null, to: null })],
    parsed,
  );
  const merged = mergeJudgeBundles([
    { backend: "a", findings: g, questions: [] },
    { backend: "b", findings: g.map((f) => ({ ...f, id: "B", title: "double charge on retry" })), questions: [] },
  ]);
  checks.push(check("merge agrees 2/2", merged.findings[0]?.agreement === "2/2", merged.summary));

  if (meta.id === "missing-test" || meta.id === "auth-bypass") {
    checks.push(check("symbol extraction finds names", symbols.length > 0, symbols.join(",")));
  }

  const passN = checks.filter((c) => c.pass).length;
  const ok = passN === checks.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${meta.id} (${passN}/${checks.length})`);
  console.log(`  expect judge kinds: ${meta.expectedKinds.join(", ") || "(none)"}`);
  for (const c of checks.filter((x) => !x.pass)) {
    console.log(`  - ${c.name}: ${c.detail}`);
  }
}

console.log("");
console.log(failed === 0 ? `All ${files.length} fixture packs healthy.` : `${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
