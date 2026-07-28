import { hunkById, type DiffFile, type Hunk } from "./diff";
import type { MergedFinding } from "./merge";
import type { PipelineResult } from "./pipeline";

// shiki is loaded lazily so --json/--auto agent runs never pay for highlighting.
type Highlighter = {
  codeToTokens: (
    code: string,
    opts: { lang: never; themes: { light: string; dark: string } },
  ) => { tokens: { htmlStyle?: string | Record<string, string>; color?: string; content: string }[][] };
};

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  rb: "ruby", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  html: "html", css: "css", scss: "scss", json: "json", yml: "yaml", yaml: "yaml",
  toml: "toml", md: "markdown", sql: "sql", vue: "vue", svelte: "svelte",
};

function langFor(path: string, bundled?: Record<string, unknown>): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = LANG_BY_EXT[ext];
  if (!lang) return "text";
  if (bundled && !(lang in bundled)) return "text";
  return lang;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function prose(text: string): string {
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${esc(p).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`)
    .join("");
}

function tokenStyle(token: { htmlStyle?: string | Record<string, string>; color?: string }): string {
  if (token.htmlStyle) {
    if (typeof token.htmlStyle === "string") return token.htmlStyle;
    return Object.entries(token.htmlStyle)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
  }
  return token.color ? `color:${token.color}` : "";
}

function renderHunk(
  hl: Highlighter | null,
  file: DiffFile,
  hunk: Hunk,
  range?: { from: number; to: number } | null,
  bundled?: Record<string, unknown>,
): string {
  const lang = langFor(file.path, bundled);
  const code = hunk.lines.map((l) => l.text).join("\n");
  let tokenLines: { htmlStyle?: string | Record<string, string>; color?: string; content: string }[][];
  try {
    if (!hl) throw new Error("no highlighter");
    tokenLines = hl.codeToTokens(code, {
      lang: lang as never,
      themes: { light: "github-light", dark: "github-dark" },
    }).tokens;
  } catch {
    tokenLines = hunk.lines.map((l) => [{ content: l.text }]);
  }

  let indices = hunk.lines.map((_, i) => i);
  if (range) {
    const within = (n: number | null) => n != null && n >= range.from && n <= range.to;
    const sliced = indices.filter((i) => within(hunk.lines[i].newNo) || within(hunk.lines[i].oldNo));
    if (sliced.length > 0) indices = sliced;
  }

  const rows = indices.map((i) => {
    const line = hunk.lines[i];
    const tokens = tokenLines[i] ?? [{ content: line.text }];
    const codeHtml =
      tokens.map((t) => `<span style="${esc(tokenStyle(t))}">${esc(t.content)}</span>`).join("") || "&nbsp;";
    return `<tr class="${line.kind}">
      <td class="g">${line.oldNo ?? ""}</td><td class="g">${line.newNo ?? ""}</td>
      <td class="m">${line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
      <td class="c">${codeHtml}</td>
    </tr>`;
  });

  return `<div class="hunk">
    <div class="hunk-head"><span class="path">${esc(file.path)}</span></div>
    <table class="diff"><tbody>${rows.join("")}</tbody></table>
  </div>`;
}

function confClass(c: MergedFinding["confidence"]): string {
  return c === "high" ? "conf-high" : c === "low" ? "conf-low" : "conf-med";
}

export async function renderReport(result: PipelineResult, files: DiffFile[], recallUsed: boolean): Promise<string> {
  const analysis = result.analysis;
  const backend = result.backend;
  const agree = result.agreementSummary ?? "";
  const merged = result.mergedFindings;
  let hl: Highlighter | null = null;
  let bundled: Record<string, unknown> | undefined;
  try {
    const shiki = await import("shiki");
    bundled = shiki.bundledLanguages as unknown as Record<string, unknown>;
    const langs = [...new Set(files.map((f) => langFor(f.path, bundled)).filter((l) => l !== "text"))];
    hl = (await shiki.createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: langs as never[],
    })) as unknown as Highlighter;
  } catch {
    hl = null;
  }
  const hunks = hunkById(files);

  const blockers = merged.filter((f) => f.severity === "blocker").length;
  const should = merged.filter((f) => f.severity === "should-fix").length;
  const nits = merged.filter((f) => f.severity === "nit").length;
  const suggested = blockers + should > 0 ? "changes_requested" : "approved";

  const sections = analysis.sections
    .map((s) => {
      const snippets = s.snippets
        .map((sn) => {
          const found = hunks.get(sn.hunk_id);
          if (!found) return `<p class="muted">unknown hunk ${esc(sn.hunk_id)}</p>`;
          const range = sn.from != null && sn.to != null ? { from: sn.from, to: sn.to } : null;
          const note = sn.note.trim() ? `<p class="note">${esc(sn.note).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>` : "";
          return renderHunk(hl, found.file, found.hunk, range, bundled) + note;
        })
        .join("");
      return `<section class="section">
        <h2>${esc(s.heading)}</h2>
        <div class="prose">${prose(s.intro)}</div>
        ${snippets}
      </section>`;
    })
    .join("");

  const findings = merged.length
    ? merged
        .map((f) => {
          const snippet =
            f.hunk_id && hunks.has(f.hunk_id)
              ? renderHunk(
                  hl,
                  hunks.get(f.hunk_id)!.file,
                  hunks.get(f.hunk_id)!.hunk,
                  f.from != null && f.to != null ? { from: f.from, to: f.to } : null,
                  bundled,
                )
              : "";
          const judges = f.judges?.length ? f.judges.join(", ") : "";
          return `<article class="finding sev-${esc(f.severity)}" data-id="${esc(f.id)}" data-severity="${esc(f.severity)}">
            <header>
              <span class="badge">${esc(f.severity)}</span>
              <span class="kind">${esc(f.kind)}</span>
              <span class="agree-pill" title="Judge agreement">${esc(f.agreement)}</span>
              <span class="conf-pill ${confClass(f.confidence)}">${esc(f.confidence)}</span>
              <strong>${esc(f.id)} · ${esc(f.title)}</strong>
            </header>
            ${judges ? `<p class="judges">judges: ${esc(judges)}</p>` : ""}
            <p class="where">${esc(f.where)}</p>
            <p>${esc(f.why).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
            <p class="action"><span>Fix:</span> ${esc(f.action).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
            ${!f.grounded && f.groundReason ? `<p class="muted">ungrounded: ${esc(f.groundReason)}</p>` : ""}
            ${snippet}
            <div class="finding-actions">
              <label><input type="radio" name="f-${esc(f.id)}" value="accepted" checked> Keep</label>
              <label><input type="radio" name="f-${esc(f.id)}" value="dismissed"> Dismiss</label>
              <input class="fnote" type="text" placeholder="Optional note for agent" data-for="${esc(f.id)}">
            </div>
          </article>`;
        })
        .join("")
    : `<p class="muted">No findings. Looks clean from static review.</p>`;

  const questions = analysis.questions.length
    ? `<section class="section"><h2>Open questions</h2><ul>${analysis.questions
        .map((q) => `<li>${esc(q)}</li>`)
        .join("")}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(analysis.title)} — preflight</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #fff;
    --border: #e7e5e4; --accent: #4f46e5; --add: #dafbe1; --del: #ffebe9;
    --blocker: #b91c1c; --should: #c2410c; --nit: #57534e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --card: #1c1917;
      --border: #292524; --add: #12261e; --del: #2d1214;
    }
    .diff span[style] { color: var(--shiki-dark, inherit) !important; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: var(--bg); color: var(--fg);
  }
  header.app {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 12px; align-items: center;
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px);
  }
  header.app .brand { color: var(--muted); font-size: 13px; font-weight: 600; letter-spacing: .02em; }
  header.app h1 { flex: 1; margin: 0; font: 600 17px/1.3 ui-serif, Georgia, serif; }
  .pill {
    font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted);
  }
  .pill.bad { color: #b91c1c; border-color: color-mix(in srgb, #b91c1c 35%, var(--border)); }
  .pill.ok { color: #047857; border-color: color-mix(in srgb, #047857 35%, var(--border)); }
  main { max-width: 880px; margin: 0 auto; padding: 24px 20px 160px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  .label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
  .prose p, .section p { margin: 6px 0; }
  .muted { color: var(--muted); }
  .note { color: var(--muted); font-size: 13.5px; margin: 8px 0 16px; }
  h2 { font: 600 18px/1.3 ui-serif, Georgia, serif; margin: 28px 0 8px; }
  code {
    font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: color-mix(in srgb, var(--border) 55%, transparent);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  }
  .hunk {
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    margin: 10px 0 14px; background: var(--card);
  }
  .hunk-head {
    padding: 6px 10px; border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--border) 35%, transparent);
    font: 12px ui-monospace, Menlo, monospace;
  }
  .diff { width: 100%; border-collapse: collapse; font: 12.5px/1.5 ui-monospace, Menlo, monospace; }
  .diff td { padding: 0 8px; white-space: pre-wrap; word-break: break-word; vertical-align: top; }
  .diff .g { width: 1%; color: var(--muted); text-align: right; user-select: none; }
  .diff .m { width: 1%; color: var(--muted); user-select: none; }
  .diff tr.add td { background: var(--add); }
  .diff tr.del td { background: var(--del); }
  .finding { border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin: 10px 0; background: var(--card); }
  .finding header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 6px; }
  .badge {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 8px; border-radius: 999px; color: #fff;
  }
  .sev-blocker .badge { background: var(--blocker); }
  .sev-should-fix .badge { background: var(--should); }
  .sev-nit .badge { background: var(--nit); }
  .kind { color: var(--muted); font-size: 12px; }
  .agree-pill, .conf-pill {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted);
  }
  .conf-high { color: #047857; border-color: color-mix(in srgb, #047857 40%, var(--border)); }
  .conf-med { color: #b45309; border-color: color-mix(in srgb, #b45309 40%, var(--border)); }
  .conf-low { color: var(--muted); }
  .judges { font-size: 12px; color: var(--muted); margin: 0 0 4px; }
  .where { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }
  .action span { font-weight: 700; color: var(--accent); }
  .finding-actions {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);
    font-size: 13px; color: var(--muted);
  }
  .finding-actions .fnote {
    flex: 1; min-width: 180px; border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 8px; background: transparent; color: inherit;
  }
  footer.bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(10px);
    padding: 12px 20px 16px;
  }
  footer.bar .inner { max-width: 880px; margin: 0 auto; display: grid; gap: 10px; }
  textarea {
    width: 100%; min-height: 64px; resize: vertical; border-radius: 10px;
    border: 1px solid var(--border); padding: 10px; background: var(--card); color: inherit;
    font: inherit;
  }
  .btns { display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
  .hint { flex: 1; font-size: 12px; color: var(--muted); }
  button {
    border: 0; border-radius: 10px; padding: 10px 16px; font: 600 14px inherit; cursor: pointer;
  }
  button.secondary { background: transparent; border: 1px solid var(--border); color: inherit; }
  button.good { background: #047857; color: #fff; }
  button.good:disabled { opacity: .45; cursor: not-allowed; }
  #done-view { display: none; text-align: center; padding: 20vh 20px; }
  #done-view h2 { font: 600 28px ui-serif, Georgia, serif; }
</style>
</head>
<body>
<header class="app">
  <span class="brand">preflight</span>
  <h1>${esc(analysis.title)}</h1>
  <span class="pill ${suggested === "approved" ? "ok" : "bad"}" id="suggest">
    ${suggested === "approved" ? "Looks shippable" : `${blockers} blocker · ${should} should-fix · ${nits} nit`}
  </span>
  <span class="pill">${esc(backend)}${agree ? " · " + esc(agree) : ""}${recallUsed ? " · memory" : ""}</span>
</header>
<main id="main">
  <div class="card">
    <div class="label">What changed</div>
    <div class="prose">${prose(analysis.summary)}</div>
    ${analysis.intent ? `<p class="muted" style="margin-top:10px"><strong>Intent:</strong> ${esc(analysis.intent)}</p>` : ""}
  </div>

  <section class="section">
    <h2>Findings</h2>
    ${findings}
  </section>

  ${sections ? `<section class="section"><h2>Walkthrough</h2>${sections}</section>` : ""}
  ${questions}
</main>

<footer class="bar" id="bar">
  <div class="inner">
    <textarea id="notes" placeholder="Optional notes for the agent…"></textarea>
    <div class="btns">
      <span class="hint" id="hint"></span>
      <button class="secondary" id="raw" type="button">Request changes</button>
      <button class="good" id="approve" type="button">Looks good</button>
      <button class="secondary" id="force" type="button" style="display:none">Approve anyway</button>
    </div>
  </div>
</footer>

<div id="done-view">
  <h2>Verdict sent</h2>
  <p class="muted">You can close this tab. The agent has the result on stdout.</p>
</div>

<script type="module">
function openBlockers() {
  return [...document.querySelectorAll(".finding")].filter((el) => {
    const sev = el.dataset.severity;
    if (sev !== "blocker" && sev !== "should-fix") return false;
    const status = el.querySelector('input[type=radio]:checked')?.value || "accepted";
    return status === "accepted";
  }).length;
}

function refreshApproveState() {
  const n = openBlockers();
  const approve = document.getElementById("approve");
  const force = document.getElementById("force");
  const hint = document.getElementById("hint");
  if (n > 0) {
    approve.style.display = "none";
    force.style.display = "";
    hint.textContent = n + " open blocker/should-fix finding(s). Dismiss them or approve anyway.";
  } else {
    approve.style.display = "";
    force.style.display = "none";
    hint.textContent = "";
  }
}

document.querySelectorAll(".finding input[type=radio]").forEach((el) => {
  el.addEventListener("change", refreshApproveState);
});
refreshApproveState();

function collectDecisions() {
  const findingDecisions = {};
  for (const el of document.querySelectorAll(".finding")) {
    const id = el.dataset.id;
    const status = el.querySelector('input[type=radio]:checked')?.value || "accepted";
    const note = el.querySelector(".fnote")?.value?.trim() || "";
    findingDecisions[id] = { status, ...(note ? { note } : {}) };
  }
  return {
    humanNotes: document.getElementById("notes").value.trim(),
    findingDecisions,
  };
}

async function submit(forceStatus) {
  const payload = { ...collectDecisions(), forceStatus };
  await fetch("/done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  document.getElementById("main").style.display = "none";
  document.getElementById("bar").style.display = "none";
  document.getElementById("done-view").style.display = "block";
}

document.getElementById("approve").addEventListener("click", () => submit("approved"));
document.getElementById("force").addEventListener("click", () => submit("approved"));
document.getElementById("raw").addEventListener("click", () => submit("changes_requested"));
</script>
</body>
</html>`;
}
