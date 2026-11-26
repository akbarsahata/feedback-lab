# Execution plan: Configure, run, and inspect script assignments

**Start here:** Read [issue #3](https://github.com/akbarsahata/feedback-lab/issues/3) for the agreed behavior and closure criteria. Use this plan for implementation order. [Issue #2](https://github.com/akbarsahata/feedback-lab/issues/2) is closed; reuse its test-run lifecycle and [hosted runner baseline](../verification/issue-2-hosted-runner.md). Use the [glossary](../../GLOSSARY.md) and [auth ADR](../adr/0001-first-party-authentication.md) for terminology and access rules. This plan records no implementation or verification and does not authorize a deployment.

## 1. Establish the baseline and check the API toolchain

- Run the checks below before changing production code. Find function fixtures and helpers that consume decoded `arguments` or `expectedReturn`; migrate those consumers with the API change, without removing tests of numeric-kind preservation.
- Check Zod 4 and `zod-openapi` 6 on the repo's Node 22.14 toolchain and in the actual Workers test runtime. Exercise a two-format schema, document generation, and response validation before replacing the existing API parser. Keep the current router; update Node engines and pin dependencies through the lockfile.

**Checkpoint:** Existing regressions are green or recorded; the Worker can validate a response and produce an OpenAPI 3.1 document for both schema branches.

## 2. Add format-aware snapshots and migrate existing records

- In `src/config.ts` and `src/repository.ts`, model function and script configuration as distinct variants. Keep the title, task description, rubric, ordered test IDs, and snapshot rules shared. A script suite uses `stdin`, `expectedStdout`, and a distinct versioned comparison rule. Reject fields that belong to the wrong variant rather than interpreting them as script text or allowing mixed suites.
- Preserve script text without trimming or normalizing it. Validate explicit empty strings separately from missing input, reject strings that cannot round-trip as UTF-8, and count the 16 KiB per-field limits in encoded bytes. Keep the existing total configuration and row bounds. Compare saved script text exactly for no-op detection, even if two expectations would match the same stdout. Switching format always creates a new suite; reuse an unchanged rubric.
- Add a migration after `0002`; don't edit applied migrations. The existing tables constrain assignment format and comparison rules to function values. Change those constraints while preserving IDs, the activation trigger, indexes, foreign keys, historical assignments, source bytes, and all results. If rebuilding tables, heed [D1 foreign-key behavior](https://developers.cloudflare.com/d1/sql-api/foreign-keys/): deferring checks does not prevent cascade deletes.

**Checkpoint:** Upgrade a D1 fixture seeded using only the old migrations, including a saved function result and an active version newer than the run. Check row counts and `foreign_key_check`, reopen the original evidence, then save and revise a script assignment. Verify no-op saves and that a format switch leaves the old version untouched.

## 3. Extend the runner contract and compare trusted evidence

- In `src/runs.ts`, `src/coordinator.ts`, and `src/runner.ts`, load each test's format, input, expectation, and comparison rule from the pinned version. Keep the expected result on the Worker side. Update the private job/result version and artifact identity as needed; validate the format-specific result before use. A completed script provides captured stdout, not a fabricated function return. Keep historical function records readable regardless of the current runner.
- In `runner/`, execute the script as `__main__` under the existing supervision, using explicit UTF-8 behavior. Feed stdin through EOF without blocking stdout/stderr capture or bypassing the execution deadline. Preserve the existing timing, limits, and cleanup. Classify completion from the trusted runner, not from submission text.
- Compare exact text after the issue's two normalization steps, without rewriting storage. Store complete empty stdout as `""`; keep unavailable output distinct. Preserve bounded output on failures and expose whether it is partial or lossy. Count the output cap against captured bytes, not the size of a replacement-character preview. Check stdout UTF-8 separately from stderr so a diagnostic stream cannot turn normally completed, valid stdout into a mismatch. A confirmed resource limit remains the outcome, including when truncation cuts a UTF-8 character.

**Checkpoint:** Native fixtures verify `__main__`, byte-exact stdin through EOF (including 16 KiB, non-ASCII, CRLF, and no final LF), empty input, separate stderr, nonzero exit, invalid stdout, and resource outcomes. Cover a script that does not consume all stdin. Worker tests prove the comparison matrix, versioned job/result validation, continuation after a submission failure, and preservation of completed results on interruption. Function comparison, tagged values, and numeric kinds still pass.

## 4. Connect configuration, launch, and evidence pages

- Update `src/forms.ts`, `src/editor-script.ts`, `src/pages.ts`, and `src/web.ts` for the format selector, format-specific test rows, and format-switch warning. Reuse the existing stale-version, researcher, CSRF, and launch flows. Form re-rendering must preserve leading blank lines, trailing spaces, and empty values as submitted; account for browser newline handling and preserve literal CRLF when received via the JSON API.
- Update `src/run-pages.ts` and `src/runs-web.ts` to render the pinned format and selected test only. Escape all supplied text. Provide a way to see where line endings, blank lines, and trailing spaces differ. Distinguish empty stdout, unavailable stdout, partial capture, and a lossy preview without relying solely on color. Keep the function view intact.

**Checkpoint:** Browser or Workers UI tests cover create, revise, validation redisplay, stale launch with no writes, successful script launch, exact evidence after switching format, and direct-route denial for non-researchers.

## 5. Wire runtime Zod validation into the JSON API and publish its docs

- Drive `/api/session` and the existing assignment operations from shared request and response schemas. Preserve valid function writes, including omitted `format`, bare and wrapped creates, and JSON-text aliases with existing `*Json` precedence. Use the existing lossless parser for the contents of those strings. Return only validated `argumentsJson` and `expectedReturnJson` for function test values. Serialize validated plain JSON objects; drop hand-assembled response strings.
- Share format and field validation with the editor where practical; keep domain checks that OpenAPI cannot express (such as UTF-8 byte limits and duplicate test IDs) authoritative at runtime and describe them in schema metadata. Preserve the existing status and error behavior. Validate successful and documented error responses; if validation fails, return a known generic `500` without logging the rejected payload or credentials.
- Generate `/api/openapi.json` from the runtime schemas, with examples for both formats and the session and CSRF requirements. Serve pinned `swagger-ui-dist` assets from the same origin under `/api/docs`. Use [Worker-first asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#run-your-worker-script-first) so the researcher guard runs before any docs asset is served. Configure Swagger UI for GET-only “Try it out” and disable external spec validation. Limit any CSP adjustment to the docs page. Replace the README contract tables with links and a breaking-change note for function response consumers.

**Checkpoint:** Integration tests check actual JSON responses against the schemas for both formats and common failures, assert the lossless numeric text and absence of decoded fields, and prove invalid requests create no records. Browser smoke test: a researcher can open the docs and try a GET, but cannot execute a POST from Swagger. Signed-out users and members cannot fetch the page, spec, or protected assets directly.

## 6. Verify locally, then verify an approved deployed release

- Run all three checks. Document how the migration, private runner, and app release will be sequenced. Rehearse on disposable data; either support the pending job versions during the transition or arrange an approved drain before switching. Never route a queued run to a different artifact silently. Preserve the rollback path for data written in the new format.
- In an approved hosted environment, follow #3's closure matrix using synthetic fixtures and compare the shared isolation and limits against the #2 baseline. Include a later passing test after a submission-caused failure. Verify the hosted Swagger page and spec use the same researcher boundary. Record observations and reproducible steps in `docs/verification/issue-3-hosted-runner.md`, and link the record from the PR or issue. If access or a required check is missing, report the blocker and leave #3 open.

```sh
npm run typecheck
npm test
python3 -m unittest discover -s runner -p 'test_*.py'
```

**Checkpoint:** Local regression results and hosted evidence are linked from #3 or its PR. The hosted record distinguishes what was verified from what remains unverified; a local or fake-runner pass does not satisfy the hosted gate.
