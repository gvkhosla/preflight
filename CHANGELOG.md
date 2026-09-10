# Changelog

## 0.2.3

- `preflight doctor --json` includes `ok` so agents can branch without parsing `status`.

## 0.2.2

- `preflight doctor --json` prints the same readiness report as JSON for agents and CI.

## 0.2.1

- Doctor treats missing agent CLIs and API backends as optional, not failures.
- Status is still NOT READY only when nothing can judge a diff.
- Version bump for the npm package and `preflight --version`.

## 0.2.0

- Evidence Gate v1: repository-native typecheck, lint, test, and build discovery
- Language checks for Cargo, Go, and pytest projects
- Authoritative verification failures that models and UI approval cannot override
- Complete default working-tree capture, including untracked files without index mutation
- Finding lifecycle across reruns: new, persisting, and resolved
- Structured verification evidence in browser, text, and JSON verdicts
- Per-command timeouts and duration/output reporting

## 0.1.7

- Cohesive visual redesign across landing page, review UI, generated reports, and social image
- Warm-black instrument-panel identity with Geist and Geist Mono
- Flatter information hierarchy, stronger verdict focus, and refined mobile behavior

## 0.1.6

- Mobile-first review UI + demo (no header wrap/overflow)
- Uniform Geist design system across site, demo, and report UI
- Simpler onboarding: `npx @khosla/preflight` as the default path
- Version sync push to npm

## 0.1.5

- CLI-first backends: pi, claude, codex, amp, opencode, gemini (preferred)
- Anthropic API moved to optional power-up (last in auto-detect)
- Auto-strict prefers two agent CLIs when available
- doctor distinguishes CLI vs API backends

## 0.1.4

- Website + OG image redesigned closer to diffs.com
- Geist + Geist Mono (same family as Diffs.com; Berkeley Mono is proprietary)
- Self-hosted font files on GitHub Pages

## 0.1.3

- Review UI redesigned: Inter + IBM Plex Mono, Diffs.com-inspired minimal dark chrome
- Diff snippets rendered with `@pierre/diffs` (SSR stacked/unified + Shiki themes)
- Demo/OG visuals refreshed to match

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
