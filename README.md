# preflight

> Local ship gate for agent-built software.

**Judgment first.** Explain second. One verdict out.

```
diff + intent + optional pickbrain
        ↓
  judge A ──┐
  judge B ──┴→ ground → merge (agreement)
        ↓
   explainer (walkthrough only)
        ↓
  UI or --auto → APPROVED | CHANGES REQUESTED
```

## Install

```sh
# npm
npm install -g @gvkhosla/preflight

# bun
bun install -g @gvkhosla/preflight

# from GitHub
bun install -g github:gvkhosla/preflight

# or clone
git clone https://github.com/gvkhosla/preflight.git
cd preflight && bun install && bun link
```

Needs Node ≥ 20 or Bun, and one of:
- `ANTHROPIC_API_KEY`
- `claude` / `codex` / `gemini` / `pi` on PATH

Optional: [`pickbrain`](https://github.com/gvkhosla/pickbrain) for precedent memory.

## Usage

```sh
preflight                          # 1 judge + explain + browser
preflight --strict                 # 2 judges merge when possible
preflight --json --auto --strict   # agent mode, higher bar
preflight --with anthropic,codex   # explicit judges
preflight main...HEAD
```

Exit codes: `0` approved · `2` changes requested · `1` error

### Agent snippet

```text
After a non-trivial change, run `preflight --json --auto` (add --strict before ship).
- approved → continue
- otherwise fix each open finding by id, then re-run
```

## Judgment quality

1. **Split roles** — judges only emit findings; a separate pass writes the walkthrough  
2. **`--strict` multi-judge** — 2 backends when available, merged with agreement  
3. **Grounding** — findings must anchor to real hunks/lines or get downgraded/dropped  
4. **Merge rules** — lone blockers under 2 judges become `should-fix`; lone nits drop  

## Verdict shape (`--json`)

```json
{
  "status": "changes_requested",
  "summary": "...",
  "intent": "...",
  "judges": ["anthropic", "codex"],
  "agreementSummary": "2 judge(s), 1 merged finding(s), 1 high-agreement",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker",
      "agreement": "2/2",
      "confidence": "high",
      "action": "..."
    }
  ]
}
```

## Flags

| Flag | Effect |
|---|---|
| `--strict` | Prefer 2 diverse judges + merge |
| `--with a,b` | Explicit judge list |
| `--auto` | No browser |
| `--json` | Machine-readable stdout |
| `--no-recall` | Skip pickbrain |
| `--model` / `--effort` | Backend tuning |

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

MIT
