# Implementation plan: Run and inspect isolated function tests

**Scope:** [GitHub issue #2](https://github.com/akbarsahata/python-assignment-assessor-assistant/issues/2), building on closed prerequisite [#1](https://github.com/akbarsahata/python-assignment-assessor-assistant/issues/1). This document plans the work; it does not record implementation, deployment, or verification.

## Goal and constraints

A signed-in researcher can upload one synthetic Python submission from an active function assignment, launch its ordered tests, and reopen the exact source and evidence even after the assignment changes. Closing #2 requires both a working researcher flow and proof from the deployed runner.

Keep the existing Workers, D1, and first-party auth stack. Reuse the [immutable configuration handoff from #1](../../README.md#what-issue-2-consumes), the [researcher access policy](../adr/0001-first-party-authentication.md), and the [wireframe](../../wireframes/feedback-lab.html) as a layout reference. A **Test run** has the meaning recorded in the [glossary](../../GLOSSARY.md).

No script assignments (#3), paired datasets (#4), feedback or instructor outage fallback (#5), historical launch picker, automatic execution retries, same-run study resume (#7), aggregate reporting or export, or full pilot readiness.

## Proposed technical direction

| Component | Responsibility |
| --- | --- |
| Worker app and D1 | Authorize launch and read access, enforce the active-version guard, store immutable submission bytes and version references, and retain per-test outcomes as they arrive. Keep app files, credentials, and bindings on the trusted side. |
| Background coordinator | Prefer a Cloudflare Queue message containing only the run ID. Claim the run once, execute tests sequentially in saved order, and persist each result before issuing the next test. Use a bounded deadline and an independent scheduled reconciliation pass to finalize abandoned runs, not to resume them. |
| Private runner adapter | Use a Container-backed Durable Object for the first hosting option. Keep the runner behind a trusted binding, not a public browser route. Use a dedicated VM only if Containers cannot satisfy the boundary; keep the same versioned job and result contract. |
| Native Python runner | Pin the exact CPython release, runner artifact, and isolation policy. Reuse the host when appropriate, never the isolated test execution. The trusted runner supervises each test and reports observations separately from anything the submission prints or returns. |

## Work sequence

### 1. Resolve the hosted isolation risk first

- Plan a small, non-public feasibility check with disposable synthetic inputs in an approved staging environment. Verify that the chosen host supports fresh, least-privilege execution per test with no writable state carried forward; no outbound traffic, public DNS, or access to trusted local services; and no app files, secrets, or trusted bindings exposed to the submission. Treat isolation setup or runner identity verification failures as fail-closed.
- Check that the runner can enforce **2 seconds wall-clock execution, 128 MiB memory, and 16 KiB combined stdout/stderr** across the full isolated execution, including any child processes. It must identify the observed limit without mistaking a generic process exit or a Python exception for verified cap enforcement. Verify cleanup after each test.
- Cloudflare's [instance size](https://developers.cloudflare.com/containers/platform/limits/) is a host quota, not the test's memory budget. Its [outbound controls](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) support disabling public egress without intercepts, but do not by themselves prove isolation from local services or other executions. Verify both properties inside the deployed test boundary. Confirm account access, the existing Wrangler version, and independent staging resources before any provisioning.
- **Checkpoint:** record the feasible host, pinned artifacts and policy, and initial hosted evidence. If Containers cannot enforce or observe a required property, evaluate the dedicated VM with the same checks. If neither passes, stop before enabling submissions; do not relax the boundary.

### 2. Specify the job, result, and timing contracts

- Send only the run and test identity, exact submission bytes, canonical NFKC entry point, authoritative arguments and expected-value representations, comparison rule, and pinned runtime/limits. Decode saved `argumentsJson` and `expectedReturnJson` losslessly; do not use the convenience values parsed by ordinary JavaScript JSON handling. Keep the expected value with the trusted comparison component, outside submitted code.
- Have the runner report an explicit start boundary and a bounded terminal result. Persist the trusted start marker before releasing the test to execute submission code so an interruption can distinguish started from unstarted work. Validate identity, artifact, result shape, and size at the boundary. Do not infer status or resource events from submission output.
- Implement `function-value-v1`: exact numeric equality with no tolerance (`7` matches `7.0`), strict booleans (`True` differs from `1`), exact strings, `None` only matching `None`, ordered lists, and dictionaries compared recursively by string key without regard to order. Preserve actual types, including numeric kind, without coercing Python integers through JavaScript `Number`. Represent a returned `None` separately from an unavailable result.
- Apply the **1 MiB UTF-8** budget to the encoded actual value, excluding result metadata, and reuse #1's **64-level** nesting convention. Verify boundaries against the actual wire encoding, not just in-memory values. Unsupported, cyclic, or over-bound returns are **Execution error** with a bounded diagnostic and no actual value. Keep stdout, stderr, return values, and diagnostics separate. Mark retained output as partial or truncated when applicable.
- Record cold startup from the shared runner start request to readiness. Mark warm reuse explicitly instead of recording a zero-duration cold start. Use a monotonic clock for per-test execution, starting after isolation setup and before submission code can run. Leave unstarted timings absent; retain measured infrastructure timings separately and never invent a duration.
- **Checkpoint:** contract fixtures cover numeric kind and equality, nested lists/dictionaries, order differences, `None` versus absence, valid values beyond 32 levels, size and depth boundaries, unsupported returns, and separation of stdout from actual values.

### 3. Add version-pinned storage and the authorized launch

- Plan an additive D1 migration for submission versions, test runs, and per-test records. Store source as exact bytes and pin the assignment, rubric, test suite, and submission version IDs, Python release, runner artifact/configuration, and active limits. Key outcomes within a run by test identity, and retain suite order. Load expected values from the referenced snapshot, never the active version. Update the Vitest D1 setup and cleanup for the new records.
- Validate exactly one `.py` file, valid UTF-8, and at most 64 KiB before creating any records. Bound the incoming multipart body as well as the file; do not rely on the declared size alone. Preserve bytes without newline normalization or trimming and do not reject a syntactically invalid Python program at upload.
- Require the existing researcher guard and CSRF/origin policy on launch. In one atomic write, check that the submitted assignment version is still active and create the submission, run, and initial test records only on success. Return an actionable conflict with no records or background job on stale launch. After acceptance, neither launch nor result handling may resolve against the active pointer again.
- Store large values per test, not as a serialized suite result. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) apply to the entire row and the query result; verify at-boundary writes and load only summaries plus the selected test's evidence rather than fetching or rendering up to 100 large values at once.
- **Checkpoint:** integration tests prove access control, upload boundaries and byte preservation, no partial writes on a stale request, and a reopen after a later edit with changed expectations under a reused test ID.

### 4. Coordinate execution and make outages terminal in #2

- Dispatch only after the launch commits. Run independently of the browser connection using the queue consumer, not request-lifetime work. Use an atomic queued-to-running claim and conditional writes so duplicate deliveries and late runner responses cannot re-execute a claimed run, replace completed results, or reopen a terminal run. Configure no automatic execution retry; test the [queue delivery and retry behavior](https://developers.cloudflare.com/queues/configuration/batching-retries/) separately from application retries.
- Give dispatch, runner readiness, and overall run completion distinct deadlines. Handle publication errors and reconcile expired queued or running records even if the coordinator disappears. The reconciliation pass finalizes only; it does not dispatch new tests. Verify the maximum configured suite fits the [queue consumer budget](https://developers.cloudflare.com/queues/platform/limits/) with startup, setup, reporting, and database overhead included.
- Store **Pass**, **Mismatch**, **Execution error**, **Timed out**, **Memory limit reached**, and **Output limit reached** as test outcomes. A mismatch, syntax error, missing entry point, `RecursionError`, or confirmed limit does not block later tests. A run with all execution outcomes is complete even if some tests failed.
- When progress stops for an infrastructure reason, preserve completed results and mark the run **Incomplete**. Classify a started test without a usable terminal result as **Infrastructure failure**, and unstarted tests as **Not run**, with a reason for each. Keep pending/running states distinct from terminal outcomes. Show recovery with a new run, not by resuming or rewriting the old one.
- **Checkpoint:** a fake runner in integration tests proves continuation, persistence before advancing, duplicate delivery handling, dispatch and startup failure, interruption after a completed test, worker disappearance, and rejection of late results after finalization.

### 5. Connect the researcher screens

- Add the launch form to the active assignment and redirect an accepted submission to its stable results URL. On a stale launch, explain how to reopen the current version. Keep the historical assignment page read-only for launching.
- Use the same researcher policy for direct results and test-detail reads as for launch. Show one-based source line numbers on the exact submitted snapshot, ordered tests, expected and actual typed values when available, separate stdout and stderr, diagnostics, and state. Escape source and all runner-provided text. A reload must work while the run is pending, after completion, and after interruption; no progress subscription or resume UI is required.
- **Checkpoint:** a signed-in researcher can launch and reopen the run throughout its lifecycle. Signed-out and signed-in non-researchers cannot read the evidence or start a run, including through direct requests.

### 6. Verify on the deployed configuration and hand off

- Run the existing `npm run typecheck` and `npm test` checks after implementation. Use real native Python contract fixtures for the runner; local emulation and a fake runner are useful regression tests, not evidence of hosted isolation.
- Repeat the deployed boundary check from step 1 against the release candidate. Use controlled fixtures to demonstrate fresh state, denied networking and DNS, inaccessible disposable app-file/credential/service canaries, known-good completion, timeout, confirmed memory and output caps, recursion as an execution error, and a passing test after a submission-caused failure. Use neither production data nor actual secrets for these checks.
- Walk through launch, saved results, and historical reopen after a version change. Interrupt a hosted run after a recorded result with one test started and another unstarted; verify the three records remain distinct. Restore runner readiness and verify a new known-good run succeeds without changing the interrupted run. Confirm both cold and warm timing representations.
- **Closure gate:** link repeatable verification instructions and a hosted results artifact from the closing PR or issue comment. Record the environment, deployed revision, runner artifact, exact Python release, active limits, and expected versus observed outcomes. Keep the artifact free of credentials and researcher data. Leave #2 open if a required hosted check fails or is unverified.
