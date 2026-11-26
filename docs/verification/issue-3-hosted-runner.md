# Hosted runner verification for issue #3

**Status: hosted verification complete on 2026-11-26.**

This record covers the deployed application and private runner. All fixtures were synthetic. The production library contained one pre-existing function assignment and run; both were preserved and the synthetic verification data was removed after capture.

## Deployed configuration

| Component | Value |
| --- | --- |
| Application revision | `ec7aa51` (app Worker), plus the runner monitoring change in `bcfcccd` |
| Web Worker version | `bf13a7cb-e86b-44f3-9cf8-2c5e53175c52` |
| Runner Worker version | `df309938-5373-4592-885b-f0443877ea16` |
| Runner image | `registry.cloudflare.com/73c2eb2ea030c38704eed3164930a17a/feedback-lab-runner-runnercontainer-base@sha256:7161572d7190b3b37c4cf493923451102c20f2d3266f1dc80faa515057282e99` |
| Container instance | `basic`: 0.25 vCPU, 1024 MiB, 4000 MB disk |
| Python | `3.12.11` (`python:3.12.11-slim-bookworm`) |
| D1 | `feedback-lab`, migrations `0001`–`0003`; `0003_script_assignments.sql` applied 2026-11-26 04:32:16 UTC |
| Queue | `feedback-lab-test-runs`; consumer `feedback-lab`; one message per batch; no automatic retries |
| Cron | `*/5 * * * *` reconciliation |
| Runner routing | one container per **Test run** |
| Per-test limits | 2 seconds, 128 MiB, 16 KiB combined stdout and stderr |

The container runs with `enableInternet: false`. The runner Worker has no public route and is reachable only through the private `RUNNER` service binding.

## Hosted evidence

### Function assignment, format switch, and historical evidence

Run `d183a293-2432-465d-948a-a13c430aac7d` completed with both function tests **Pass** (`617 ms`, `609 ms`; cold startup `1264 ms`). The test page showed positional arguments, expected return, actual return, and status alongside line-numbered source. Function responses contained only `argumentsJson` and `expectedReturnJson`; decoded `arguments` and `expectedReturn` were absent.

The assignment was then revised from function to script. The revision returned a new script version. A launch pinned to the old function version returned **409** without creating a run. Reopening the old run still showed **Function assignment**, the original arguments/expected return, and its passing evidence.

### Script comparison matrix

Assignment `aeb0c3d0-c60e-4a1b-92fc-881858f80446`, version `a7a9e15c-f5c7-4b0c-9712-16f35e186d3a`, run `a292fbb0-fcbd-4ca4-af52-ac628b64a311` (cold startup `1498 ms`):

| Test | Input | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- |
| `sum` | `1\n2\n` | `3\n` | `3\n` | Pass (`809 ms`) |
| `seven` | `3\n4\n` | `7` | `7\n` | Pass (`763 ms`) |
| `seven-lf` | `3\n4\n` | `7\n` | `7\n` | Pass (`812 ms`) |
| `space` | `3\n4\n` | `7 ` | `7\n` | Mismatch (`789 ms`) |
| `double-lf` | `3\n4\n` | `7\n\n` | `7\n` | Mismatch (`793 ms`) |
| `nonzero` | `nonzero` | `7\n` | `7\n` | Execution error (`786 ms`) |

The `nonzero` submission printed `7` and exited with code 3, so it was an **Execution error** despite matching text. This confirms `__main__` execution and stdin read through EOF.

A separate script assignment (`02d4966b-ca87-4544-8ad4-e9f49eed2c3f`) round-tripped literal CRLF (`\r\nline\r\n\r\n`) and an explicit empty test through the JSON API. An unchanged resave returned `changed: false`.

### Empty, invalid UTF-8, truncation, and continuation

Assignment `13cdb43f-4d0b-4f0f-9687-4b5fa17d7263`, version `95829f3b-c9a6-42a9-a750-640928254e57`, run `c1404ce1-9ace-44d3-9440-5db2f76c1463` (cold startup `1334 ms`):

| Test | Outcome | Evidence |
| --- | --- | --- |
| `empty` | Pass (`600 ms`) | stdout stored as `""`; page says “Standard output was empty” and marks the explicit empty string |
| `invalid-utf8` | Execution error (`513 ms`) | 4-byte lossy preview; labeled lossy; never compared |
| `truncate` | Output limit reached (`417 ms`) | 16 384 bytes captured; labeled partial/truncated |
| `sum` | Pass (`509 ms`) | Later test passed after the failures, proving continuation |

### Isolation and shared limits

Assignment `8d172352-0f0c-489e-826a-5808d88f8cea`, version `ffe21434-b0e6-4ea8-be14-e44519970182`, run `70d30fad-3607-45bb-b6cd-a78107371a64`:

| Test | Outcome | Observation |
| --- | --- | --- |
| `probe` | Pass (`1398 ms`) | `{"app_files_blocked":true,"dns_blocked":true,"env_clean":true,"tcp_blocked":true}` |
| `write` | Pass (`594 ms`) | Wrote `marker.txt` in the test working directory |
| `check` | Pass (`670 ms`) | Printed `fresh`; the marker was absent in the next test |
| `timeout` | Timed out (`2033 ms`) | Confirmed 2-second wall-clock limit |
| `memory` | Memory limit reached (`574 ms`) | 300 MiB allocation against the 128 MiB cap |
| `output` | Output limit reached (`548 ms`) | 16 384 bytes retained |

The probe confirms no DNS or outbound TCP, no app files, and a clean environment. The timeout, memory, and output outcomes take precedence over interpreting captured output.

### Access boundaries and generated docs

- Signed-out requests received **401** for `/api/docs`, `/api/openapi.json`, and pinned assets.
- A signed-in **member** received **403** for the same routes.
- A researcher received the docs page, the assets, and an **OpenAPI 3.1** document (5 paths).
- In a hosted Chromium session, the researcher ran a GET with Swagger “Try it out” and received `authenticated: true`. No POST operation exposed “Try it out”, and the page produced no JavaScript errors.

### Migration preservation

A pre-migration D1 export was taken outside the repository. After applying `0003`:

- Row counts were unchanged (1 assignment, 1 version, 1 rubric, 1 suite, 1 test, 1 submission, 1 run, 1 result, 1 user).
- `PRAGMA foreign_key_check` returned no rows.
- The original run `4e2dd03c-c9dc-4cc7-8203-a4e9f82cb331` remained **complete**, function-format, with its original `Pass` result and `{"kind":"int","value":"1"}` actual value.
- The new `tests` columns (`stdin`, `expected_stdout`) were present.

Historical `native-python-runner/1` runs remain readable. The new coordinator leaves a queued run whose pinned artifact is unavailable **Incomplete** instead of silently routing it to the `/2` artifact.

## Long-suite limitation

Two single-run nine-test suites timed out on tests 7–9 on cold `basic` containers after roughly six seconds of sustained CPU. A rerun of the identical suite passed, including all nine expected outcomes, and a nine-test suite of identical cheap tests also passed. The runner’s `/proc` memory scan was reduced from every 20 ms to every 100 ms to lower CPU overhead and the runner was redeployed (version and digest above). One later nine-test attempt still hit the same timeout on a slow host.

The timeout is a confirmed resource outcome and was recorded as such; it is not a script-comparison defect. To keep the closure evidence stable, the hosted matrix uses a six-test comparison run and a four-test evidence/continuation run. On the `basic` 0.25 vCPU instance, a long suite can still exceed the 2-second per-test limit under sustained CPU contention. A follow-up should evaluate a larger instance or further reduce per-test startup overhead before researchers rely on long script suites.

## Rollout and rollback

Deployment followed the plan:

1. Queued and running runs were checked as empty; a pre-migration D1 export was saved.
2. The private runner Worker/image was deployed with the protocol 2 contract.
3. `0003_script_assignments.sql` was applied remote; counts and `foreign_key_check` were verified.
4. The app Worker was deployed, then the runner image was updated again with the 100 ms memory-scan cadence.
5. The hosted matrix above was executed and recorded.

Rollback: pause launches, drain queued and running protocol 2 runs, roll the app back to the function-only release, then roll the runner back. The function-only app can read and write function data against schema `0003`; script assignments remain stored but are not editable in the old UI. Do not reverse `0003` or discard new-format data. Historical runs stay readable.

## Local verification

Toolchain: Node `22.14.0`, npm `10.9.2`, Python `3.12.3` locally (deployed runner uses `3.12.11`), Wrangler `4.168.0`, Vitest `5.1.1`, Zod `4.6.6`, `zod-openapi` `6.0.3`, `swagger-ui-dist` `5.36.0`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | Pass: 12 files / 168 tests |
| Native runner contract tests | Pass: 28 tests |
| `npx wrangler deploy --dry-run` | Pass |
| Local Chromium smoke | Pass: docs boundaries, GET-only Swagger, exact script text, format-switch confirmation |

Local tests cover script `__main__`, stdin through EOF, empty input/output, CRLF, nonzero exit, invalid UTF-8, limits, artifact mismatches, format switches with old evidence retained, the old-migration D1 fixture, the comparison matrix, and researcher-only docs.

## Cleanup

Synthetic assignments, submissions, runs, results, and the temporary researcher and member accounts were removed after capture. The pre-existing assignment, user, and completed run remain intact.
