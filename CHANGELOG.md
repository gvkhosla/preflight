# Changelog

## 0.1.2

### Product quality
- Auto-strict when 2+ backends are available (`--no-strict` to disable)
- Delta re-review via `.preflight/last-verdict.json`
- Local verification evidence (typecheck + related tests)
- Lazy-load Shiki (agent `--json --auto` path avoids highlight cost)
- Live LLM fixture eval (`bun evals/live.ts`, skips without backend)

### Distribution / polish
- Demo UI mock + OG SVG under `docs/`
- README: npx path, demo screenshot link, clearer install matrix
- `docs/PUBLISHING.md` for npm 2FA / automation tokens

### Ops
- CI runs fixture + live (soft) evals
- Publish runbook documented

## 0.1.1

- `--version` and `preflight doctor`
- Richer context pack: changed symbols, related tests, file windows
- First-class agreement/confidence badges in UI
- Safer approve UX when blockers remain
- Fixture eval harness + CI workflow
- README rewrite for 30-second start

## 0.1.0

- Initial release: split judge/explain, grounding, multi-judge merge, browser verdict UI
