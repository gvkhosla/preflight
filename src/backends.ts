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

function cliBackend(name: string, argv: (opts: AnalyzeOpts) => string[]): Backend {
  return {
    name,
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

const modelFlag = (o: AnalyzeOpts, flag = "--model") => (o.model ? [flag, o.model] : []);

const anthropicBackend: Backend = {
  name: "anthropic",
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

export const BACKENDS: Record<string, Backend> = {
  anthropic: anthropicBackend,
  claude: cliBackend("claude", (o) => ["claude", "-p", ...modelFlag(o)]),
  codex: cliBackend("codex", (o) => ["codex", "exec", "--skip-git-repo-check", ...modelFlag(o, "-m"), "-"]),
  gemini: cliBackend("gemini", (o) => ["gemini", ...modelFlag(o)]),
  pi: cliBackend("pi", (o) => ["pi", "-p", "--no-session", "--no-tools", ...modelFlag(o)]),
};

export function getBackend(name: string): Backend {
  const b = BACKENDS[name];
  if (!b) throw new Error(`unknown backend "${name}" (known: ${Object.keys(BACKENDS).join(", ")})`);
  return b;
}

export async function resolveBackends(requested: string[] | null): Promise<Backend[]> {
  if (requested && requested.length > 0) return requested.map(getBackend);
  for (const backend of Object.values(BACKENDS)) {
    if (await backend.available()) return [backend];
  }
  throw new Error(
    "no backend available: set ANTHROPIC_API_KEY, or install one of: claude, codex, gemini, pi (or pass --with)",
  );
}

/** Prefer two diverse available backends for strict mode. */
export async function resolveStrictJudges(requested: string[] | null): Promise<Backend[]> {
  if (requested && requested.length > 0) return requested.map(getBackend);

  const available: Backend[] = [];
  for (const b of Object.values(BACKENDS)) {
    if (await b.available()) available.push(b);
  }
  if (available.length === 0) {
    throw new Error(
      "no backend available: set ANTHROPIC_API_KEY, or install one of: claude, codex, gemini, pi",
    );
  }
  if (available.length === 1) return available;

  const anthropic = available.find((b) => b.name === "anthropic");
  const other = available.find((b) => b.name !== "anthropic");
  if (anthropic && other) return [anthropic, other];
  return available.slice(0, 2);
}
