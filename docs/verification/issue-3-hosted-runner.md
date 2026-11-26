# Hosted runner verification for issue #3

**Status: local verification complete; hosted verification pending.**

No deployment, hosted database write, or GitHub change was performed while implementing issue #3. This record distinguishes the checks that passed locally from the closure evidence that still requires an approved hosted release.

## Local verification (2026-11-26)

Toolchain: Node `22.14.0`, npm `10.9.2`, local Python `3.12.3` (the deployed runner image remains `python:3.12.11-slim-bookworm`), Wrangler `4.168.0`, Vitest `5.1.1`, Zod `4.6.6`, `zod-openapi` `6.0.3`, `swagger-ui-dist` `5.36.0`.

Commands:

```sh
npm run typecheck
npm test
python3 -m unittest discover -s runner -p 'test_*.py'
```

Observed:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | Pass: 12 files / 166 tests |
| Native runner contract tests | Pass: 28 tests, including script `__main__`, stdin through EOF, empty input/output, CRLF, nonzero exit, invalid UTF-8, limits, legacy protocol 1, and the private HTTP endpoint |
| `npx wrangler deploy --dry-run` | Pass: bundled the Worker and same-origin assets without deploying |
| Local Chromium smoke | Pass: researcher can execute a GET in Swagger UI; POST operations have no Try it out. Signed-out users and members cannot fetch the docs, spec, bundle, or stylesheet. |

### Acceptance coverage reached locally

- Function and script configuration share the versioned assignment/rubric/test-suite model. Script tests are single-format and reject fields from the other variant.
- Explicit empty `stdin`/`expectedStdout` are accepted; missing API fields, duplicate IDs, non-round-tripping UTF-8, and fields over 16 KiB of UTF-8 produce actionable row errors without writes.
- Script text is stored without trimming or newline normalization. With a local D1 database and the Worker running in Wrangler, Chromium confirmed that an unchanged editor save preserves mixed LF/CRLF data from the API and that editing a textarea preserves LF, leading blank lines, and trailing spaces. Adding a row after selecting Script showed script fields; a duplicate-ID validation response preserved the draft text and format-switch warning.
- A format switch creates a new assignment version and a new single-format test suite. Unchanged saves are no-ops. Old versions and runs keep their original IDs, format, source, expectations, and evidence.
- Launches use the active version and fail stale launches with no new run.
- The native runner executes scripts as `__main__` in a fresh child, writes stdin byte-for-byte and closes it at EOF, captures stdout/stderr separately, preserves the existing 2 s / 128 MiB / 16 KiB limits, and keeps resource-limit outcomes ahead of output interpretation.
- Worker comparison uses expected stdout only after normal completion with complete valid UTF-8: CRLF→LF on both sides, remove at most one final LF, then exact comparison. `7` and `7\n` pass; `7 `, `7\n\n`, and `Answer: 7` mismatch. Invalid UTF-8 stdout is an Execution error with a bounded lossy preview and is never compared.
- Evidence shows stdin, expected stdout, recorded stdout, stderr, diagnostics, status, and a visible-whitespace view. Empty, unavailable, partial, and lossy output are distinguished by text as well as color.
- The old-migration D1 fixture applies only `0001`/`0002`, seeds a function run and a newer active version, applies `0003`, checks row counts and `PRAGMA foreign_key_check`, reopens the original evidence, and then saves, no-ops, and format-switches script data without changing the old version.
- Runtime request/response validation uses the shared Zod schemas. Function responses expose only `argumentsJson`/`expectedReturnJson`; decoded `arguments`/`expectedReturn` were removed as a documented breaking change.
- `/api/openapi.json` serves generated OpenAPI 3.1 and `/api/docs` serves pinned same-origin Swagger UI. Both the page, spec, and assets deny signed-out users and members. Swagger Try it out is limited to GET; write examples and the session/CSRF requirements are documented.

Local tests use a fake runner and the native Python contract tests. They do not prove the deployed container boundary or hosted researcher access.

## Rollout sequencing

The runner artifact is protocol 2 (`native-python-runner/2`). The runner also accepts legacy protocol 1 (`native-python-runner/1`) function jobs. New script jobs are protocol 2 only.

1. **Pause launches and drain the existing queue before changing the artifact.** Wait until queued and running test runs finish with the artifact they pinned. With launches still paused, build and deploy the issue #3 private runner. The new runner also accepts protocol 1 function requests for compatibility; this does not change the requirement to drain before replacing the hosted image.
2. **D1 migration second.** Apply `0003_script_assignments.sql` on a copy first. The migration rebuilds the cyclic assignment/run graph through parallel tables before renaming them, preserving IDs, source bytes, active versions, and all evidence. Confirm `PRAGMA foreign_key_check` is empty and row counts match before applying to production. The function-only app can read and write function data against this schema.
3. **App Worker last.** Deploy the new editor, script launch/evidence paths, runtime Zod validation, and generated docs. Restore launches once the app, schema, and private runner match.

## Rollback sequencing

Drain all queued and running protocol 2 runs before a rollback; do not roll components independently while work is in flight.

- **App rollback:** after the drain, the previous function-only app can run against schema `0003` for function reads and writes. Script assignments remain in the database but are not editable or launchable by the old app. Do not reverse migration `0003`; script rows and new columns must remain.
- **Runner rollback:** roll the app back first, then the runner. The old runner accepts neither protocol 2 function jobs nor script jobs, so any protocol 2 run still in flight would fail. Previously queued legacy `native-python-runner/1` function jobs remain safe.
- **Data rollback:** there is no safe destructive reversal. Preserve script rows and the rebuilt tables; restoring a pre-migration snapshot would discard script data written after the release.

## Hosted verification required before closing #3

Follow the issue #3 closure matrix with synthetic fixtures only. Record the deployed app revision, runner Worker/image artifact digest, Python release, and limits.

- [ ] Deploy the approved runner, apply `0003` to a disposable copy, then deploy the app in the order above.
- [ ] Sign in as a researcher and create a script assignment with explicit empty input/output and with CRLF text; confirm exact values and a no-op resave.
- [ ] Switch a function assignment to script, then reopen the earlier run and confirm its original format, source, arguments, expected return, and results.
- [ ] Upload and run a script that executes as `__main__` and reads stdin to EOF.
- [ ] Demonstrate expected `7` with actual `7` and `7\n` passing, and `7 `, `7\n\n`, or `Answer: 7` mismatching.
- [ ] Demonstrate successful empty stdout, unavailable output, invalid UTF-8 stdout, a nonzero exit after matching text, and output truncation.
- [ ] Confirm the shared isolation and limits still apply: fresh execution per test, no outbound network/DNS, no app files or credentials, 2 s wall clock, 128 MiB memory, 16 KiB combined output.
- [ ] Confirm a submission-caused failure does not stop later tests, and that interrupting a run preserves completed evidence while marking the run Incomplete and distinguishing unfinished from never-started tests.
- [ ] Confirm stale launches create no run, including after a format switch.
- [ ] Open `/api/docs` as a researcher, run one GET with Try it out, and confirm POST Try it out is unavailable. Confirm signed-out users and members cannot fetch the docs page, spec, or protected assets.
- [ ] Verify the deployed Swagger spec still reports OpenAPI 3.1 and function responses contain no decoded `arguments`/`expectedReturn` fields.

Local tests alone do not satisfy this hosted gate.
