# Hosted runner verification for issue #2

Verified on **2026-11-25** against the production Cloudflare account and `python-assessor.akbarsahata.id`.

## Deployed configuration

| Component | Value |
| --- | --- |
| Web Worker version | `b46492af-8de8-42c5-ab93-c52a89d6ed41` |
| Runner Worker version | `16d30b43-6117-4090-b6b8-c83b6daede68` |
| Runner image | `registry.cloudflare.com/.../feedback-lab-runner-runnercontainer-base@sha256:3605d4d2c58fa1d7b682592ffc08a10cd6fde2ad35023afbdadd587a6b96e67f` |
| Container instance | `basic`: 0.25 vCPU, 1024 MiB, 4000 MB disk |
| Python | `3.12.11` (`python:3.12.11-slim-bookworm`) |
| D1 | `feedback-lab`, migration `0002_test_runs.sql` applied |
| Queue | `feedback-lab-test-runs`, consumer `feedback-lab`, one message per batch, no automatic retries |
| Cron | `*/5 * * * *` reconciliation |
| Runner routing | one container per **Test run** |

The container starts with `enableInternet: false`. The runner Worker has no public route and is reachable only through the private `RUNNER` service binding.

## Evidence

### Outcomes and timings

Run `e5a0a61f-e69f-40d7-80a0-400898e72f8e` completed with every configured test carrying an execution outcome:

| Test | Status | Execution |
| --- | --- | --- |
| `pass` | Pass | 664 ms |
| `none` | Pass | 581 ms |
| `mismatch` | Mismatch | 581 ms |
| `exception` | Execution error | 584 ms |
| `timeout` | Timed out | 2035 ms |
| `memory` | Memory limit reached | 612 ms |
| `output` | Output limit reached | 1772 ms |

The first test recorded a **1636 ms cold startup**; later tests recorded **warm reuse**. The run page displayed both representations.

### Isolation

Run `c45affcc-a32d-44a3-bc11-26e89859b1d2` recorded this actual value for the isolation probe:

```json
{"dns_blocked":true,"tcp_blocked":true,"app_files_blocked":true,"env_clean":true,"fresh_directory":true}
```

It also confirmed that a file written by one test was absent in the next test and that `/app/src/app.ts`, `/opt/feedback-lab`, `/workspace`, and `/secrets` were absent. No Cloudflare, secret, token, database, or D1 environment variables were visible.

### Continuation

Run `6ec536e2-3523-47a6-86a0-d73c06db2c29` recorded **Output limit reached** (759 ms) followed by a later **Pass** (584 ms). A separate timeout→memory→pass fixture also completed with zero leftover processes.

### Interruption and recovery

Run `f8647bdb-e79a-438a-ad0e-c1c57ec39716` was interrupted by destroying its run container while the first test was in flight:

- first test: **Infrastructure failure** (`Network connection lost.`)
- remaining seven tests: **Not run**
- run: **Incomplete**
- completed results remained attached to the exact submission and test suite

The following fresh run `e5a0a61f-e69f-40d7-80a0-400898e72f8e` succeeded with the outcomes above, without changing the interrupted run.

### Version pinning

Run `e5a0a61f-e69f-40d7-80a0-400898e72f8e` was launched against assignment version 3, where the `pass` test expected `4`. The active version was then revised to expect `5`. Reopening the saved run still showed:

```text
Positional arguments [[4, -1]]
Expected return 4
Actual return 4
```

### UI

The results page for the clean run showed line-numbered source, per-test statuses, and `1636 ms (cold)` and `Warm reuse` timing representations.

## Residual boundary note

The container also hosts the runner's own HTTP endpoint. Submission code can open a TCP connection to that loopback port, but the endpoint exposes no application data, credentials, or bindings; the Worker and D1 are not reachable. If the threat model expands beyond synthetic submissions, move the runner to a per-test Unix-socket or exec boundary and repeat this verification.

## Cleanup

Verification assignments, runs, submissions, and the temporary researcher account were removed after this record was captured. The production assignment library was empty before verification and is empty again.
