# Feedback Lab

Feedback Lab is the research platform for inspecting AI feedback on introductory Python assignments. This repository currently implements issue #1: **versioned function assignment configuration**.

A pre-approved researcher can sign in, create a Python function assignment with an ordered rubric and ordered tests, revise it, and open any saved configuration read-only. Every save that changes content creates immutable versions. A save based on an older active version is rejected instead of overwriting a newer one.

Submissions, Python execution, return comparison during a run, script assignments, seeded library data, drafts, restore/branching, and automatic merging are intentionally out of scope.

## Stack

- Cloudflare Workers with server-rendered HTML
- D1 for storage and sessions
- TypeScript, no runtime npm dependencies
- Vitest running inside the Workers runtime via `@cloudflare/vitest-plugin`
- Wrangler for local development and deployment

## Requirements

- Node.js **22.12 or newer** (`.nvmrc` pins 22.14.0)
- npm
- A Cloudflare account with D1 access for remote deployment

The original environment had Node 20, but the current Wrangler and Vitest releases require Node 22.12+. Use `nvm use` in the repository.

## Local setup

```sh
npm install
npx wrangler d1 migrations apply feedback-lab --local
npm run provision -- --email researcher@example.test --role researcher --local
npm run dev
```

Open <http://localhost:8787>, sign in with the printed password, and use the assignment library.

The local database lives under `.wrangler/` (ignored by git). `database_id` in `wrangler.jsonc` is a placeholder because local development does not use it. Replace it with the real D1 ID before the first remote deployment.

### Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run all unit and integration tests in the Workers runtime. |
| `npm run typecheck` | Type-check application, tests, and config. |
| `npm run dev` | Start the local Worker and D1. |
| `npm run db:migrate:local` | Apply D1 migrations locally. |
| `npm run db:migrate:remote` | Apply D1 migrations to the deployed database. |
| `npm run provision -- ...` | Create a user directly in D1. |
| `npm run deploy` | Deploy the Worker (not run for this issue). |

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

An **Assignment** has a stable ID and points to one active **Assignment version**. Each assignment version stores the title, task description, function format, entry point, and exact references to an immutable **Rubric version** and **Test suite version**. Rubric criteria and tests preserve order and content in their snapshot tables.

| Save | New versions |
| --- | --- |
| Create an assignment | Assignment, Rubric, and Test suite |
| Change only title, description, or entry point | Assignment only; reuse both referenced versions |
| Change only the rubric | Assignment and Rubric; reuse the Test suite version |
| Change only the tests | Assignment and Test suite; reuse the Rubric version |
| Change both rubric and tests | Assignment, Rubric, and Test suite |
| Save unchanged content | None |

Writes are atomic D1 batches. An `AFTER INSERT ON assignment_versions` trigger makes the newly inserted version active, so a failed batch cannot half-activate a version. `UNIQUE (assignment_id, version_number)` is the optimistic-concurrency guard: two researchers editing the same base produce exactly one new version, and the batch rolls back any child snapshots from the losing write.

No-op comparison uses validated values, not raw JSON text: object key order and whitespace do not create a version, while item order, content, or typed values do (including changing `1` to `1.0`). Snapshot tables are never updated or deleted. Exact-version lookup never falls back to the active version. History reads the versions and their active marker in one query.

## Configuration rules

- A nonblank title and task description are required.
- The entry point is a Unicode Python identifier such as `first_positive` or `café`, not a signature. It is saved under its NFKC-normalized spelling, which must not be a reserved keyword; soft keywords such as `match`, `case`, and `type` are allowed.
- At least one rubric criterion and one test are required.
- Criterion and test IDs use lowercase letters, digits, hyphens, or underscores, are unique within their list, and may repeat across lists.
- Lists are ordered. IDs of existing items should be kept when revising; a changed ID is a remove plus an add from the versioning point of view.
- Arguments are a JSON array: `[]` means no arguments, `[4, -1]` means two positional arguments, and `[[4, -1]]` means one list argument.
- The expected return is a separate JSON value. Explicit `null` means Python `None`; a blank field is missing and rejected.
- Supported values are integers, finite floating-point numbers, strings, booleans, `null`, and nested arrays/objects with string keys. Empty containers are supported.
- Malformed JSON, duplicate object keys, non-array argument lists, non-finite numbers, and integers that cannot be represented exactly as binary64 are rejected. For example, `9007199254740992` is accepted but `9007199254740993` is not. Integer tokens are kept in exact decimal form. Tokens with a decimal point or exponent are finite binary64 floats (for example, `1e20`); the saved JSON retains the float kind and the sign of `-0.0`.
- Stored arguments and expected returns are canonical JSON: object keys sort lexically (including numeric-looking keys), and arrays keep their order. The comparison rule is fixed to `function-value-v1`.
- To bound save and editor work, use at most 100 nonblank rows per list and 64 nested JSON arrays/objects per value. The saved text and compact JSON together may use up to 1 MiB in UTF-8; this leaves room under [D1's 2 MB per-row and per-string limit](https://developers.cloudflare.com/d1/platform/limits/). Display spacing and other input formatting do not count toward this size.

Validation errors are returned per field and per row. Successful saves create versions; failed, stale, and unchanged saves do not advance the active version. The HTML form keeps submitted input on validation and conflict responses.

## Routes

HTML:

| Route | Purpose |
| --- | --- |
| `GET /sign-in`, `POST /sign-in` | Sign in. |
| `POST /sign-out` | Sign out (CSRF required). |
| `GET /assignments` | Library, including the empty state. |
| `GET /assignments/new`, `POST /assignments` | Create a function assignment. |
| `GET /assignments/:id` | Active version. |
| `GET /assignments/:id/edit`, `POST /assignments/:id` | Revise from the active version. Detail-page Edit links pin the version that was viewed; if it has changed, explicitly reopen the active version. POST requires the original `baseVersionId`. |
| `GET /assignments/:id/history` | Saved versions, newest first. |
| `GET /assignments/:id/versions/:versionId` | Exact version, read-only. |

JSON API (researcher role required except `/api/session`; writes require `X-CSRF-Token` and a matching `Origin` when present):

| Route | Purpose |
| --- | --- |
| `GET /api/session` | Signed-in identity and CSRF token, or `{"authenticated":false}`. |
| `GET /api/assignments` | Library summaries with active title and rubric/test counts. |
| `POST /api/assignments` | Create; body `{"config": {...}}` or a bare config object. |
| `GET /api/assignments/:id` | Active version. |
| `GET /api/assignments/:id/versions` | Version summaries, newest first. |
| `GET /api/assignments/:id/versions/:versionId` | Exact version; 404 rather than falling back. |
| `POST /api/assignments/:id/versions` | Revise with `{"baseVersionId": "...", "config": {...}}`. |

Revise responses: `201` with `changed: true` for a new version, `200` with `changed: false` for a no-op, and `409` `{"error":"stale_version","currentVersionId":"..."}` for a stale base. Validation returns `400` / `422` with the field errors. Signed-out is 401; a member is 403.

For create and revise, send the test arguments and expected return as **JSON text strings** in `arguments` and `expectedReturn` (for example, `"arguments": "[1.0]"`). The `argumentsJson` and `expectedReturnJson` string fields take precedence when present, so test rows from a read response can be posted back unchanged. Do not submit only decoded values: a caller's own JSON parser may already have erased the integer/float distinction, and it cannot report duplicate keys after parsing them.

### What issue #2 consumes

`GET /api/assignments/:id/versions/:versionId` returns the exact immutable configuration, for example:

```json
{
  "version": {
    "id": "assignment-version-uuid",
    "assignmentId": "assignment-uuid",
    "versionNumber": 1,
    "format": "function",
    "entryPoint": "first_positive",
    "rubricVersionId": "rubric-version-uuid",
    "testSuiteVersionId": "test-suite-version-uuid",
    "rubric": {
      "versionId": "rubric-version-uuid",
      "criteria": [
        { "id": "r1", "description": "...", "expectedBehavior": "..." }
      ]
    },
    "testSuite": {
      "versionId": "test-suite-version-uuid",
      "comparisonRule": "function-value-v1",
      "tests": [
        {
          "id": "t1",
          "arguments": [[4, -1]],
          "argumentsJson": "[[4,-1]]",
          "expectedReturn": 4,
          "expectedReturnJson": "4",
          "comparisonRule": "function-value-v1"
        }
      ]
    },
    "createdAt": "2026-11-25T00:00:00.000Z",
    "createdBy": { "id": "user-uuid", "email": "researcher@example.test" }
  }
}
```

`arguments` and `expectedReturn` are JSON values emitted with the original numeric kind preserved on the wire. Some clients (including ordinary JavaScript JSON parsing) lose that distinction. For #2, **`argumentsJson` and `expectedReturnJson` are authoritative**: use lossless decoding of those strings, and use `entryPoint` as the canonical NFKC function name. A real run should pin the assignment, rubric, and test-suite version IDs it read and never resolve "latest" at result time.

## Deployment (not performed for this issue)

No deployment or hosted verification was performed in the issue #1 implementation or review-fixes worktree.

Maintainer steps:

1. `npx wrangler d1 create feedback-lab` and place the returned ID in `wrangler.jsonc`.
2. `npm run db:migrate:remote`.
3. Provision two researchers and one member:
   ```sh
   npm run provision -- --email researcher-a@example.edu --role researcher
   npm run provision -- --email researcher-b@example.edu --role researcher
   npm run provision -- --email member@example.edu --role member
   ```
4. `npm run deploy`.
5. Complete the hosted checklist below.

### Local verification performed

- `npm test` (all unit and Workers-runtime integration tests) passes.
- `npm run typecheck` passes.
- `npm run dev` starts against local D1 under Node 22.14.
- The `first_positive` create, reopen, metadata revision, and history flow was exercised manually with `curl` against the local Worker.
- Local headless Chrome exercised sign-in, repeated editor row add/remove, multiline JSON, save, reopen, and an unchanged resubmit.
- Local Workers-runtime tests verify that anonymous sign-in is throttled without replacing or blocking an existing session. The hosted checks below remain unexecuted.

### Hosted verification checklist (remaining)

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

## Implementation notes and deviations

- The research environment had no `cf` binary or Cloudflare login. The app uses `wrangler.jsonc` and Wrangler's Vitest integration, as documented in the local architecture notes.
- Node.js 22.12+ is required by the installed Wrangler/Vitest releases; Node 20 cannot run Wrangler 4.168.
- `@cloudflare/workers-types` is a dev dependency for editor/type-check support. It is not a runtime dependency.
- Stored JSON is canonical (`[[4,-1]]`); the edit form and detail view add spacing for display (`[[4, -1]]`) without changing values or numeric kinds. The edit form uses multiline JSON inputs so pasted formatting is kept on validation and conflict responses.
- Tests use a small cleanup helper between cases because the installed Workers Vitest plugin did not isolate D1 storage between tests automatically. Production migrations never seed data.
- No hosted checks have been run; see the checklist above.

## Project layout

```
src/
  app.ts          router and sign-in/sign-out
  api.ts          JSON API for assignments and versions
  auth.ts         D1 sessions, cookies, CSRF
  config.ts       configuration validation and no-op comparison
  editor-script.ts browser behavior for repeatable editor rows
  forms.ts        HTML form row parsing
  guard.ts        researcher access guard
  html.ts         shared layout, styles, escaping
  http.ts         response helpers and security headers
  json.ts         lossless JSON parser and canonicalization
  pages.ts        library, editor, detail, and history views
  password.mjs    shared Worker and Node Web Crypto password helpers
  repository.ts   D1 queries and immutable version writes
  web.ts          server-rendered assignment routes
migrations/       D1 schema (no seeds)
scripts/          maintainer provisioning
test/             unit and Workers-runtime integration tests
docs/adr/         architecture decisions
```
