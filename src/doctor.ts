import { BACKEND_ORDER, BACKENDS, listAvailableBackends, listAvailableCliBackends } from "./backends";
import { run } from "./proc";
import { VERSION } from "./version";

async function have(cmd: string): Promise<boolean> {
  const r = await run(["sh", "-c", `command -v ${cmd}`]);
  return r.code === 0;
}

export type DoctorReport = {
  version: string;
  runtime: { node: string; git: string | null; repo: string | null };
  clis: { name: string; available: boolean }[];
  apis: { name: string; available: boolean }[];
  optional: { pickbrain: boolean; anthropicKey: boolean; model?: string };
  defaultBackend: string | null;
  autoStrict: string | null;
  status: "ready" | "ready-api" | "degraded" | "not-ready";
};

export async function collectDoctorReport(): Promise<DoctorReport> {
  const git = await run(["git", "--version"]);
  const inside = await run(["git", "rev-parse", "--is-inside-work-tree"]);
  let repo: string | null = null;
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    const root = await run(["git", "rev-parse", "--show-toplevel"]);
    repo = root.stdout.trim() || null;
  }

  const clis: DoctorReport["clis"] = [];
  const apis: DoctorReport["apis"] = [];
  for (const name of BACKEND_ORDER) {
    const b = BACKENDS[name];
    const available = await b.available();
    if (b.kind === "cli") clis.push({ name, available });
    else apis.push({ name, available });
  }

  const available = await listAvailableBackends();
  const cliBackends = await listAvailableCliBackends();
  const anyCli = clis.some((c) => c.available);
  let status: DoctorReport["status"] = "ready";
  if (!anyCli && available.length === 0) status = "not-ready";
  else if (!anyCli && available.length > 0) status = "ready-api";
  else if (git.code !== 0) status = "degraded";

  return {
    version: VERSION,
    runtime: {
      node: process.version,
      git: git.code === 0 ? git.stdout.trim() : null,
      repo,
    },
    clis,
    apis,
    optional: {
      pickbrain: await have("pickbrain"),
      anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      model: process.env.PREFLIGHT_MODEL,
    },
    defaultBackend: available[0] ? `${available[0].name} (${available[0].kind})` : null,
    autoStrict:
      cliBackends.length >= 2
        ? `${cliBackends[0].name}+${cliBackends[1].name}`
        : available.length >= 2
          ? `${available[0].name}+${available[1].name}`
          : null,
    status,
  };
}

export async function runDoctor(json = false): Promise<number> {
  const report = await collectDoctorReport();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.status === "not-ready" ? 1 : 0;
  }

  const lines: string[] = [];
  const ok = (label: string, detail = "") => lines.push(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  const bad = (label: string, detail = "") => lines.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  const info = (label: string, detail = "") => lines.push(`  · ${label}${detail ? ` — ${detail}` : ""}`);

  lines.push(`preflight doctor v${report.version}`);
  lines.push("");
  lines.push("Runtime");
  ok(`node ${report.runtime.node}`);
  if (report.runtime.git) ok(report.runtime.git);
  else bad("git", "not found");
  if (report.runtime.repo) ok("git repo", report.runtime.repo);
  else info("git repo", "not inside a work tree (piped diffs still work)");

  lines.push("");
  lines.push("Agent CLIs (preferred)");
  for (const cli of report.clis) {
    if (cli.available) ok(cli.name);
    else info(cli.name, "not on PATH");
  }

  lines.push("");
  lines.push("API backends (optional)");
  for (const api of report.apis) {
    if (api.available) ok(api.name);
    else info(api.name, "not configured");
  }
  if (report.optional.anthropicKey) ok("ANTHROPIC_API_KEY/AUTH_TOKEN set");
  else info("ANTHROPIC_API_KEY", "optional power-up if no agent CLI is installed");
  if (report.optional.model) info("PREFLIGHT_MODEL", report.optional.model);
  if (report.defaultBackend) info("default backend", report.defaultBackend);
  if (report.autoStrict) info("auto-strict", `would use ${report.autoStrict}`);

  lines.push("");
  lines.push("Optional");
  if (report.optional.pickbrain) ok("pickbrain", "local memory available");
  else info("pickbrain", "not on PATH (optional precedent memory)");
  if (process.env.PREFLIGHT_NO_RECALL === "1") info("PREFLIGHT_NO_RECALL", "memory disabled");

  lines.push("");
  if (report.status === "not-ready") {
    lines.push("Status: NOT READY — install pi, claude, codex, amp, opencode, or gemini");
    lines.push("         (or set ANTHROPIC_API_KEY as an optional API backend)");
  } else if (report.status === "ready-api") {
    lines.push("Status: READY via API — consider installing an agent CLI for the default path");
  } else if (report.status === "degraded") {
    lines.push("Status: DEGRADED — git missing; only piped diffs will work");
  } else {
    lines.push("Status: READY — run `preflight` on a dirty worktree or branch range");
  }
  console.log(lines.join("\n"));
  return report.status === "not-ready" ? 1 : 0;
}
