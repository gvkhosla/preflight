#!/usr/bin/env node
// preflight — local ship gate for agent-built software.
// Split judges + optional multi-judge merge + grounded findings + walkthrough.

import { parseDiff, diffForModel } from "./diff";
import { resolveBackends, resolveStrictJudges } from "./backends";
import { runPipeline } from "./pipeline";
import { renderReport } from "./render";
import { serveReview } from "./server";
import { gatherIntentHints } from "./intent";
import { gatherRecall } from "./recall";
import { buildVerdict, formatVerdictJson, formatVerdictText } from "./verdict";
import { run } from "./proc";

const USAGE = `usage: preflight [options] [git diff args...]

Local ship gate: multi-judge findings, grounded against the diff, one verdict.

Reads diff from stdin if piped, otherwise runs \`git diff <args>\`
(default: git diff HEAD). Prints verdict to stdout.

options:
  --json                 print machine-readable verdict on stdout
  --auto                 skip browser; derive verdict from findings
  --strict               use 2 judges when available and merge findings
  --with <backend,...>   judges: anthropic, claude, codex, gemini, pi
  --model <id>           model id for backends that accept it
  --effort <level>       low|medium|high|xhigh|max (anthropic)
  --no-open              don't open the browser
  --no-recall            skip pickbrain memory
  -h, --help             show help

examples:
  preflight                         review uncommitted changes
  preflight --strict                two-judge merge when possible
  preflight --json --auto --strict  agent mode, higher judgment bar
  preflight --with anthropic,codex  explicit judges
  git diff -U10 | preflight         piped diff
`;

async function getDiff(gitArgs: string[]): Promise<string> {
  if (!process.stdin.isTTY) {
    let piped = "";
    for await (const chunk of process.stdin.setEncoding("utf8")) piped += chunk;
    if (piped.trim()) return piped;
  }
  const args = gitArgs.length > 0 ? gitArgs : ["HEAD"];
  const { stdout, stderr, code } = await run(["git", "diff", "--no-color", ...args]);
  if (code !== 0) throw new Error(`git diff failed: ${stderr.trim()}`);
  return stdout;
}

async function main() {
  const argv = process.argv.slice(2);
  const gitArgs: string[] = [];
  let withBackends: string[] | null = null;
  let openBrowser = true;
  let jsonOut = false;
  let auto = false;
  let strict = false;
  let model: string | undefined;
  let effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return;
    } else if (arg === "--no-open") {
      openBrowser = false;
    } else if (arg === "--json") {
      jsonOut = true;
    } else if (arg === "--auto") {
      auto = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--no-recall") {
      process.env.PREFLIGHT_NO_RECALL = "1";
    } else if (arg === "--with") {
      withBackends = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--model") {
      model = argv[++i];
    } else if (arg === "--effort") {
      const level = argv[++i];
      if (!["low", "medium", "high", "xhigh", "max"].includes(level ?? "")) {
        throw new Error(`invalid --effort "${level}" (low|medium|high|xhigh|max)`);
      }
      effort = level as typeof effort;
    } else {
      gitArgs.push(arg);
    }
  }

  const diff = await getDiff(gitArgs);
  const files = parseDiff(diff);
  const hunkCount = files.reduce((n, f) => n + f.hunks.length, 0);
  if (hunkCount === 0) {
    console.error("preflight: no changes to review");
    process.exit(1);
  }

  console.error(`preflight: packing context for ${hunkCount} hunks across ${files.length} files…`);
  const intentHints = await gatherIntentHints(gitArgs, files);
  const recall = await gatherRecall(intentHints, files);
  if (recall) console.error("preflight: pickbrain memory attached");
  else console.error("preflight: no pickbrain recall (optional)");

  const judges =
    strict || (withBackends && withBackends.length > 1)
      ? await resolveStrictJudges(withBackends)
      : await resolveBackends(withBackends);
  const explainer = judges[0];

  const annotated = diffForModel(files);
  const result = await runPipeline(judges, explainer, annotated, files, { intentHints, recall }, { model, effort });

  let decision = undefined;
  if (!auto) {
    const html = await renderReport([result], files, !!recall);
    decision = await serveReview(html, openBrowser);
  }

  const verdict = buildVerdict(result.analysis, result.backend, decision, {
    judges: result.judges,
    agreementSummary: result.agreementSummary,
    merged: result.mergedFindings,
  });

  if (jsonOut) console.log(formatVerdictJson(verdict));
  else console.log(formatVerdictText(verdict));

  process.exit(verdict.status === "approved" ? 0 : 2);
}

main().catch((err) => {
  console.error(`preflight: ${err.message ?? err}`);
  process.exit(1);
});
