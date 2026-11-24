# Implementation plan: Versioned function assignments

**Scope:** [GitHub issue #1](https://github.com/akbarsahata/python-assignment-assessor-assistant/issues/1), the function-assignment portion of FR-01. This document plans the work; it does not authorize or record an implementation or deployment.

## Goal and boundaries

A pre-approved researcher signs in, creates a function assignment in a shared library, revises it, and can reopen every saved configuration read-only. A second researcher can collaborate without silently overwriting a newer version. Use the existing [wireframe](../../wireframes/feedback-lab.html) as a layout reference, not as application code.

No runner, submissions, return comparison, or real-run regression in #1; those belong to #2. Script assignments belong to #3. No seeded library records, drafts, restore, branching, or automatic merging. Use synthetic examples only in tests and walkthroughs.

## Proposed technical direction

- Follow the documented Cloudflare Workers hosting plan. Use a small web UI and server-side handlers in one application; choose the simplest UI setup that supports repeatable form rows and preserves unsaved edits.
- Prefer D1 for the relational records, provided the selected write pattern can atomically create snapshots and advance the active version with a stale-version check. Confirm this early with a storage integration test. A transactional batch alone is insufficient if a failed conditional update can still commit inserted snapshots.
- Choose the hosted identity provider against the project's account setup before building auth. Use verified identities and maintainer-managed researcher access. Keep authentication separate from the researcher permission check so a signed-in non-researcher is not treated as a researcher.
- Define stable assignment IDs and immutable assignment, rubric, and test suite version IDs. Represent ordered criteria and tests within their respective snapshots. Expose exact-version lookup for #2, separate from active-version lookup; never fall back to the active version when a requested historical version is missing.

## Work sequence

### 1. Establish the app and access boundary

- Set up the minimal Workers app and local test configuration. Add a shared server-side researcher guard for list, detail, history, create, and revise operations. Protect direct requests, not just navigation.
- Plan a hosted test environment with two approved researchers and one authenticated non-researcher. Keep test identity substitutes confined to local tests. For cookie-based authentication, include write-request CSRF protection.
- **Checkpoint:** the same operation allows approved researchers and denies both signed-out and signed-in unauthorized callers, without exposing assignment data.

### 2. Define and test the configuration contract

- Define the shared configuration fields: title, task description, function entry point, ordered criteria, and ordered tests. Enforce required fields, Python identifier and keyword rules, and ID syntax and uniqueness within each list. Check that a Python name is syntactically valid without running code or checking whether any submission defines it.
- Keep arguments and expected returns as raw field text at the request boundary, or use an equivalent lossless representation. Validate duplicate JSON object keys and numeric precision before normal parsing can discard them. Preserve supported types, nesting, list order, and explicit `null`; reject a blank expected return, a non-array argument list, non-finite values, and integers that cannot round-trip exactly.
- Define no-op equality for the saved configuration: compare validated values rather than raw JSON whitespace or object key order; preserve ordered criteria, tests, and arrays, and do not use Python return-comparison rules to decide whether stored typed data changed.
- Return actionable errors keyed by field and row. Include tests for `[]`, `[4, -1]`, `[[4, -1]]`, `[[]]`, `null` versus blank, duplicate IDs in each list, and the same ID appearing once in each list.
- **Checkpoint:** valid examples round-trip intact; invalid examples identify the correct field or row.

### 3. Save and resolve immutable versions

- Add a persistence migration and operations to list assignments, load the active version, list saved versions, and load an exact version with its rubric and tests.
- Create the initial three snapshots and the active pointer atomically. For revisions, compare against the editor's base version. If it is stale, return a conflict. If it is current and unchanged, return the current version without writing. Otherwise, create an Assignment version and replace only the child snapshots whose content changed.
- Make the stale-version guard and all snapshot writes part of one atomic operation. Do not expose in-place edits to snapshot records.
- **Checkpoint:** integration tests cover create, metadata-only, rubric-only, tests-only, both children changed, no-op, and failed saves. A race between two writes from the same base produces exactly one successful revision, with no snapshots from the rejected write. Exact-version lookup still returns the original child IDs and content.

### 4. Connect the library, editor, and history

- Build the empty and populated library states, with active titles and rubric/test counts. Add one create/edit form with repeatable criterion and test rows and examples distinguishing one list argument from two positional arguments.
- Open the active version by default; show older versions in a read-only view using their exact linked snapshots. Keep form input on validation or conflict errors. On conflict, explain that a newer version exists and offer a way to open it without silently discarding the stale form.
- **Checkpoint:** a researcher can create, reopen, revise, and inspect history without a runner or seeded data.

### 5. Verify the hosted flow and hand off to #2

- Run local validation, persistence, and access tests. On the hosted environment, verify real sign-in with both researchers and verify denial for signed-out and signed-in unauthorized users through both the UI and direct requests.
- Create `first_positive` with `[[4, -1]]` → `4` and `[[]]` → `null`. Reopen it, revise a test and then a criterion, inspect the original version, and repeat the two-session stale-save scenario. Confirm failed saves preserve input and do not advance history.
- Document maintainer provisioning, the hosted verification results, and the version IDs and typed test representation #2 should consume. #2 owns the regression proving a real run remains pinned after a later edit.
