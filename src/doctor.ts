import { BACKENDS } from "./backends";
import { run } from "./proc";
import { VERSION } from "./version";

async function have(cmd: string): Promise<boolean> {
  const r = await run(["sh", "-c", `command -v ${cmd}`]);
  return r.code === 0;
}

export async function runDoctor(): Promise<number> {
  const lines: string[] = [];
  const ok = (label: string, detail = "") => lines.push(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  const bad = (label: string, detail = "") => lines.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  const info = (label: string, detail = "") => lines.push(`  · ${label}${detail ? ` — ${detail}` : ""}`);

  lines.push(`preflight doctor v${VERSION}`);
  lines.push("");

  // Runtime
  lines.push("Runtime");
  ok(`node ${process.version}`);
  const git = await run(["git", "--version"]);
  if (git.code === 0) ok(git.stdout.trim());
  else bad("git", "not found");

  const inside = await run(["git", "rev-parse", "--is-inside-work-tree"]);
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    const root = await run(["git", "rev-parse", "--show-toplevel"]);
    ok("git repo", root.stdout.trim());
  } else {
    info("git repo", "not inside a work tree (piped diffs still work)");
  }

  // Backends
  lines.push("");
  lines.push("LLM backends");
  let anyBackend = false;
  for (const b of Object.values(BACKENDS)) {
    const avail = await b.available();
    if (avail) {
      anyBackend = true;
      ok(b.name);
    } else {
      bad(b.name, "not available");
    }
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    ok("ANTHROPIC_API_KEY/AUTH_TOKEN set");
  } else {
    info("ANTHROPIC_API_KEY", "not set (optional if a CLI backend works)");
  }
  if (process.env.PREFLIGHT_MODEL) info("PREFLIGHT_MODEL", process.env.PREFLIGHT_MODEL);
  else info("PREFLIGHT_MODEL", "default claude-opus-4-5 (anthropic backend)");

  // Optional memory
  lines.push("");
  lines.push("Optional");
  if (await have("pickbrain")) ok("pickbrain", "local memory available");
  else info("pickbrain", "not on PATH (optional precedent memory)");

  if (process.env.PREFLIGHT_NO_RECALL === "1") info("PREFLIGHT_NO_RECALL", "memory disabled");

  lines.push("");
  if (!anyBackend) {
    lines.push("Status: NOT READY — install claude/codex/gemini/pi or set ANTHROPIC_API_KEY");
    console.log(lines.join("\n"));
    return 1;
  }
  if (git.code !== 0) {
    lines.push("Status: DEGRADED — git missing; only piped diffs will work");
    console.log(lines.join("\n"));
    return 0;
  }
  lines.push("Status: READY — run `preflight` on a dirty worktree or branch range");
  console.log(lines.join("\n"));
  return 0;
}
