# Using preflight with coding agents

After a non-trivial change:

```sh
preflight --json --auto
# before ship / PR:
preflight --json --auto --strict
```

Interpret the result:

- **exit 0** / `"status": "approved"` → continue
- **exit 2** / `"status": "changes_requested"` → fix each open finding by `id`, then re-run on the residual diff
- **exit 1** → tool/setup error; run `preflight doctor`

Do not mark the task done while open `blocker` or `should-fix` findings remain (unless the human explicitly approved anyway).
