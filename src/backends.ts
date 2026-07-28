import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ExplainSchema,
  JudgeSchema,
  explainPrompt,
  extractExplain,
  extractJudge,
  judgePrompt,
  type ContextPack,
  type ExplainResult,
  type JudgeResult,
} from "./analysis";
import { run } from "./proc";

export interface AnalyzeOpts {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Backend {
  name: string;
  kind: "cli" | "api";
  available(): Promise<boolean>;
  judge(annotatedDiff: string, ctx: ContextPack, opts: AnalyzeOpts): Promise<JudgeResult>;
  explain(
    annotatedDiff: string,
    ctx: ContextPack,
    findingsSummary: string,
    opts: AnalyzeOpts,
  ): Promise<ExplainResult>;
}

function haveCommand(cmd: string): Promise<boolean> {
  return run(["sh", "-c", `command -v ${cmd}`]).then(
    ({ code }) => code === 0,
    () => false,
  );
}

const modelFlag = (o: AnalyzeOpts, flag = "--model") => (o.model ? [flag, o.model] : []);

/** Prompt on stdin (pi/claude/codex/amp/gemini). */
function stdinCliBackend(name: string, argv: (opts: AnalyzeOpts) => string[]): Backend {
  return {
    name,
    kind: "cli",
    available: () => haveCommand(argv({})[0]),
    async judge(annotatedDiff, ctx, opts) {
      const { stdout, stderr, code } = await run(argv(opts), judgePrompt(annotatedDiff, ctx));
      if (code !== 0) throw new Error(`${name} exited ${code}: ${stderr.slice(0, 500)}`);
      return extractJudge(stdout);
    },
    async explain(annotatedDiff, ctx, findingsSummary, opts) {
      const { stdout, stderr, code } = await run(argv(opts), explainPrompt(annotatedDiff, ctx, findingsSummary));
      if (code !== 0) throw new Error(`${name} exited ${code}: ${stderr.slice(0, 500)}`);
      return extractExplain(stdout);
    },
  };
}

/** Prompt as CLI arg (opencode run). */
function argCliBackend(name: string, build: (opts: AnalyzeOpts, prompt: string) => string[]): Backend {
  return {
    name,
    kind: "cli",
    available: () => haveCommand(build({}, "x")[0]),
    async judge(annotatedDiff, ctx, opts) {
      const prompt = judgePrompt(annotatedDiff, ctx);
      const { stdout, stderr, code } = await run(build(opts, prompt));
      if (code !== 0) throw new Error(`${name} exited ${code}: ${stderr.slice(0, 500)}`);
      return extractJudge(stdout);
    },
    async explain(annotatedDiff, ctx, findingsSummary, opts) {
      const prompt = explainPrompt(annotatedDiff, ctx, findingsSummary);
      const { stdout, stderr, code } = await run(build(opts, prompt));
      if (code !== 0) throw new Error(`${name} exited ${code}: ${stderr.slice(0, 500)}`);
      return extractExplain(stdout);
    },
  };
}

const anthropicBackend: Backend = {
  name: "anthropic",
  kind: "api",
  available: async () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  async judge(annotatedDiff, ctx, opts) {
    const client = new Anthropic();
    const stream = client.messages.stream({
      model: opts.model || process.env.PREFLIGHT_MODEL || "claude-opus-4-5",
      max_tokens: 8000,
      output_config: {
        format: zodOutputFormat(JudgeSchema),
        ...(opts.effort ? { effort: opts.effort as "high" } : {}),
      },
      messages: [{ role: "user", content: judgePrompt(annotatedDiff, ctx) }],
    });
    const message = await stream.finalMessage();
    const text = message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error(`no text in response (stop_reason: ${message.stop_reason})`);
    return JudgeSchema.parse(JSON.parse(text.text));
  },
  async explain(annotatedDiff, ctx, findingsSummary, opts) {
    const client = new Anthropic();
    const stream = client.messages.stream({
      model: opts.model || process.env.PREFLIGHT_MODEL || "claude-opus-4-5",
      max_tokens: 8000,
      output_config: {
        format: zodOutputFormat(ExplainSchema),
        ...(opts.effort ? { effort: opts.effort as "high" } : {}),
      },
      messages: [{ role: "user", content: explainPrompt(annotatedDiff, ctx, findingsSummary) }],
    });
    const message = await stream.finalMessage();
    const text = message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error(`no text in response (stop_reason: ${message.stop_reason})`);
    return ExplainSchema.parse(JSON.parse(text.text));
  },
};

/**
 * CLI-first order. Users already have agent CLIs installed.
 * Direct APIs are optional power-ups at the end.
 */
export const BACKEND_ORDER = ["pi", "claude", "codex", "amp", "opencode", "gemini", "anthropic"] as const;

export const BACKENDS: Record<string, Backend> = {
  // Agent CLIs (preferred)
  pi: stdinCliBackend("pi", (o) => ["pi", "-p", "--no-session", "--no-tools", ...modelFlag(o)]),
  claude: stdinCliBackend("claude", (o) => ["claude", "-p", ...modelFlag(o)]),
  codex: stdinCliBackend("codex", (o) => ["codex", "exec", "--skip-git-repo-check", ...modelFlag(o, "-m"), "-"]),
  // amp execute mode: prompt via stdin, only last assistant message on stdout
  amp: stdinCliBackend("amp", (o) => ["amp", "-x", "--no-notifications", ...modelFlag(o)]),
  // opencode takes the message as an arg
  opencode: argCliBackend("opencode", (o, prompt) => ["opencode", "run", ...modelFlag(o, "-m"), prompt]),
  gemini: stdinCliBackend("gemini", (o) => ["gemini", ...modelFlag(o)]),
  // Direct API (optional)
  anthropic: anthropicBackend,
};

export function getBackend(name: string): Backend {
  const b = BACKENDS[name];
  if (!b) throw new Error(`unknown backend "${name}" (known: ${BACKEND_ORDER.join(", ")})`);
  return b;
}

export async function listAvailableBackends(): Promise<Backend[]> {
  const available: Backend[] = [];
  for (const name of BACKEND_ORDER) {
    const b = BACKENDS[name];
    if (await b.available()) available.push(b);
  }
  return available;
}

export async function listAvailableCliBackends(): Promise<Backend[]> {
  return (await listAvailableBackends()).filter((b) => b.kind === "cli");
}

function noneAvailableError(): Error {
  return new Error(
    "no backend available: install one of pi, claude, codex, amp, opencode, gemini — or set ANTHROPIC_API_KEY for the optional API backend (pass --with to choose)",
  );
}

export async function resolveBackends(requested: string[] | null): Promise<Backend[]> {
  if (requested && requested.length > 0) return requested.map(getBackend);
  // Prefer CLI harnesses users already have; APIs are fallback.
  const clis = await listAvailableCliBackends();
  if (clis[0]) return [clis[0]];
  const all = await listAvailableBackends();
  if (all[0]) return [all[0]];
  throw noneAvailableError();
}

/** Prefer two CLI judges when available; fall back to any two backends. */
export async function resolveStrictJudges(requested: string[] | null): Promise<Backend[]> {
  if (requested && requested.length > 0) return requested.map(getBackend);

  const clis = await listAvailableCliBackends();
  if (clis.length >= 2) return clis.slice(0, 2);
  if (clis.length === 1) {
    const all = await listAvailableBackends();
    const second = all.find((b) => b.name !== clis[0].name);
    return second ? [clis[0], second] : clis;
  }

  const available = await listAvailableBackends();
  if (available.length === 0) throw noneAvailableError();
  return available.slice(0, Math.min(2, available.length));
}
