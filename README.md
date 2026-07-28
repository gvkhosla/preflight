# preflight

> After your coding agent says “done,” run **preflight**.

Local ship gate for agent-built software: multi-judge findings, grounded against the real diff, one executable verdict.

```sh
npm install -g @khosla/preflight
preflight doctor          # check setup
preflight                 # review your current diff
preflight --json --auto --strict   # agent mode
```

Exit codes: **`0` approved** · **`2` changes requested** · **`1` error**

---

## 30-second start

1. Install
   ```sh
   npm install -g @khosla/preflight
   # or: npx @khosla/preflight doctor
   ```
2. Need one LLM backend:
   - `export ANTHROPIC_API_KEY=...` **or**
   - `claude` / `codex` / `gemini` / `pi` on your PATH
3. In a dirty git repo:
   ```sh
   preflight
   ```
4. Browser opens → keep/dismiss findings → **Looks good** or **Request changes**  
   Verdict prints on stdout for you or your agent.

```text
preflight: packing context for 3 hunks across 2 files…
preflight: code context attached (symbols/tests/files)
preflight: judging with anthropic…
preflight: 1 judge(s), 2 merged finding(s), 0 high-agreement
preflight: writing walkthrough with anthropic…
preflight: review at http://127.0.0.1:52341
```

```text
Preflight: CHANGES REQUESTED

Summary: Greet now rejects blank names.
Intent: Fail fast on empty input.

Findings (1):

F1 [should-fix/missing-test agree=1/1 conf=medium] No test for blank name
  where: src/greet.ts:2
  why: New throw path is untested
  action: Add a unit test for blank name

Agent instructions: fix each open blocker/should-fix finding, then re-run preflight.
```

---

## Agent mode

```sh
preflight --json --auto --strict
```

```json
{
  "status": "changes_requested",
  "summary": "…",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "agreement": "2/2",
      "confidence": "high",
      "where": "src/auth/middleware.ts:12",
      "action": "…"
    }
  ]
}
```

### Drop into `AGENTS.md` / `CLAUDE.md`

```text
After a non-trivial change, run `preflight --json --auto` (add --strict before ship).
- status approved (exit 0) → continue
- otherwise fix each open finding by id, then re-run preflight
```

Also see [`AGENTS.md`](./AGENTS.md) in this repo.

---

## What it does

```
diff + git intent + symbols/tests + optional pickbrain
        ↓
  judge A ──┐
  judge B ──┴→ ground → merge (agreement / confidence)
        ↓
   explainer (walkthrough only)
        ↓
  UI or --auto → APPROVED | CHANGES REQUESTED
```

| Layer | Job |
|---|---|
| **Judge(s)** | Findings only — blockers, should-fix, nits |
| **Ground** | Drop/downgrade findings that don’t hit real hunks |
| **Merge** | Multi-judge agreement; lone blockers under 2 judges demote |
| **Explain** | Short human walkthrough (not mixed into judgment) |
| **Context** | Branch/commits, changed symbols, related tests, file windows |

---

## Commands

```sh
preflight                         # uncommitted changes
preflight main...HEAD             # branch range
preflight --strict                # 2 judges when available
preflight --json --auto --strict  # headless agent loop
preflight --with anthropic,codex  # explicit judges
git diff -U10 | preflight         # piped diff
preflight doctor                  # readiness check
preflight --version
```

| Flag | Effect |
|---|---|
| `--strict` | Prefer 2 diverse judges + merge |
| `--with a,b` | Explicit judge list |
| `--auto` | No browser |
| `--json` | Machine-readable stdout |
| `--no-recall` | Skip pickbrain if present |
| `--model` / `--effort` | Backend tuning |
| `--no-open` | Print URL only |

### Env

| Var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic backend |
| `PREFLIGHT_MODEL` | Default model (anthropic) |
| `PREFLIGHT_NO_RECALL=1` | Disable pickbrain |
| `PREFLIGHT_RECALL_SINCE` | Memory window (default `90d`) |

Optional: if a `pickbrain` binary is on your `PATH`, preflight attaches local session memory as precedent. No account required.

---

## Install options

```sh
npm install -g @khosla/preflight
bun install -g @khosla/preflight
npx @khosla/preflight doctor
bun install -g github:gvkhosla/preflight
```

Package: **`@khosla/preflight`** · CLI binary: **`preflight`** · Repo: **`gvkhosla/preflight`**

---

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build
bun evals/score.ts      # fixture / plumbing health
```

CI runs tests, typecheck, build, and fixture evals on every push.

---

## License

MIT © Geet Khosla
