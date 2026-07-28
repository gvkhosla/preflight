import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
  durationMs?: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// Runs a command, optionally writing stdin, and collects stdout/stderr/exit code.
export function run(argv: string[], stdin?: string, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 1500).unref();
        }, options.timeoutMs)
      : null;

    proc.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    proc.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code: timedOut ? 124 : code ?? 1,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    if (stdin !== undefined) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}
