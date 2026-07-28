# preflight

> After your coding agent says “done,” run **preflight**.

Local ship gate for agent-built software: multi-judge findings, grounded against the real diff, one executable verdict.

<p align="center">
  <a href="docs/demo-ui.html"><img src="docs/og.png" alt="preflight — ship what you meant to ship" width="100%"/></a>
</p>

```sh
npm install -g @khosla/preflight
# or one-shot:
npx @khosla/preflight doctor

preflight                 # review current diff (auto-strict if 2+ backends)
preflight --json --auto   # agent mode
```

Exit codes: **`0` approved** · **`2` changes requested** · **`1` error**

**Names:** CLI `preflight` · npm `@khosla/preflight` · GitHub `gvkhosla/preflight`

---

## 30-second start

1. **Install**
   ```sh
   npm install -g @khosla/preflight
   npx @khosla/preflight doctor
   ```
2. **Backend** — set `ANTHROPIC_API_KEY` **or** have `claude` / `codex` / `gemini` / `pi` on PATH
3. **Run** in a dirty git repo:
   ```sh
   preflight
   ```
4. Browser opens → keep/dismiss findings → **Looks good** / **Request changes**  
   ([UI mock](docs/demo-ui.html))

### Sample terminal

```text
preflight: auto-strict (2 backends; --no-strict to disable)
preflight: packing context for 3 hunks across 2 files…
preflight: code context attached (symbols/tests/files)
preflight: running local verifiers…
preflight: verify — Verification soft-pass or skipped; do not invent failures.
preflight: judging with anthropic, codex…
preflight: 2 judge(s), 1 merged finding(s), 1 high-agreement
preflight: writing walkthrough with anthropic…
preflight: review at http://127.0.0.1:52341
```

```text
Preflight: CHANGES REQUESTED

Summary: Greet now rejects blank names.
Findings (1):

F1 [should-fix/missing-test agree=2/2 conf=high] No test for blank name
  where: src/greet.ts:2
  action: Add a unit test for blank name

Agent instructions: fix each open blocker/should-fix finding, then re-run preflight.
```

---

## Agent mode

```sh
preflight --json --auto
preflight --json --auto --strict     # force multi-judge
preflight --json --auto --no-strict  # single judge (faster)
```

```json
{
  "status": "changes_requested",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "agreement": "2/2",
      "confidence": "high",
      "action": "…"
    }
  ]
}
```

### `AGENTS.md` / `CLAUDE.md`

```text
After a non-trivial change, run `preflight --json --auto`.
- exit 0 approved → continue
- exit 2 → fix each open finding by id, then re-run preflight (delta re-review is automatic)
```

See [`AGENTS.md`](./AGENTS.md).

---

## What it does

```
diff + intent + symbols/tests + verify + delta + optional pickbrain
        ↓
  judge A ──┐
  judge B ──┴→ ground → merge (agreement / confidence)
        ↓
   explainer (walkthrough only)
        ↓
  UI or --auto → APPROVED | CHANGES REQUESTED
        ↓
  save .preflight/last-verdict.json (delta next time)
```

| Layer | Job |
|---|---|
| **Auto-strict** | Uses 2 judges when available |
| **Verify** | Best-effort `tsc` + related `bun test` as evidence |
| **Delta** | Re-reviews with prior open findings in mind |
| **Judge / ground / merge** | Findings only, anchored to real hunks |
| **Explain** | Short human walkthrough |
| **Diff UI** | [`@pierre/diffs`](https://diffs.com) stacked render (Shiki themes) |

---

## Commands

```sh
preflight                         # uncommitted changes
preflight main...HEAD             # branch range
preflight --json --auto           # headless agent loop
preflight --no-strict             # single judge
preflight --no-verify             # skip local typecheck/tests
preflight --no-delta              # ignore prior verdict state
git diff -U10 | preflight
preflight doctor
preflight --version
npx @khosla/preflight doctor
```

| Flag | Effect |
|---|---|
| `--strict` / `--no-strict` | Force / disable multi-judge |
| `--auto` | No browser |
| `--json` | Machine-readable stdout |
| `--no-verify` | Skip local verifiers |
| `--no-delta` | Skip delta memory |
| `--no-recall` | Skip pickbrain |
| `--with a,b` | Explicit judges |
| `--model` / `--effort` | Backend tuning |

### Env

| Var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic backend |
| `PREFLIGHT_MODEL` | Default anthropic model |
| `PREFLIGHT_NO_RECALL=1` | Disable pickbrain |
| `PREFLIGHT_RECALL_SINCE` | Memory window (default `90d`) |

If `pickbrain` is on your `PATH`, precedent memory is attached automatically.

---

## Install

```sh
npm install -g @khosla/preflight
bun install -g @khosla/preflight
npx @khosla/preflight doctor
bun install -g github:gvkhosla/preflight
```

---

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build
bun evals/score.ts      # offline fixtures
bun evals/live.ts       # optional live LLM (skips if no backend)
```

CI runs tests, typecheck, build, fixture evals, and soft live evals.

Publish notes: [`docs/PUBLISHING.md`](docs/PUBLISHING.md)

---

## License

MIT © Geet Khosla
