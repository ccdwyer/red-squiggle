# Red Squiggle

A Claude Code mod that type-checks and lints the file Claude just edited and puts any errors into that same tool result. The model sees broken types on the step that caused them, not three turns later when a test run fails.

Red Squiggle runs after each successful Edit or Write. It skips edits that errored and edits staged for review.

| File | Checker | Notes |
|---|---|---|
| `.ts .tsx .js .jsx .mts .cts .mjs .cjs` | the project's own TypeScript (`node_modules/typescript/bin/tsc`) | Runs `--noEmit --incremental` on the config whose program contains the file. If the nearest `tsconfig.json` is a solution file (`files: []` with references), it follows the reference that covers the file. A build-info file goes under `node_modules/.cache/red-squiggle/`. |
| same | the project's own `node_modules/.bin/eslint` | Only when an eslint config exists. Runs from that config's folder with `--format json --quiet`, so it reports errors only. |
| `.py` | `ruff check --no-fix` | Uses `.venv/bin/ruff`, then `venv/bin/ruff`, then `ruff` on PATH. JSON output. |

- **Only new errors.** Red Squiggle remembers what each checker reported last time. After an edit, the model sees errors this edit introduced in the file, plus errors newly broken in *other* files (tsc). Errors that were already there are counted, not repeated. On the first check of a session there is no baseline, so the file's errors are labelled "may predate your edit".
- The output reaches the model as quoted context after the tool result, capped at 20 lines and marked as data, not instructions.
- The status line shows `✓ file clean` or `✗ N errors in file`. "Clean" means a checker really checked the file. A file outside every tsconfig program is skipped, not called clean.
- Fail-open. If a checker is missing, crashes or times out (default 30 s), or if anything else after the write throws, the edit's result comes back untouched.
- Only one tsc runs per project at a time. Edits that arrive during a run share a single follow-up run.
- Project lookups stop at the repository root (`.git`). It never installs anything or falls back to `npx`.

## Settings

`/config` lists `tsc`, `eslint` and `ruff` toggles and `timeoutSeconds`.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install red-squiggle@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```
