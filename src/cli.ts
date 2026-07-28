#!/usr/bin/env node
// preflight — local ship gate for agent-built software.

import { parseDiff, diffForModel } from "./diff";
import { listAvailableBackends, resolveBackends, resolveStrictJudges } from "./backends";
import { runPipeline } from "./pipeline";
import { serveReview } from "./server";
import { gatherIntentHints } from "./intent";
import { gatherCodeContext } from "./context";
import { gatherRecall } from "./recall";
import { formatVerifyForPrompt, runVerifiers } from "./verify";
import { deltaPromptAddon, hashDiff, loadDeltaState, saveDeltaState } from "./delta";
import { buildVerdict, formatVerdictJson, formatVerdictText } from "./verdict";
import { runDoctor } from "./doctor";
import { VERSION } from "./version";
import { run } from "./proc";

const USAGE = `usage: preflight [options] [git diff args...]
       preflight doctor
       preflight --version

Local ship gate for agent-built software.
After your coding agent finishes, run preflight for a ship verdict.

Reads diff from stdin if piped, otherwise runs \`git diff <args>\`
(default: git diff HEAD). Prints verdict to stdout.

options:
  --json                 print machine-readable verdict on stdout
  --auto                 skip browser; derive verdict from findings
  --strict               force multi-judge merge (default when 2+ backends)
  --no-strict            single judge even if multiple backends exist
  --with <backend,...>   judges: anthropic, claude, codex, gemini, pi
  --model <id>           model id for backends that accept it
  --effort <level>       low|medium|high|xhigh|max (anthropic)
  --no-open              don't open the browser
  --no-recall            skip pickbrain memory
  --no-verify            skip local typecheck/related tests
  --no-delta             ignore previous .preflight/last-verdict.json
  --version              print version
  doctor                 check git/backends/memory readiness
  -h, --help             show help

examples:
  preflight                         review uncommitted changes
  preflight --json --auto           agent mode (auto-strict if possible)
  preflight --no-strict --auto      single-judge agent mode
  preflight main...HEAD
  npx @khosla/preflight doctor
  git diff -U10 | preflight
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
  if (argv[0] === "doctor") {
    process.exit(await runDoctor());
  }

  const gitArgs: string[] = [];
  let withBackends: string[] | null = null;
  let openBrowser = true;
  let jsonOut = false;
  let auto = false;
  let strict: boolean | null = null; // null = auto
  let model: string | undefined;
  let effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  let verify = true;
  let delta = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return;
    } else if (arg === "-V" || arg === "--version") {
      console.log(`preflight ${VERSION}`);
      return;
    } else if (arg === "--no-open") {
      openBrowser = false;
    } else if (arg === "--json") {
      jsonOut = true;
    } else if (arg === "--auto") {
      auto = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--no-strict") {
      strict = false;
    } else if (arg === "--no-recall") {
      process.env.PREFLIGHT_NO_RECALL = "1";
    } else if (arg === "--no-verify") {
      verify = false;
    } else if (arg === "--no-delta") {
      delta = false;
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

  // Auto-strict when 2+ backends available (unless --no-strict or explicit single --with).
  let useStrict = strict === true || (withBackends != null && withBackends.length > 1);
  if (strict === null && withBackends == null) {
    const available = await listAvailableBackends();
    if (available.length >= 2) {
      useStrict = true;
      console.error(`preflight: auto-strict (${available.length} backends; --no-strict to disable)`);
    }
  } else if (strict === false) {
    useStrict = false;
  }

  console.error(`preflight: packing context for ${hunkCount} hunks across ${files.length} files…`);
  const intentHints = await gatherIntentHints(gitArgs, files);
  const codeContext = await gatherCodeContext(files);
  if (codeContext) console.error("preflight: code context attached (symbols/tests/files)");

  let verifyText = "";
  if (verify) {
    console.error("preflight: running local verifiers…");
    const v = await runVerifiers(files);
    verifyText = formatVerifyForPrompt(v);
    console.error(`preflight: verify — ${v.summary}`);
  }

  const prev = delta ? await loadDeltaState() : null;
  const diffHash = hashDiff(diff);
  const deltaText = delta ? deltaPromptAddon(prev, diffHash) : "";
  if (deltaText) console.error("preflight: delta re-review context attached");

  const recall = await gatherRecall(intentHints, files);
  if (recall) console.error("preflight: pickbrain memory attached");
  else console.error("preflight: no pickbrain recall (optional)");

  const judges = useStrict
    ? await resolveStrictJudges(withBackends)
    : await resolveBackends(withBackends);
  const explainer = judges[0];

  const annotated = diffForModel(files);
  const result = await runPipeline(
    judges,
    explainer,
    annotated,
    files,
    { intentHints, recall, codeContext, verify: verifyText, delta: deltaText },
    { model, effort },
  );

  let decision = undefined;
  if (!auto) {
    const { renderReport } = await import("./render");
    const html = await renderReport(result, files, !!recall);
    decision = await serveReview(html, openBrowser);
  }

  const verdict = buildVerdict(result.analysis, result.backend, decision, {
    judges: result.judges,
    agreementSummary: result.agreementSummary,
    merged: result.mergedFindings,
  });

  if (delta) {
    await saveDeltaState(diff, verdict).catch(() => {});
  }

  if (jsonOut) console.log(formatVerdictJson(verdict));
  else console.log(formatVerdictText(verdict));

  process.exit(verdict.status === "approved" ? 0 : 2);
}

main().catch((err) => {
  console.error(`preflight: ${err.message ?? err}`);
  process.exit(1);
});
