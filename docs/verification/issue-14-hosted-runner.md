# Hosted runner verification for issue #14

**Status: hosted verification complete on 2026-11-26.**

This record covers the long-suite timeout follow-up from issue #3. All fixtures were synthetic and were removed after capture.

## Deployed configuration

| Component | Value |
| --- | --- |
| Application revision | `ec7aa51` (app Worker unchanged) |
| Runner Worker version | `66e4f8f2-ba9e-475c-9477-1f326ac23622` |
| Runner image | `registry.cloudflare.com/73c2eb2ea030c38704eed3164930a17a/feedback-lab-runner-runnercontainer-base@sha256:620b3f43b6ecffa8a0a72daa85e475dae9c78bd4dbcaffd00c758384e3e3a942` |
| Container instance | `basic`: 0.25 vCPU, 1024 MiB, 4000 MB disk (unchanged) |
| Python | `3.12.11` (`python:3.12.11-slim-bookworm`) |
| Per-test limits | 2 seconds wall-clock execution, 128 MiB, 16 KiB combined stdout and stderr (unchanged) |
| Runner routing | one container per **Test run** (unchanged) |

The container still runs with `enableInternet: false`; the runner Worker has no public route.

## Root cause

The `python:3.12.11-slim-bookworm` image ships empty `__pycache__` directories. Every test started two Python processes (a harness and the submission child), and each process recompiled stdlib imports such as `json`, `re`, and `enum` from source. On the `basic` container this took roughly 300 ms of CPU before any submission code ran.

A local reproduction under a 0.25 vCPU Docker quota showed trivial script tests taking 1.2–1.5 s wall clock, with test 2 timing out on every suite. Compiling the image's standard library once at build time and removing the extra process brought the same suite to 0.12–0.70 s per test, with no timeouts.

## Changes

- **Precompiled bytecode.** The image now runs `python -m compileall` over the standard library at build time and fails the build if no `.pyc` file exists.
- **One child process.** The separate harness process was removed. The trusted runner creates the result and stdin pipes directly, spawns the submission child, and drains stdout, stderr, and the result envelope in one selector loop. The child returns its tagged value or completion envelope over the result pipe; it never receives the runner's request socket or event loop.
- **Non-blocking stdin.** Script stdin is written incrementally through the same selector loop, so input larger than the pipe buffer cannot deadlock against captured output.
- **Smaller child startup.** `traceback` and `importlib.util` load only when an error path or a function job needs them.
- **Same clock and limits.** The execution clock still starts immediately before `subprocess.Popen`, so trusted interpreter startup counts inside the 2-second wall-clock limit. No instance-size change was needed; `basic` was retained, so provisioned memory, disk, and the cost per running container are unchanged.

The issue's other options were therefore not needed. Moving to `standard-1` was not necessary, and suite length is still unrestricted within the existing API row limit.

## Hosted evidence

Assignment `422cf4f3-b41b-4e70-9fac-ccf320b95207`, version `dd7f4761-4786-49e3-950d-c1af50e2f062`, suite `5e1cc3f9-2d2b-478c-a26d-01b320fe46cd` contained nine identical cheap script tests (`3 4\n` → `7\n`). Submissions were a two-line sum script.

| Run | Tests | Passed | Execution range | Timeouts | Started→finished |
| --- | --- | --- | --- | --- | --- |
| `1173ce4d-b77c-4988-85cd-c29a9f1dbbcd` | 9 | 9 | 86–311 ms | 0 | 12.2 s |
| `2f698e18-a3e0-4a1d-92d6-2379cb5fd4f7` | 9 | 9 | 83–136 ms | 0 | 7.9 s |
| `8d59249e-ede3-4b9b-90b3-49aaff551a23` | 9 | 9 | 74–103 ms | 0 | 10.5 s |
| `72066844-52fd-40ac-82ae-d235aac58bf0` | 9 | 9 | 75–111 ms | 0 | 7.3 s |
| `15f3fc3b-b39f-4b7e-aae8-869b75ed7888` | 9 | 9 | 70–118 ms | 0 | 7.1 s |
| `cde18e13-b879-49a7-aef4-3bf19e2a4032` | 9 | 9 | 105–169 ms | 0 | 8.0 s |

The first run used a cold container and still stayed below 311 ms per test. The other five each used their own container; all nine tests completed well inside the 2-second limit. Execution times now include interpreter startup, matching the limit that was measured before this change.

## Slow-host check

The hosted runs were supplemented with local Docker runs of the deployed image under a tighter CPU quota than `basic`:

| Quota | Suites | Tests | Outcomes | Execution range | Wall range |
| --- | --- | --- | --- | --- | --- |
| 0.1 vCPU (2.5× slower than `basic`) | 5 | 45 | all completed | 498–1400 ms | 501–1499 ms |
| 0.0625 vCPU (4× slower than `basic`) | 5 | 45 | all completed | 703–1901 ms | 796–2001 ms |

The 0.0625 vCPU run is close to the limit and is recorded as a stress check rather than a supported configuration. These use the same 2 s / 128 MiB / 16 KiB limits, `enableInternet: false` equivalent network isolation, fresh process groups, and temporary directories. They are local resource-contention evidence, not hosted isolation evidence.

## Limit and isolation preservation

- The 2-second wall clock still starts before the child process is spawned; interpreter startup is included.
- The timeout path still kills the whole process group, and leftover-process diagnostics are unchanged.
- The memory cap still samples the aggregate RSS of the submission process tree every 100 ms. With the harness gone, only the submission tree counts toward the 128 MiB cap.
- The 16 KiB combined stdout/stderr cap and the 2 MiB result-envelope cap are unchanged. An oversized envelope kills the test and marks retained output truncated.
- The child still has no network, no application files, no shared evidence file, and a clean environment.
- Scripts that exit abruptly with `os._exit(0)` remain **Completed** with captured stdout, and nonzero exits remain **Execution errors**.

## Local verification

Toolchain: Node `22.14.0`, npm `10.9.2`, Python `3.12.3` locally (deployed runner uses `3.12.11`), Wrangler `4.168.0`, Vitest `5.1.1`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | Pass: 12 files / 168 tests |
| Native runner contract tests | Pass: 32 tests |
| Docker build | Pass: precompiled-bytecode assertion |
| 0.25 / 0.1 / 0.0625 vCPU nine-test suites | Pass: 135 tests, zero timeouts |

New contract coverage includes: an oversized result envelope rejected and marked truncated, stdin larger than the pipe buffer consumed to EOF, stdin larger than the pipe buffer left unread without blocking, and abrupt `os._exit(0)` completion.

## Cleanup

The synthetic assignment, version, suite, nine tests, six submissions, six runs, 54 results, and the temporary researcher account were removed after capture. The pre-existing assignment, user, and completed run remain; `PRAGMA foreign_key_check` returned no rows.
