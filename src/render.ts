import type { DiffFile, Hunk } from "./diff";
import { hunkById } from "./diff";
import type { MergedFinding } from "./merge";
import type { PipelineResult } from "./pipeline";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function prose(text: string): string {
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${esc(p).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`)
    .join("");
}

function confClass(c: MergedFinding["confidence"]): string {
  return c === "high" ? "conf-high" : c === "low" ? "conf-low" : "conf-med";
}

/** Build old/new file contents from a hunk (optional line-number excerpt). */
function hunkToContents(
  file: DiffFile,
  hunk: Hunk,
  range?: { from: number; to: number } | null,
): { oldContents: string; newContents: string } {
  let lines = hunk.lines;
  if (range) {
    const within = (n: number | null) => n != null && n >= range.from && n <= range.to;
    const sliced = lines.filter((l) => within(l.newNo) || within(l.oldNo));
    if (sliced.length) lines = sliced;
  }
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const l of lines) {
    if (l.kind === "context") {
      oldLines.push(l.text);
      newLines.push(l.text);
    } else if (l.kind === "del") {
      oldLines.push(l.text);
    } else if (l.kind === "add") {
      newLines.push(l.text);
    }
  }
  // Ensure trailing newline for pierre/diff parsers
  const join = (xs: string[]) => (xs.length ? xs.join("\n") + "\n" : "");
  return { oldContents: join(oldLines), newContents: join(newLines) };
}

async function renderPierreDiff(
  path: string,
  oldContents: string,
  newContents: string,
): Promise<string> {
  try {
    const { preloadDiffHTML } = await import("@pierre/diffs/ssr");
    const html = await preloadDiffHTML({
      oldFile: { name: path, contents: oldContents },
      newFile: { name: path, contents: newContents },
      options: {
        // Stacked/unified matches our review density better than split.
        diffStyle: "unified",
        theme: { dark: "pierre-dark", light: "pierre-light" },
        disableFileHeader: false,
        overflow: "wrap",
      } as never,
    });
    return `<div class="pierre-host">${html}</div>`;
  } catch (err) {
    // Fallback: plain unified text if pierre fails in constrained envs.
    const lines = [
      ...oldContents.split("\n").filter(Boolean).map((l) => `- ${l}`),
      ...newContents.split("\n").filter(Boolean).map((l) => `+ ${l}`),
    ];
    return `<div class="pierre-fallback"><div class="pierre-fallback-head">${esc(path)}</div><pre>${esc(lines.join("\n"))}</pre><p class="muted">diff render fallback: ${esc((err as Error).message ?? "error")}</p></div>`;
  }
}

export async function renderReport(result: PipelineResult, files: DiffFile[], recallUsed: boolean): Promise<string> {
  const analysis = result.analysis;
  const backend = result.backend;
  const agree = result.agreementSummary ?? "";
  const merged = result.mergedFindings;
  const hunks = hunkById(files);

  const blockers = merged.filter((f) => f.severity === "blocker").length;
  const should = merged.filter((f) => f.severity === "should-fix").length;
  const nits = merged.filter((f) => f.severity === "nit").length;
  const suggested = blockers + should > 0 ? "changes_requested" : "approved";
  const statusPill =
    suggested === "approved"
      ? "ready"
      : [
          blockers ? `${blockers} blocker${blockers === 1 ? "" : "s"}` : "",
          should ? `${should} should-fix` : "",
          !blockers && !should && nits ? `${nits} nit${nits === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const agreeShort = (() => {
    const m = agree.match(/(\d+)\s*judge/);
    const n = m ? Number(m[1]) : result.judges?.length || 1;
    const findingsN = merged.length;
    // Compact: "pi" or "pi+codex · 2j"
    return n > 1 ? `${n}j` : "";
  })();
  const backendPill = [backend, agreeShort].filter(Boolean).join(" · ");

  // Pre-render pierre diffs (parallel).
  const sectionBlocks = await Promise.all(
    analysis.sections.map(async (s) => {
      const snippets = (
        await Promise.all(
          s.snippets.map(async (sn) => {
            const found = hunks.get(sn.hunk_id);
            if (!found) return `<p class="muted">unknown hunk ${esc(sn.hunk_id)}</p>`;
            const range = sn.from != null && sn.to != null ? { from: sn.from, to: sn.to } : null;
            const { oldContents, newContents } = hunkToContents(found.file, found.hunk, range);
            const diffHtml = await renderPierreDiff(found.file.path, oldContents, newContents);
            const note = sn.note.trim()
              ? `<p class="note">${esc(sn.note).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`
              : "";
            return diffHtml + note;
          }),
        )
      ).join("");
      return `<section class="section">
        <h2>${esc(s.heading)}</h2>
        <div class="prose">${prose(s.intro)}</div>
        ${snippets}
      </section>`;
    }),
  );

  const findingBlocks = merged.length
    ? (
        await Promise.all(
          merged.map(async (f) => {
            let snippet = "";
            if (f.hunk_id && hunks.has(f.hunk_id)) {
              const found = hunks.get(f.hunk_id)!;
              const range = f.from != null && f.to != null ? { from: f.from, to: f.to } : null;
              const { oldContents, newContents } = hunkToContents(found.file, found.hunk, range);
              snippet = await renderPierreDiff(found.file.path, oldContents, newContents);
            }
            const judges = f.judges?.length ? f.judges.join(", ") : "";
            return `<article class="finding sev-${esc(f.severity)}" data-id="${esc(f.id)}" data-severity="${esc(f.severity)}">
            <header class="finding-head">
              <div class="finding-tags">
                <span class="badge">${esc(f.severity)}</span>
                <span class="kind">${esc(f.kind)}</span>
                <span class="agree-pill" title="Judge agreement">${esc(f.agreement)}</span>
                <span class="conf-pill ${confClass(f.confidence)}">${esc(f.confidence)}</span>
              </div>
              <h3>${esc(f.id)} · ${esc(f.title)}</h3>
            </header>
            ${judges ? `<p class="judges">${esc(judges)}</p>` : ""}
            <p class="where">${esc(f.where)}</p>
            <p class="why">${esc(f.why).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
            <p class="action"><span>Fix</span> ${esc(f.action).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
            ${!f.grounded && f.groundReason ? `<p class="muted">ungrounded: ${esc(f.groundReason)}</p>` : ""}
            ${snippet}
            <div class="finding-actions">
              <label class="seg"><input type="radio" name="f-${esc(f.id)}" value="accepted" checked><span>Keep</span></label>
              <label class="seg"><input type="radio" name="f-${esc(f.id)}" value="dismissed"><span>Dismiss</span></label>
              <input class="fnote" type="text" placeholder="Note for agent" data-for="${esc(f.id)}">
            </div>
          </article>`;
          }),
        )
      ).join("")
    : `<p class="empty">No findings. Clean from static review.</p>`;

  const questions = analysis.questions.length
    ? `<section class="section"><h2>Open questions</h2><ul class="qlist">${analysis.questions
        .map((q) => `<li>${esc(q)}</li>`)
        .join("")}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>${esc(analysis.title)} — preflight</title>
<style>
  @font-face {
    font-family: "Geist";
    src: url("https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-sans/Geist-Variable.woff2") format("woff2");
    font-weight: 100 900; font-style: normal; font-display: swap;
  }
  @font-face {
    font-family: "Geist Mono";
    src: url("https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-mono/GeistMono-Variable.woff2") format("woff2");
    font-weight: 100 900; font-style: normal; font-display: swap;
  }
  :root {
    color-scheme: dark;
    --bg: #000000;
    --bg-elev: #0a0a0a;
    --bg-card: #111111;
    --border: #222222;
    --border-strong: #2e2e2e;
    --fg: #ededed;
    --muted: #888888;
    --faint: #666666;
    --accent: #ededed;
    --accent-soft: #161616;
    --good: #3ecf8e;
    --bad: #f2555a;
    --warn: #f5a524;
    --blocker: #f2555a;
    --should: #f5a524;
    --nit: #6b6b6b;
    --font: "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --radius: 12px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #fafafa;
      --bg-elev: #ffffff;
      --bg-card: #ffffff;
      --border: #ececec;
      --border-strong: #e0e0e0;
      --fg: #111111;
      --muted: #666666;
      --faint: #999999;
      --accent: #111111;
      --accent-soft: #f3f3f3;
      --good: #0f7b45;
      --bad: #c41c24;
      --warn: #a15c00;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: var(--font);
    font-size: 14.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  code, .where, .mono { font-family: var(--mono); font-size: 12.5px; }
  code {
    background: var(--accent-soft);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 6px;
  }

  header.app {
    position: sticky; top: 0; z-index: 20;
    padding: 12px 16px;
    padding-top: max(12px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(14px) saturate(1.2);
  }
  .app-row {
    display: flex; align-items: center; gap: 10px; min-width: 0;
  }
  .brand {
    flex: 0 0 auto;
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted);
  }
  header.app h1 {
    flex: 1 1 auto; min-width: 0; margin: 0;
    font-size: 14px; font-weight: 600; letter-spacing: -0.02em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pills {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-top: 8px;
  }
  .pill {
    display: inline-flex; align-items: center;
    font-size: 12px; font-weight: 500;
    padding: 5px 10px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted);
    background: var(--bg-elev);
    white-space: nowrap; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis;
  }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--border)); }
  .pill.ok { color: var(--good); border-color: color-mix(in srgb, var(--good) 35%, var(--border)); }

  main { max-width: 920px; margin: 0 auto; padding: 18px 16px 200px; }
  .where { word-break: break-all; }
  .why, .action, .prose p { overflow-wrap: anywhere; }

  .hero {
    padding: 8px 0 6px;
  }
  .label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--faint); margin-bottom: 10px;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 2px);
    padding: 18px 18px 16px;
    margin-bottom: 18px;
  }
  .prose p { margin: 0 0 8px; color: var(--fg); font-size: 15px; letter-spacing: -0.01em; }
  .prose p:last-child { margin-bottom: 0; }
  .intent { margin: 12px 0 0; color: var(--muted); font-size: 13.5px; }
  .intent strong { color: var(--fg); font-weight: 600; }

  h2 {
    margin: 32px 0 12px;
    font-size: 13px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--faint);
  }
  h3 {
    margin: 0;
    font-size: 15px; font-weight: 600; letter-spacing: -0.015em;
  }
  .section .prose { margin-bottom: 12px; color: var(--muted); }
  .note { color: var(--muted); font-size: 13px; margin: 8px 0 16px; }
  .muted, .empty { color: var(--muted); }
  .empty {
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    padding: 18px; text-align: center;
  }

  .finding {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 2px);
    padding: 16px;
    margin: 0 0 12px;
  }
  .finding-head { display: grid; gap: 8px; margin-bottom: 8px; }
  .finding-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .badge, .kind, .agree-pill, .conf-pill {
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    padding: 3px 8px; border-radius: 999px;
  }
  .badge { color: #fff; text-transform: uppercase; }
  .sev-blocker .badge { background: var(--blocker); }
  .sev-should-fix .badge { background: var(--should); color: #111; }
  .sev-nit .badge { background: var(--nit); }
  .kind, .agree-pill, .conf-pill {
    color: var(--muted); border: 1px solid var(--border); background: transparent;
  }
  .conf-high { color: var(--good); border-color: color-mix(in srgb, var(--good) 35%, var(--border)); }
  .conf-med { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, var(--border)); }
  .judges { margin: 0 0 4px; font-size: 12px; color: var(--faint); }
  .where { margin: 0 0 8px; color: var(--muted); }
  .why { margin: 0 0 8px; }
  .action { margin: 0 0 12px; color: var(--muted); }
  .action span {
    display: inline-block; font-weight: 600; color: var(--fg);
    margin-right: 6px; letter-spacing: 0.04em; text-transform: uppercase; font-size: 11px;
  }

  .pierre-host {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    margin: 10px 0 4px;
    background: #0a0a0a;
    max-width: 100%;
  }
  @media (prefers-color-scheme: light) {
    .pierre-host { background: #fff; }
  }
  .pierre-host > * { max-width: 100%; }
  .pierre-host pre, .pierre-host code { word-break: normal; overflow-wrap: normal; }
  .pierre-fallback {
    border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin: 10px 0;
  }
  .pierre-fallback-head {
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    font-family: var(--mono); font-size: 12px; color: var(--muted);
  }
  .pierre-fallback pre {
    margin: 0; padding: 12px; overflow: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.5;
  }

  .finding-actions {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
  }
  .seg {
    display: inline-flex; align-items: center; cursor: pointer; user-select: none;
  }
  .seg input { position: absolute; opacity: 0; pointer-events: none; }
  .seg span {
    font-size: 12px; font-weight: 500; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 5px 11px; background: transparent;
  }
  .seg input:checked + span {
    color: var(--fg); border-color: var(--border-strong); background: var(--accent-soft);
  }
  .fnote {
    flex: 1; min-width: 180px;
    border: 1px solid var(--border); border-radius: 10px;
    padding: 8px 10px; background: transparent; color: inherit;
    font: inherit;
  }
  .fnote:focus { outline: none; border-color: var(--border-strong); }

  .qlist { margin: 0; padding-left: 18px; color: var(--muted); }

  footer.bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(16px) saturate(1.2);
    padding: 12px 16px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }
  footer.bar .inner { max-width: 920px; margin: 0 auto; display: grid; gap: 10px; }
  textarea {
    width: 100%; min-height: 52px; resize: vertical;
    border-radius: 12px; border: 1px solid var(--border);
    padding: 10px 12px; background: var(--bg-card); color: inherit;
    font: inherit;
  }
  textarea:focus { outline: none; border-color: var(--border-strong); }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; justify-content: stretch; align-items: center; }
  .hint { flex: 1 1 100%; font-size: 12px; color: var(--muted); order: -1; }
  button {
    border: 0; border-radius: 999px; padding: 10px 14px;
    font: 600 13px var(--font); cursor: pointer;
    flex: 1 1 calc(50% - 4px);
  }
  button.secondary {
    background: transparent; color: var(--fg);
    border: 1px solid var(--border-strong);
  }
  button.good { background: var(--fg); color: var(--bg); }
  button.good:disabled { opacity: 0.4; cursor: not-allowed; }
  button:hover { filter: brightness(1.05); }
  @media (min-width: 720px) {
    header.app { padding: 14px 22px; }
    header.app h1 { font-size: 15px; }
    .pills { margin-top: 0; margin-left: auto; flex-wrap: nowrap; }
    header.app { display: flex; align-items: center; gap: 12px; }
    .app-row { flex: 1; min-width: 0; }
    main { padding: 28px 22px 180px; }
    .btns { justify-content: flex-end; }
    .hint { flex: 1 1 auto; order: 0; }
    button { flex: 0 0 auto; min-width: 140px; }
  }

  #done-view { display: none; text-align: center; padding: 22vh 20px; }
  #done-view h2 {
    margin: 0 0 8px; font-size: 28px; letter-spacing: -0.03em;
    text-transform: none; color: var(--fg); font-weight: 600;
  }
</style>
</head>
<body>
<header class="app">
  <div class="app-row">
    <span class="brand">preflight</span>
    <h1 title="${esc(analysis.title)}">${esc(analysis.title)}</h1>
  </div>
  <div class="pills">
    <span class="pill ${suggested === "approved" ? "ok" : "bad"}" id="suggest">${esc(statusPill)}</span>
    <span class="pill">${esc(backendPill)}${recallUsed ? " · mem" : ""}</span>
  </div>
</header>
<main id="main">
  <div class="hero card">
    <div class="label">What changed</div>
    <div class="prose">${prose(analysis.summary)}</div>
    ${analysis.intent ? `<p class="intent"><strong>Intent</strong> ${esc(analysis.intent)}</p>` : ""}
  </div>

  <h2>Findings</h2>
  ${findingBlocks}

  ${sectionBlocks.join("") ? `<h2>Walkthrough</h2>${sectionBlocks.join("")}` : ""}
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
    hint.textContent = n + " open blocker/should-fix · dismiss or approve anyway";
  } else {
    approve.style.display = "";
    force.style.display = "none";
    hint.textContent = "";
  }
}
document.querySelectorAll(".finding input[type=radio]").forEach((el) => el.addEventListener("change", refreshApproveState));
refreshApproveState();
function collectDecisions() {
  const findingDecisions = {};
  for (const el of document.querySelectorAll(".finding")) {
    const id = el.dataset.id;
    const status = el.querySelector('input[type=radio]:checked')?.value || "accepted";
    const note = el.querySelector(".fnote")?.value?.trim() || "";
    findingDecisions[id] = { status, ...(note ? { note } : {}) };
  }
  return { humanNotes: document.getElementById("notes").value.trim(), findingDecisions };
}
async function submit(forceStatus) {
  await fetch("/done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...collectDecisions(), forceStatus }),
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
