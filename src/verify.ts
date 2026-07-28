import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DiffFile } from "./diff";
import { run } from "./proc";

export type VerifyCheckStatus = "passed" | "failed" | "skipped";

export interface VerifyCheck {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  source: "package-script" | "language" | "fallback";
  status?: VerifyCheckStatus;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  timedOut?: boolean;
}

export interface VerifyResult {
  status: "passed" | "failed" | "skipped";
  summary: string;
  details: string[];
  checks: VerifyCheck[];
  failedChecks: string[];
}

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
}

const SCRIPT_GROUPS = {
  check: ["check", "verify", "validate"],
  typecheck: ["typecheck", "type-check", "check:types", "types"],
  lint: ["lint", "lint:check"],
  test: ["test", "test:unit", "unit"],
  build: ["build"],
} as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function testCandidates(path: string): string[] {
  const base = basename(path);
  const dir = dirname(path);
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|rs)$/, "");
  return [
    join(dir, `${stem}.test.ts`),
    join(dir, `${stem}.test.tsx`),
    join(dir, `${stem}.spec.ts`),
    join(dir, `${stem}.spec.tsx`),
    join(dir, `${stem}_test.py`),
    join(dir, `${stem}_test.go`),
    join(dir, "__tests__", `${stem}.test.ts`),
  ];
}

async function readPackage(path: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

async function detectPackageManager(root: string, pkg: PackageJson | null): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  if ((await exists(join(root, "bun.lock"))) || (await exists(join(root, "bun.lockb")))) return "bun";
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function scriptCommand(manager: "bun" | "pnpm" | "yarn" | "npm", script: string): string[] {
  if (manager === "bun") return ["bun", "run", script];
  if (manager === "pnpm") return ["pnpm", "run", script];
  if (manager === "yarn") return ["yarn", "run", script];
  return ["npm", "run", script];
}

function execCommand(manager: "bun" | "pnpm" | "yarn" | "npm", bin: string, args: string[]): string[] {
  if (manager === "bun") return ["bunx", bin, ...args];
  if (manager === "pnpm") return ["pnpm", "exec", bin, ...args];
  if (manager === "yarn") return ["yarn", "exec", bin, ...args];
  return ["npx", "--no-install", bin, ...args];
}

function isPlaceholderScript(body: string): boolean {
  return /no test specified|not implemented|todo/i.test(body);
}

function firstScript(scripts: Record<string, string>, names: readonly string[]): string | null {
  return names.find((name) => scripts[name] && !isPlaceholderScript(scripts[name])) ?? null;
}

async function nearestPackageRoots(root: string, files: DiffFile[]): Promise<string[]> {
  const roots = new Set<string>();
  if (await exists(join(root, "package.json"))) roots.add(root);

  for (const file of files.slice(0, 30)) {
    let dir = dirname(resolve(root, file.path));
    while (dir.startsWith(root) && dir !== root) {
      if (await exists(join(dir, "package.json"))) {
        roots.add(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (roots.size >= 3) break;
  }
  return [...roots];
}

function addCheck(checks: VerifyCheck[], check: VerifyCheck): void {
  const key = `${check.cwd}\0${check.command.join("\0")}`;
  if (!checks.some((item) => `${item.cwd}\0${item.command.join("\0")}` === key)) checks.push(check);
}

/** Discover project-native checks without executing them. */
export async function discoverVerificationPlan(root: string, files: DiffFile[]): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const packageRoots = await nearestPackageRoots(root, files);
  const rootPackage = await readPackage(join(root, "package.json"));
  const manager = await detectPackageManager(root, rootPackage);

  for (const packageRoot of packageRoots) {
    const pkg = await readPackage(join(packageRoot, "package.json"));
    const scripts = pkg?.scripts ?? {};
    const scope = relative(root, packageRoot) || ".";
    const checkScript = firstScript(scripts, SCRIPT_GROUPS.check);
    const selected: Array<{ kind: string; script: string }> = [];

    if (checkScript) {
      selected.push({ kind: "check", script: checkScript });
    } else {
      const typecheck = firstScript(scripts, SCRIPT_GROUPS.typecheck);
      const lint = firstScript(scripts, SCRIPT_GROUPS.lint);
      if (typecheck) selected.push({ kind: "typecheck", script: typecheck });
      if (lint) selected.push({ kind: "lint", script: lint });
    }
    const test = firstScript(scripts, SCRIPT_GROUPS.test);
    const build = firstScript(scripts, SCRIPT_GROUPS.build);
    if (test) selected.push({ kind: "test", script: test });
    if (build) selected.push({ kind: "build", script: build });

    for (const { kind, script } of selected.slice(0, 4)) {
      addCheck(checks, {
        id: `package:${scope}:${kind}`,
        name: `${kind}${scope === "." ? "" : ` (${scope})`}`,
        command: scriptCommand(manager, script),
        cwd: packageRoot,
        source: "package-script",
      });
    }

    if (!checkScript && !firstScript(scripts, SCRIPT_GROUPS.typecheck) && (await exists(join(packageRoot, "tsconfig.json")))) {
      addCheck(checks, {
        id: `package:${scope}:typecheck-fallback`,
        name: `typecheck${scope === "." ? "" : ` (${scope})`}`,
        command: execCommand(manager, "tsc", ["--noEmit", "-p", "."]),
        cwd: packageRoot,
        source: "fallback",
      });
    }
  }

  const changed = files.map((file) => file.path);
  const hasRust = changed.some((path) => path.endsWith(".rs")) && (await exists(join(root, "Cargo.toml")));
  const hasGo = changed.some((path) => path.endsWith(".go")) && (await exists(join(root, "go.mod")));
  const hasPython = changed.some((path) => path.endsWith(".py"));

  if (hasRust) {
    addCheck(checks, { id: "rust:check", name: "cargo check", command: ["cargo", "check", "--quiet"], cwd: root, source: "language" });
    addCheck(checks, { id: "rust:test", name: "cargo test", command: ["cargo", "test", "--quiet"], cwd: root, source: "language" });
  }
  if (hasGo) {
    addCheck(checks, { id: "go:test", name: "go test", command: ["go", "test", "./..."], cwd: root, source: "language" });
    addCheck(checks, { id: "go:vet", name: "go vet", command: ["go", "vet", "./..."], cwd: root, source: "language" });
  }
  if (hasPython) {
    const pythonConfig = ["pyproject.toml", "pytest.ini", "tox.ini"].some((path) => changed.includes(path));
    const hasPytestConfig = pythonConfig || (await exists(join(root, "pyproject.toml"))) || (await exists(join(root, "pytest.ini")));
    if (hasPytestConfig) {
      const command = (await exists(join(root, "uv.lock"))) ? ["uv", "run", "pytest", "-q"] : ["python", "-m", "pytest", "-q"];
      addCheck(checks, { id: "python:test", name: "pytest", command, cwd: root, source: "language" });
    }
  }

  // If no test script exists, run nearby tests directly when Bun is the project manager.
  if (!checks.some((check) => /(^|:)test/.test(check.id))) {
    const tests = new Set<string>();
    for (const file of files.slice(0, 25)) {
      for (const candidate of testCandidates(file.path)) {
        if (await exists(join(root, candidate))) tests.add(candidate);
        if (tests.size >= 6) break;
      }
    }
    if (tests.size > 0 && manager === "bun") {
      addCheck(checks, {
        id: "fallback:related-tests",
        name: "related tests",
        command: ["bun", "test", ...tests],
        cwd: root,
        source: "fallback",
      });
    }
  }

  return checks.slice(0, 8);
}

function commandText(check: VerifyCheck, root: string): string {
  const cwd = relative(root, check.cwd) || ".";
  return `${cwd === "." ? "" : `(cd ${cwd} && `}${check.command.join(" ")}${cwd === "." ? "" : ")"}`;
}

function tailOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().split("\n").slice(-40).join("\n").slice(0, 4000);
}

/** Run discovered checks sequentially and return authoritative evidence. */
export async function runVerifiers(files: DiffFile[]): Promise<VerifyResult> {
  const rootResult = await run(["git", "rev-parse", "--show-toplevel"]);
  const root = rootResult.code === 0 ? rootResult.stdout.trim() : process.cwd();
  const checks = await discoverVerificationPlan(root, files);
  const timeoutMs = Math.max(5_000, Number(process.env.PREFLIGHT_VERIFY_TIMEOUT_MS ?? 90_000));

  for (const check of checks) {
    console.error(`preflight: verify ${check.name} — ${commandText(check, root)}`);
    try {
      const result = await run(check.command, undefined, { cwd: check.cwd, timeoutMs });
      check.exitCode = result.code;
      check.durationMs = result.durationMs;
      check.timedOut = result.timedOut;
      check.output = tailOutput(result.stdout, result.stderr);
      check.status = result.code === 0 ? "passed" : "failed";
    } catch (error) {
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `command not available: ${check.command[0]}`
        : (error as Error).message;
      check.status = "skipped";
      check.output = message;
    }
  }

  const failed = checks.filter((check) => check.status === "failed");
  const passed = checks.filter((check) => check.status === "passed");
  const status: VerifyResult["status"] = failed.length ? "failed" : passed.length ? "passed" : "skipped";
  const summary = failed.length
    ? `${failed.length} of ${checks.length} repository checks failed.`
    : passed.length
      ? `${passed.length} repository check${passed.length === 1 ? "" : "s"} passed${checks.length > passed.length ? `; ${checks.length - passed.length} skipped` : ""}.`
      : "No runnable repository-native checks were discovered.";
  const details = checks.map((check) => {
    const duration = check.durationMs != null ? ` (${(check.durationMs / 1000).toFixed(1)}s)` : "";
    const output = check.output ? `\n${check.output}` : "";
    return `${check.name}: ${check.status ?? "skipped"}${duration}\n$ ${commandText(check, root)}${output}`;
  });

  return {
    status,
    summary,
    details,
    checks,
    failedChecks: failed.map((check) => check.id),
  };
}

export function formatVerifyForPrompt(result: VerifyResult): string {
  const authority = result.status === "failed"
    ? "AUTHORITATIVE: repository checks failed. The final verdict must request changes until they pass."
    : result.status === "passed"
      ? "Repository-native checks passed. This is strong positive evidence, not proof of semantic correctness."
      : "No checks ran. Do not infer a pass.";
  return `${authority}\n${result.summary}\n\n${result.details.join("\n\n")}`.slice(0, 12_000);
}
