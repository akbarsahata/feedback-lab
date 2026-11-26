# Feedback Lab

Feedback Lab is the research platform for inspecting AI feedback on introductory Python assignments. The repository implements issue #1's **versioned assignment configuration**, issue #2's **isolated test runs**, and issue #3's **script assignments plus generated JSON API docs**.

A pre-approved researcher can sign in, create a Python **function** or **script** assignment with an ordered rubric and ordered tests, revise it, and open any saved configuration read-only. Every save that changes content creates immutable versions. A save based on an older active version is rejected instead of overwriting a newer one. A format switch creates a new assignment version and a new single-format test suite; existing runs keep their original format, source, expectations, and results.

A researcher can also upload one synthetic UTF-8 Python file, launch the assignment's tests, and reopen line-numbered source and per-test evidence. A **Test run** pins the submission, assignment, rubric, test suite, Python release, runner artifact, and limits. Later edits do not change saved results.

Paired datasets, feedback generation, same-run study resume, aggregate reporting, seeded library data, drafts, restore/branching, and automatic merging are intentionally out of scope.

## Stack

- Cloudflare Workers with server-rendered HTML
- D1 for storage and sessions
- TypeScript, Zod 4, and `zod-openapi` 6 for runtime request/response validation and the OpenAPI 3.1 contract
- Pinned `swagger-ui-dist` assets served same-origin under the researcher guard
- Vitest running inside the Workers runtime via `@cloudflare/vitest-plugin`
- Wrangler for local development and deployment

## Requirements

- Node.js **22.14 or newer** (`.nvmrc` pins 22.14.0 and `engines` matches it)
- npm
- A Cloudflare account with D1 access for remote deployment

Use `nvm use` in the repository. `zod-openapi` 6 requires Node 22.14 or newer.

## Local setup

```sh
npm install
npx wrangler d1 migrations apply feedback-lab --local
npm run provision -- --email researcher@example.test --role researcher --local
npm run dev
```

Open <http://localhost:8787>, sign in with the printed password, and use the assignment library.

The local database lives under `.wrangler/` (ignored by git). The remote binding resolves the `feedback-lab` database by name in the selected Cloudflare account.

### Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run all unit and integration tests in the Workers runtime. |
| `python3 -m unittest discover -s runner -p 'test_*.py' -v` | Run the native Python runner contract tests. |
| `npm run typecheck` | Type-check application, tests, and config. |
| `npm run dev` | Start the local Worker and D1. |
| `npm run db:migrate:local` | Apply D1 migrations locally. |
| `npm run db:migrate:remote` | Apply D1 migrations to the deployed database. |
| `npm run provision -- ...` | Create a user directly in D1. |
| `npm run deploy` | Deploy the Worker to its configured custom domain. |

## Authentication and roles

Authentication is first-party email/password auth:

- `researcher` accounts can read and change assignments, versions, and history.
- `member` accounts can sign in but receive 403 on every assignment/history route, including direct API requests.
- Signed-out callers are redirected to sign-in for HTML and receive 401 JSON for API requests.
- There is no public sign-up and no in-app role management. A maintainer provisions accounts.

Passwords use PBKDF2-HMAC-SHA256 with 100,000 iterations, a 16-byte random salt, and a 32-byte hash. Sessions use a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`fl_session`); only the SHA-256 hash of the token is stored. Cookies are `Secure` on HTTPS. Authenticated writes require the hidden `_csrf` field (HTML) or the `X-CSRF-Token` header (API) plus a matching `Origin` when the header is present. A signed-in request to sign in again redirects without changing its session.

Anonymous sign-in POSTs are [rate limited by Cloudflare Workers](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) before password verification: about 12 requests per minute per edge-provided client IP, independently in each Cloudflare location. The counts are approximate, not a global ceiling or an account lockout; users on a shared IP share that allowance. A denied request returns `429` with `Retry-After: 60`. Without an edge-provided IP, requests share a local fallback key.

Provision an account:

```sh
npm run provision -- --email person@example.edu --role researcher --local
npm run provision -- --email person@example.edu --role researcher
```

The password is generated, shown once, and never stored in plaintext. There is no password reset flow. See [ADR 0001](docs/adr/0001-first-party-authentication.md) for why this was chosen over Cloudflare Access or GitHub OAuth.

This is prototype authentication. Account-level controls, password reset, MFA, and migration to an identity provider remain hardening tasks.

## Versioning model

An **Assignment** has a stable ID and points to one active **Assignment version**. Each assignment version stores the title, task description, format, the function entry point for function assignments, and exact references to an immutable **Rubric version** and **Test suite version**. Rubric criteria and tests preserve order and content in their snapshot tables. A suite is single-format: function tests carry `argumentsJson`/`expectedReturnJson`; script tests carry `stdin`/`expectedStdout`.

| Save | New versions |
| --- | --- |
| Create an assignment | Assignment, Rubric, and Test suite |
| Change only title, description, or function entry point | Assignment only; reuse both referenced versions |
| Change only the rubric | Assignment and Rubric; reuse the Test suite version |
| Change only the tests | Assignment and Test suite; reuse the Rubric version |
| Switch Function ↔ Script | Assignment and Test suite; reuse an unchanged rubric. Every test must be configured for the new format. |
| Change both rubric and tests | Assignment, Rubric, and Test suite |
| Save unchanged content | None |

Writes are atomic D1 batches. An `AFTER INSERT ON assignment_versions` trigger makes the newly inserted version active, so a failed batch cannot half-activate a version. `UNIQUE (assignment_id, version_number)` is the optimistic-concurrency guard: two researchers editing the same base produce exactly one new version, and the batch rolls back any child snapshots from the losing write.

No-op comparison uses validated values, not raw JSON text for function tests: object key order and whitespace do not create a version, while item order, content, or typed values do (including changing `1` to `1.0`). Script `stdin` and `expectedStdout` are compared exactly, including CRLF, blank lines, and trailing spaces; an expectation that normalizes to the same output still creates a new suite. Snapshot tables are never updated or deleted. Exact-version lookup never falls back to the active version. History reads the versions and their active marker in one query.

## Configuration rules

- A nonblank title and task description are required.
- Choose **Function** or **Script**. `format` may be omitted in JSON requests for backward compatibility, which means `function`.
- A function assignment requires a Unicode Python identifier entry point such as `first_positive` or `café`, not a signature. It is saved under its NFKC-normalized spelling, which must not be a reserved keyword; soft keywords such as `match`, `case`, and `type` are allowed.
- A script assignment has no entry point and must not send one.
- At least one rubric criterion and one test are required.
- Criterion and test IDs use lowercase letters, digits, hyphens, or underscores, are unique within their list, and may repeat across lists.
- Lists are ordered. IDs of existing items should be kept when revising; a changed ID is a remove plus an add from the versioning point of view.
- Do not mix formats inside one suite. A function test sends arguments/expected return; a script test sends `stdin`/`expectedStdout`. Fields from the other format are rejected rather than ignored.

### Function tests

- Arguments are a JSON array: `[]` means no arguments, `[4, -1]` means two positional arguments, and `[[4, -1]]` means one list argument.
- The expected return is a separate JSON value. Explicit `null` means Python `None`; a blank field is missing and rejected.
- Supported values are integers, finite floating-point numbers, strings, booleans, `null`, and nested arrays/objects with string keys. Empty containers are supported.
- Malformed JSON, duplicate object keys, non-array argument lists, non-finite numbers, and integers that cannot be represented exactly as binary64 are rejected. For example, `9007199254740992` is accepted but `9007199254740993` is not. Integer tokens are kept in exact decimal form. Tokens with a decimal point or exponent are finite binary64 floats (for example, `1e20`); the saved JSON retains the float kind and the sign of `-0.0`.
- Stored arguments and expected returns are canonical JSON: object keys sort lexically (including numeric-looking keys), and arrays keep their order. The comparison rule is `function-value-v1`.

### Script tests

- `stdin` is the complete standard input text. `expectedStdout` is the complete expected standard output. An explicit empty string is valid; an omitted API field is an error.
- Script text is saved exactly. Leading blank lines and trailing spaces are preserved. The JSON API accepts literal CRLF. The editor preserves an existing field's exact text when it is left unchanged and saves new browser textarea line breaks as LF.
- Each input and expected stdout field is limited to 16 KiB of UTF-8. Strings that cannot round-trip as UTF-8 (lone surrogates) are rejected. The comparison rule is `script-stdout-v1`.

To bound save and editor work, use at most 100 nonblank rows per list and 64 nested JSON arrays/objects per function value. The saved text and compact JSON together may use up to 1 MiB in UTF-8; this leaves room under [D1's 2 MB per-row and per-string limit](https://developers.cloudflare.com/d1/platform/limits/). Display spacing and other input formatting do not count toward this size.

Validation errors are returned per field and per row. Successful saves create versions; failed, stale, and unchanged saves do not advance the active version. The HTML form keeps submitted input on validation and conflict responses, including leading blank lines, trailing spaces, and empty script fields.

## Routes

HTML:

| Route | Purpose |
| --- | --- |
| `GET /sign-in`, `POST /sign-in` | Sign in. |
| `POST /sign-out` | Sign out (CSRF required). |
| `GET /assignments` | Library, including the empty state. |
| `GET /assignments/new`, `POST /assignments` | Create a function or script assignment. |
| `GET /assignments/:id` | Active version. |
| `GET /assignments/:id/edit`, `POST /assignments/:id` | Revise from the active version. Detail-page Edit links pin the version that was viewed; if it has changed, explicitly reopen the active version. POST requires the original `baseVersionId`. |
| `GET /assignments/:id/history` | Saved versions, newest first. |
| `GET /assignments/:id/versions/:versionId` | Exact version, read-only. |
| `POST /assignments/:id/runs` | Upload one UTF-8 `.py` file (64 KiB maximum) and launch a run against the active version. Stale version IDs return 409. |
| `GET /runs/:id` | Version-pinned run summary and line-numbered submitted source. |
| `GET /runs/:id/tests/:testId` | Recorded expected/actual values, script stdin/stdout, separate stdout/stderr, diagnostics, and timings for one test. |

## JSON API and generated docs

Zod 4 schemas validate JSON requests and responses at runtime and drive the generated contract via `zod-openapi` 6. Assignment validation also enforces constraints such as UTF-8 byte sizes and unique IDs. A response that fails validation returns a generic `500`.

- [Swagger UI](https://python-assessor.akbarsahata.id/api/docs) (`GET /api/docs`) — requires researcher access. Try it out is enabled for GET only; write operations show request examples and require the session cookie plus `X-CSRF-Token`.
- [OpenAPI 3.1 document](https://python-assessor.akbarsahata.id/api/openapi.json) (`GET /api/openapi.json`) — requires researcher access.

The OpenAPI document covers `/api/session` and the existing assignment read, create, revise, history, and exact-version operations. The hand-maintained endpoint and payload tables that used to live here were removed in issue #3.

**Breaking response change:** function test responses now contain only `argumentsJson` and `expectedReturnJson`, not the decoded `arguments` and `expectedReturn` fields. The JSON text fields remain authoritative for Python numeric kinds, duplicate-key detection, and exact round-tripping through this API. Script tests use explicit `format: "script"`, `stdin`, and `expectedStdout`; function creates may still omit `format`. Requests may use a wrapped `{"config": {...}}` body or a bare config object, and `*Json` fields take precedence over their JSON-text aliases.

Signed-out JSON callers receive `401 {"error":"unauthenticated"}`; a signed-in member receives `403 {"error":"forbidden"}`. Revise returns `201` with `changed: true`, `200` with `changed: false` for a no-op, or `409` for a stale base. Validation details are shown in Swagger UI and the generated schema.

## Test runs

Each test runs in a fresh native Python execution with standard library only. The initial limits are **2 seconds wall-clock execution, 128 MiB memory, and 16 KiB combined standard output and standard error**. The Worker records each test's status before and after the runner call, so an interruption leaves completed results intact and classifies a started-but-unfinished test as **Infrastructure failure** and an unstarted test as **Not run**.

`function-value-v1` compares exact numbers without tolerance (`7` matches `7.0`), strict booleans (`True` differs from `1`), exact strings, `None` only with `null`, ordered lists, and dictionaries by key recursively. The actual value is tagged by the trusted runner so Python integer and float kinds never pass through JavaScript `Number`.

`script-stdout-v1` executes the uploaded file as `__main__` in a fresh child process per test. The complete configured UTF-8 `stdin` is written byte-for-byte without trimming or an appended newline, then closed so the program can read to EOF. Stdout and stderr are captured separately. Comparison happens only after normal completion: on both expected and actual stdout, CRLF becomes LF and at most one final LF is removed, then the text must match exactly. For expected `7`, both `7` and `7\n` pass while `7 `, `7\n\n`, and `Answer: 7` mismatch. Stderr is not compared but counts toward the shared 16 KiB cap. Empty stdout is stored as `""`; unavailable or partial output is distinct. Invalid UTF-8 stdout is an **Execution error** with a bounded lossy preview that is never compared; a confirmed resource limit takes precedence over interpreting output. Saved evidence is never rewritten by comparison.

The native runner lives in [`runner/`](runner/README.md), and its private Container Worker adapter lives in [`runner-worker/`](runner-worker). The Worker publishes committed runs through `feedback-lab-test-runs`; the queue consumer calls the private `RUNNER` service binding. Each **Test run** gets its own container instance, so state from one run cannot affect another. Within a run, each test still executes in a fresh Python child process.

The deployed runner uses the `basic` instance (0.25 vCPU, 1024 MiB), Python `3.12.11`, `enableInternet: false`, and the per-test limits above. The hosted issue #2 baseline is in [`docs/verification/issue-2-hosted-runner.md`](docs/verification/issue-2-hosted-runner.md); the issue #3 record in [`docs/verification/issue-3-hosted-runner.md`](docs/verification/issue-3-hosted-runner.md) distinguishes local checks from hosted verification that is still pending. Local tests use a fake runner and the Python contract tests; a local or fake-runner pass does not close a hosted gate.

## Deployment

Production uses the `feedback-lab` Worker and D1 database at <https://python-assessor.akbarsahata.id>. Cloudflare manages DNS and TLS through the Worker Custom Domain. The `workers.dev` hostname and preview URLs are disabled.

The app now ships pinned Swagger UI assets from `public/` through the `ASSETS` binding. `/api/docs` and `/api/docs/*` use `run_worker_first`, so the researcher guard runs before any docs asset. If the assets change, run `npm install` and copy the pinned files from `node_modules/swagger-ui-dist` into `public/api/docs/`; do not load Swagger UI from a CDN.

For a format migration, deploy in this order so queued runs are never routed to an incompatible artifact:

1. Pause new launches and drain queued/running work on its pinned artifact. Then deploy the private runner Worker/image.
2. Apply D1 migration `0003_script_assignments.sql`. It preserves IDs, source bytes, and evidence and is readable by the previous function-only app.
3. Deploy the app Worker with the new JSON contract, editor, and generated docs.
4. Complete the hosted checklist below.

For an initial deployment, authenticate Wrangler and select the Cloudflare account that owns `akbarsahata.id`. Then:

1. If the database does not already exist, run `npx wrangler d1 create feedback-lab`.
2. Create the test-run queue once: `npx wrangler queues create feedback-lab-test-runs`.
3. `npm run db:migrate:remote`.
4. Provision two researchers and one member:
   ```sh
   npm run provision -- --email researcher-a@example.edu --role researcher
   npm run provision -- --email researcher-b@example.edu --role researcher
   npm run provision -- --email member@example.edu --role member
   ```
5. Deploy the private runner Worker: `npx wrangler deploy -c runner-worker/wrangler.jsonc`.
6. `npm run deploy`.
7. Complete the hosted checklist below.

Rollback: drain all queued and running protocol 2 runs first, then roll the app back to the function-only release, then roll the runner back. The old runner does not accept protocol 2 function or script jobs, and the old app cannot launch script runs. The function-only app can still read and write function data against schema 0003; script assignments remain stored but are not editable in the old UI. Do not reverse migration 0003 and do not delete script data written in the new format.

### Local verification performed

- `npm test` (all unit and Workers-runtime integration tests) passes.
- `npm run typecheck` passes.
- `npm run dev` starts against local D1 under Node 22.14.
- The `first_positive` create, reopen, metadata revision, and history flow was exercised manually with `curl` against the local Worker.
- Local headless Chrome exercised sign-in, repeated editor row add/remove, multiline JSON, save, reopen, and an unchanged resubmit.
- Local Workers-runtime tests verify that anonymous sign-in is throttled without replacing or blocking an existing session.
- `npm test` also covers `function-value-v1`, exact-version launch rejection, 64 KiB upload bounds, source byte preservation including a UTF-8 BOM, typed evidence, continuation after failures, duplicate delivery, late-result rejection, reconciliation, and access to run pages.
- Issue #3 coverage includes script configuration and 16 KiB/UTF-8 validation, exact stdin/expected-stdout preservation, format switches with old evidence retained, the stdout comparison matrix, invalid UTF-8 and resource-limit precedence, the old-migration D1 fixture with `foreign_key_check`, generated request/response schema checks, and researcher-only `/api/docs`, `/api/openapi.json`, and pinned assets.
- `python3 -m unittest discover -s runner -p 'test_*.py'` covers the native runner contract, including timeout with child processes, output caps, invalid UTF-8 output, recursion, unsupported and cyclic returns, the 1 MiB return budget, script `__main__` execution, byte-exact stdin through EOF, empty input/output, CRLF preservation, nonzero exit, legacy protocol 1 jobs, and the private HTTP endpoint. The memory-limit case runs on Linux only.

### Hosted verification checklist

- [ ] Both researchers can sign in; each can open and revise the same assignment.
- [ ] The member can sign in but is denied `/assignments`, create/edit, history, exact-version, and API routes through the UI and direct requests.
- [ ] Signed-out users cannot read assignments or history through the UI or direct API requests.
- [ ] Missing and wrong CSRF tokens and a foreign `Origin` are rejected on writes.
- [ ] Verify the sign-in throttle on the hosted edge: repeated anonymous sign-in attempts from a test IP eventually return `429` with `Retry-After`, without affecting an existing session.
- [ ] Create `first_positive` with `[[4, -1]]` → `4` and `[[]]` → `null`; reopen and confirm the first argument is a list and `null` is distinct from a missing expected return.
- [ ] Walk the version table: metadata-only, rubric-only, tests-only, both, and a no-op save. Confirm child-version reuse and no new versions for no-op, failed, and stale saves.
- [ ] Revise a test and then a criterion, open the original version from history, and confirm its values and referenced version IDs are unchanged.
- [ ] Open the same active version in two sessions, save in one, then submit the older form in the other. Confirm the second researcher sees a conflict, keeps their edits, and the first save stays active.
- [ ] Confirm the production database has no seeded assignment data.
- [x] Run the `first_positive` example and confirm pass, mismatch, execution error, timeout, memory limit, and output limit appear as distinct outcomes.
- [x] Confirm each test starts fresh, outbound traffic and DNS are blocked, and disposable app-file/credential canaries are inaccessible in the deployed runner.
- [x] Interrupt a run while a test is in flight and confirm completed evidence remains, the started test becomes **Infrastructure failure**, and unstarted tests become **Not run**.
- [x] Restore the runner and confirm a new known-good run succeeds without changing the interrupted run.
- [x] Confirm cold and warm runner timing are shown separately from execution time.
- [x] Reopen a saved run after editing the assignment and confirm its source, expected values, and results still resolve to the original versions.
- [ ] Apply migration 0003 to a copy of production data; confirm `PRAGMA foreign_key_check` is empty, row counts and IDs are unchanged, and an old function run still opens.
- [ ] Create a script assignment with explicit empty input/output and with CRLF text; confirm the saved values and a no-op resave.
- [ ] Switch a function assignment to script, then reopen the earlier run; confirm the original format, source, arguments, expected return, and results.
- [ ] On the deployed runner, demonstrate script `__main__`, stdin to EOF, expected `7` matching `7\n`, empty output, an extra-space mismatch, a nonzero exit, and output truncation. Confirm the shared 2 s / 128 MiB / 16 KiB limits still apply.
- [ ] Open `/api/docs` as a researcher and run a GET with Try it out; confirm POST Try it out is unavailable. Confirm signed-out users and members cannot fetch the docs page, spec, or assets.
- [ ] Record the deployed revision, runner artifact, Python release, limits, and observed results in `docs/verification/issue-3-hosted-runner.md`. Local tests alone do not close issue #3.

## Implementation notes and deviations

- The research environment had no `cf` binary or Cloudflare login. The app uses `wrangler.jsonc` and Wrangler's Vitest integration, as documented in the local architecture notes.
- Node.js 22.14+ is required by the installed Wrangler, Vitest, Zod, and `zod-openapi` releases; Node 20 cannot run Wrangler 4.168, and `.nvmrc` pins 22.14.0.
- `@cloudflare/workers-types` is a dev dependency for editor/type-check support. Zod, `zod-openapi`, and `swagger-ui-dist` are runtime/pinned docs dependencies.
- Stored function JSON is canonical (`[[4,-1]]`); the edit form and detail view add spacing for display (`[[4, -1]]`) without changing values or numeric kinds. Function responses no longer include decoded `arguments`/`expectedReturn`; use the JSON text fields. The edit form uses multiline JSON inputs so pasted formatting is kept on validation and conflict responses.
- Script text is stored exactly. The detail and evidence views show the raw text plus a whitespace view that marks spaces, tabs, CRLF, and blank lines; this is display-only.
- Migration `0003_script_assignments.sql` rebuilds the cyclic assignment/run graph through parallel tables before renaming them. This avoids the D1 behavior where dropping a referenced parent can leave deferred foreign-key state even after a same-named replacement exists. The migration fixture applies only `0001`/`0002`, seeds function evidence and a newer active version, then applies `0003` and checks IDs, counts, and `foreign_key_check`.
- Tests use a small cleanup helper between cases because the installed Workers Vitest plugin did not isolate D1 storage between tests automatically. Production migrations never seed data.

## Project layout

```
src/
  app.ts          router and sign-in/sign-out
  api.ts          JSON API for assignments and versions
  api-schemas.ts  Zod request/response schemas and generated OpenAPI document
  validated-response.ts outgoing JSON schema guard and generic 500
  docs.ts         researcher-guarded /api/docs and /api/openapi.json
  auth.ts         D1 sessions, cookies, CSRF
  config.ts       function/script validation and no-op comparison
  editor-script.ts browser behavior for repeatable rows and format switching
  forms.ts        HTML form row parsing
  guard.ts        researcher access guard
  html.ts         shared layout, styles, escaping
  http.ts         response helpers and security headers
  json.ts         lossless JSON parser and canonicalization
  pages.ts        library, editor, detail, and history views
  password.mjs    shared Worker and Node Web Crypto password helpers
  repository.ts   D1 queries and immutable version writes
  web.ts          server-rendered assignment routes
  coordinator.ts  sequential run execution and persistence
  function-value.ts exact typed return comparison
  runs.ts         submission and test-run storage and state transitions
  runner.ts       private runner job/result contract
  runs-web.ts     run summary and per-test evidence pages
  upload.ts       bounded UTF-8 source uploads
migrations/       D1 schema (no seeds); 0003 rebuilds the assignment/run graph
public/api/docs/  pinned same-origin Swagger UI assets from swagger-ui-dist 5.36.0
runner/           native Python runner, harness, image, contract tests
runner-worker/    private Container Worker adapter and per-run routing
scripts/          maintainer provisioning
test/             unit and Workers-runtime integration tests
docs/adr/         architecture decisions
docs/verification/ hosted and local verification records
```
