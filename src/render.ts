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
                <span class="agree-pill" title="Judge agreement">${esc(f.agreement)} agree</span>
                <span class="conf-pill ${confClass(f.confidence)}">${esc(f.confidence)} confidence</span>
              </div>
              <h3>${esc(f.id)} · ${esc(f.title)}</h3>
            </header>
            <p class="where">${esc(f.where)}${judges ? ` · ${esc(judges)}` : ""}</p>
            <p class="why">${esc(f.why).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
            <p class="action"><span>Fix</span><span>${esc(f.action).replace(/`([^`]+)`/g, "<code>$1</code>")}</span></p>
            ${!f.grounded && f.groundReason ? `<p class="muted">Ungrounded: ${esc(f.groundReason)}</p>` : ""}
            ${snippet}
            <div class="finding-actions">
              <div class="segments" role="group" aria-label="Decision for ${esc(f.id)}">
                <label class="seg"><input type="radio" name="f-${esc(f.id)}" value="accepted" checked><span>Keep</span></label>
                <label class="seg"><input type="radio" name="f-${esc(f.id)}" value="dismissed"><span>Dismiss</span></label>
              </div>
              <input class="fnote" type="text" name="note-${esc(f.id)}" aria-label="Note for the agent about ${esc(f.id)}" placeholder="Note for the agent" data-for="${esc(f.id)}">
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
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Geist Mono";
    src: url("https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-mono/GeistMono-Variable.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  :root {
    color-scheme: dark;
    --canvas: #080908;
    --surface: #0d0e0d;
    --surface-raised: #121311;
    --surface-recessed: #090a09;
    --line: rgba(244, 243, 238, 0.10);
    --line-strong: rgba(244, 243, 238, 0.18);
    --ink: #f4f3ee;
    --ink-soft: #c3c1bb;
    --muted: #91908a;
    --dim: #62625d;
    --signal: #9de8bf;
    --signal-ink: #06130b;
    --danger: #ff7b7f;
    --warning: #e9b65e;
    --font: "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --page: 1120px;
    --radius: 10px;
    --pad: clamp(18px, 4vw, 32px);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow-x: hidden; background: var(--canvas); color: var(--ink); }
  body {
    min-width: 320px;
    min-height: 100svh;
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  button, input, textarea { font: inherit; }
  button { color: inherit; }
  ::selection { background: rgba(157, 232, 191, 0.24); color: var(--ink); }
  code, .where, .mono { font-family: var(--mono); }
  code {
    border: 1px solid var(--line);
    border-radius: 5px;
    background: rgba(244, 243, 238, 0.04);
    padding: 0.12rem 0.36rem;
    color: var(--ink-soft);
    font-size: 0.86em;
  }

  header.app {
    position: sticky;
    top: 0;
    z-index: 20;
    border-bottom: 1px solid var(--line);
    background: rgba(8, 9, 8, 0.94);
    backdrop-filter: blur(16px);
  }
  .app-inner {
    display: grid;
    max-width: var(--page);
    min-height: 62px;
    align-items: center;
    gap: 10px;
    margin: 0 auto;
    padding: max(10px, env(safe-area-inset-top)) var(--pad) 10px;
  }
  .app-identity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 13px;
  }
  .wordmark {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 9px;
    font-weight: 580;
    letter-spacing: -0.025em;
  }
  .wordmark-mark {
    position: relative;
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    border: 1px solid var(--line-strong);
    border-radius: 5px;
  }
  .wordmark-mark::before,
  .wordmark-mark::after {
    position: absolute;
    left: 4px;
    width: 8px;
    height: 2px;
    border-radius: 1px;
    background: var(--ink);
    content: "";
  }
  .wordmark-mark::before { top: 5px; }
  .wordmark-mark::after { top: 10px; background: var(--signal); }
  header.app h1 {
    min-width: 0;
    overflow: hidden;
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.84rem;
    font-weight: 480;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  header.app h1::before { margin-right: 13px; color: var(--dim); content: "/"; }
  .pills { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; }
  .pill {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 7px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
    background: rgba(244, 243, 238, 0.025);
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill::before {
    width: 5px;
    height: 5px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: currentColor;
    content: "";
  }
  .pill.bad { border-color: rgba(255, 123, 127, 0.24); color: var(--danger); }
  .pill.ok { border-color: rgba(157, 232, 191, 0.24); color: var(--signal); }
  .pill.backend::before { display: none; }

  main.review {
    display: grid;
    min-width: 0;
    max-width: var(--page);
    margin: 0 auto;
    padding: clamp(28px, 5vw, 56px) var(--pad) 220px;
    gap: clamp(32px, 5vw, 64px);
  }
  .summary { min-width: 0; }
  .eyebrow,
  .label {
    margin: 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .eyebrow::before,
  .label::before {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 9px;
    border-radius: 50%;
    background: var(--signal);
    content: "";
    vertical-align: 1px;
  }
  .summary-title {
    max-width: 17ch;
    margin: 16px 0 0;
    font-size: clamp(2rem, 5vw, 3.5rem);
    font-weight: 560;
    letter-spacing: -0.048em;
    line-height: 1.02;
    text-wrap: balance;
  }
  .summary .prose { max-width: 42ch; margin-top: 20px; }
  .prose p { margin: 0 0 10px; color: var(--ink-soft); text-wrap: pretty; }
  .prose p:last-child { margin-bottom: 0; }
  .intent {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    margin: 18px 0 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .intent strong,
  .action > span:first-child {
    color: var(--signal);
    font-family: var(--mono);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .summary-meta {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 28px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .summary-meta > div { padding: 14px 12px 14px 0; }
  .summary-meta > div + div { border-left: 1px solid var(--line); padding-left: 12px; }
  .summary-meta dt {
    color: var(--dim);
    font-family: var(--mono);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .summary-meta dd {
    margin: 4px 0 0;
    font-family: var(--mono);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .review-content, .findings, .finding { width: 100%; min-width: 0; }
  .finding h3, .why, .action { overflow-wrap: anywhere; }
  .section-title {
    display: flex;
    align-items: baseline;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px;
  }
  .section-title h2,
  .section > h2 {
    margin: 0;
    color: var(--ink);
    font-size: 0.75rem;
    font-weight: 560;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .section-count { color: var(--dim); font-family: var(--mono); font-size: 0.68rem; }
  .empty {
    margin: 0;
    border-bottom: 1px solid var(--line);
    padding: 28px 0;
    color: var(--muted);
  }

  .finding { padding: clamp(22px, 4vw, 34px) 0; border-bottom: 1px solid var(--line); }
  .finding-head { display: grid; gap: 16px; }
  .finding-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge, .kind, .agree-pill, .conf-pill {
    display: inline-flex;
    min-height: 24px;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 3px 7px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
  }
  .badge { text-transform: lowercase; }
  .sev-blocker .badge { border-color: rgba(255, 123, 127, 0.28); color: var(--danger); }
  .sev-should-fix .badge { border-color: rgba(233, 182, 94, 0.28); color: var(--warning); }
  .sev-nit .badge { color: var(--muted); }
  .conf-high { border-color: rgba(157, 232, 191, 0.24); color: var(--signal); }
  .conf-med { border-color: rgba(233, 182, 94, 0.24); color: var(--warning); }
  .finding h3 {
    max-width: 28ch;
    margin: 0;
    font-size: clamp(1.35rem, 3vw, 1.8rem);
    font-weight: 560;
    letter-spacing: -0.035em;
    line-height: 1.14;
    text-wrap: balance;
  }
  .where { margin: 10px 0 0; color: var(--dim); font-size: 0.72rem; word-break: break-all; }
  .why { max-width: 58ch; margin: 18px 0 0; color: var(--ink-soft); text-wrap: pretty; overflow-wrap: anywhere; }
  .action {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    margin: 13px 0 22px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .muted { color: var(--muted); }

  .pierre-host,
  .pierre-fallback {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow: auto;
    margin: 18px 0 4px;
    border: 1px solid var(--line);
    border-radius: min(1.4vw, var(--radius));
    background: var(--surface-recessed);
    -webkit-overflow-scrolling: touch;
  }
  .pierre-host > * { max-width: 100%; }
  .pierre-host pre,
  .pierre-host code { word-break: normal; overflow-wrap: normal; font-family: var(--mono); }
  .pierre-fallback-head {
    border-bottom: 1px solid var(--line);
    padding: 8px 12px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .pierre-fallback pre {
    margin: 0;
    overflow: auto;
    padding: 12px;
    color: var(--ink-soft);
    font-family: var(--mono);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .note { margin: 8px 0 18px; color: var(--muted); font-size: 0.9rem; }

  .finding-actions {
    display: grid;
    gap: 10px;
    margin-top: 18px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
  }
  .segments { display: flex; gap: 6px; }
  .seg { cursor: pointer; user-select: none; }
  .seg input { position: absolute; opacity: 0; pointer-events: none; }
  .seg span {
    display: inline-flex;
    min-height: 34px;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--muted);
    font-size: 0.76rem;
  }
  .seg input:checked + span {
    border-color: var(--line-strong);
    background: rgba(244, 243, 238, 0.06);
    color: var(--ink);
  }
  .fnote, textarea {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 7px;
    outline: 0;
    background: var(--surface-recessed);
    padding: 9px 11px;
    color: var(--ink);
    font-size: 1rem;
  }
  .fnote { min-height: 42px; min-width: 0; }
  textarea { min-height: 48px; resize: vertical; }
  .fnote::placeholder, textarea::placeholder { color: var(--dim); }
  .fnote:focus, textarea:focus {
    border-color: rgba(157, 232, 191, 0.45);
    outline: 2px solid rgba(157, 232, 191, 0.12);
    outline-offset: 0;
  }

  .walkthrough, .section { margin-top: 48px; }
  .walkthrough .section { margin-top: 28px; }
  .section > h2 { border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .section .prose { margin-top: 18px; }
  .qlist { margin: 18px 0 0; padding-left: 20px; color: var(--muted); }

  footer.bar {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    border-top: 1px solid var(--line);
    background: rgba(8, 9, 8, 0.95);
    backdrop-filter: blur(16px);
  }
  footer.bar .inner {
    display: grid;
    max-width: var(--page);
    gap: 10px;
    margin: 0 auto;
    padding: 12px var(--pad) max(12px, env(safe-area-inset-bottom));
  }
  .btns { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; align-items: center; }
  .hint { flex: 1 1 100%; color: var(--muted); font-size: 0.78rem; }
  button {
    min-width: 0;
    min-height: 40px;
    flex: 1 1 calc(50% - 4px);
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 8px 13px;
    font-size: 0.875rem;
    font-weight: 560;
    line-height: 1;
    cursor: pointer;
  }
  button.secondary { border-color: var(--line-strong); background: rgba(244, 243, 238, 0.035); color: var(--ink); }
  button.secondary:hover { background: rgba(244, 243, 238, 0.07); }
  button.good { border-color: var(--signal); background: var(--signal); color: var(--signal-ink); }
  button.good:hover { border-color: #b0efcb; background: #b0efcb; }
  button:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  #done-view { display: none; max-width: 520px; margin: 0 auto; padding: 24vh var(--pad); text-align: left; }
  #done-view h2 {
    max-width: 14ch;
    margin: 0;
    font-size: clamp(2rem, 6vw, 3.5rem);
    font-weight: 560;
    letter-spacing: -0.048em;
    line-height: 1.02;
  }
  #done-view p { margin: 18px 0 0; }

  @media (min-width: 760px) {
    .app-inner { grid-template-columns: minmax(0, 1fr) auto; }
    .pills { justify-content: flex-end; }
    main.review { grid-template-columns: minmax(230px, 3fr) minmax(0, 7fr); }
    .summary { position: sticky; top: 94px; align-self: start; }
    .finding-actions { grid-template-columns: auto minmax(180px, 1fr); align-items: center; }
    footer.bar .inner { grid-template-columns: minmax(220px, 1fr) auto; align-items: end; }
    .btns { justify-content: flex-end; }
    .hint { flex: 1 1 auto; }
    button { min-width: 140px; flex: 0 0 auto; }
  }
  @media (max-width: 639px) {
    body { font-size: 16px; }
    button { min-height: 46px; }
  }
</style>
</head>
<body>
<header class="app">
  <div class="app-inner">
    <div class="app-identity">
      <span class="wordmark"><span class="wordmark-mark" aria-hidden="true"></span><span>preflight</span></span>
      <h1 title="${esc(analysis.title)}">${esc(analysis.title)}</h1>
    </div>
    <div class="pills">
      <span class="pill ${suggested === "approved" ? "ok" : "bad"}" id="suggest">${esc(statusPill)}</span>
      <span class="pill backend">${esc(backendPill)}${recallUsed ? " · memory" : ""}</span>
    </div>
  </div>
</header>
<main class="review" id="main">
  <aside class="summary">
    <p class="eyebrow">Review complete</p>
    <h2 class="summary-title">${esc(analysis.title)}</h2>
    <div class="prose">${prose(analysis.summary)}</div>
    ${analysis.intent ? `<p class="intent"><strong>Intent</strong><span>${esc(analysis.intent)}</span></p>` : ""}
    <dl class="summary-meta">
      <div><dt>Findings</dt><dd>${merged.length}</dd></div>
      <div><dt>Judges</dt><dd>${result.judges?.length || 1}</dd></div>
      <div><dt>Recall</dt><dd>${recallUsed ? "on" : "off"}</dd></div>
    </dl>
  </aside>

  <div class="review-content">
    <section class="findings">
      <div class="section-title"><h2>Findings</h2><span class="section-count">${String(merged.length).padStart(2, "0")} total</span></div>
      ${findingBlocks}
    </section>
    ${sectionBlocks.join("") ? `<div class="walkthrough"><div class="section-title"><h2>Walkthrough</h2></div>${sectionBlocks.join("")}</div>` : ""}
    ${questions}
  </div>
</main>

<footer class="bar" id="bar">
  <div class="inner">
    <textarea id="notes" name="notes" aria-label="Optional notes for the agent" placeholder="Optional notes for the agent"></textarea>
    <div class="btns">
      <span class="hint" id="hint"></span>
      <button class="secondary" id="raw" type="button">Request changes</button>
      <button class="good" id="approve" type="button">Looks good</button>
      <button class="secondary" id="force" type="button" hidden>Approve anyway</button>
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
    approve.hidden = true;
    force.hidden = false;
    hint.textContent = n + " actionable finding" + (n === 1 ? " remains." : "s remain.");
  } else {
    approve.hidden = false;
    force.hidden = true;
    hint.textContent = "All actionable findings are dismissed.";
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
