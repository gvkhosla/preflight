import { BACKEND_ORDER, BACKENDS, listAvailableBackends, listAvailableCliBackends } from "./backends";
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

  lines.push("");
  lines.push("Agent CLIs (preferred)");
  let anyCli = false;
  for (const name of BACKEND_ORDER) {
    const b = BACKENDS[name];
    if (b.kind !== "cli") continue;
    const avail = await b.available();
    if (avail) {
      anyCli = true;
      ok(name);
    } else {
      info(name, "not on PATH");
    }
  }

  lines.push("");
  lines.push("API backends (optional)");
  for (const name of BACKEND_ORDER) {
    const b = BACKENDS[name];
    if (b.kind !== "api") continue;
    const avail = await b.available();
    if (avail) ok(name);
    else info(name, "not configured");
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    ok("ANTHROPIC_API_KEY/AUTH_TOKEN set");
  } else {
    info("ANTHROPIC_API_KEY", "optional power-up if no agent CLI is installed");
  }
  if (process.env.PREFLIGHT_MODEL) info("PREFLIGHT_MODEL", process.env.PREFLIGHT_MODEL);

  const available = await listAvailableBackends();
  const clis = await listAvailableCliBackends();
  if (available[0]) {
    info("default backend", `${available[0].name}${available[0].kind === "cli" ? " (cli)" : " (api)"}`);
  }
  if (clis.length >= 2) info("auto-strict", `would use ${clis[0].name}+${clis[1].name}`);
  else if (available.length >= 2) info("auto-strict", `would use ${available[0].name}+${available[1].name}`);

  lines.push("");
  lines.push("Optional");
  if (await have("pickbrain")) ok("pickbrain", "local memory available");
  else info("pickbrain", "not on PATH (optional precedent memory)");
  if (process.env.PREFLIGHT_NO_RECALL === "1") info("PREFLIGHT_NO_RECALL", "memory disabled");

  lines.push("");
  if (!anyCli && available.length === 0) {
    lines.push("Status: NOT READY — install pi, claude, codex, amp, opencode, or gemini");
    lines.push("         (or set ANTHROPIC_API_KEY as an optional API backend)");
    console.log(lines.join("\n"));
    return 1;
  }
  if (!anyCli && available.length > 0) {
    lines.push("Status: READY via API — consider installing an agent CLI for the default path");
    console.log(lines.join("\n"));
    return 0;
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
