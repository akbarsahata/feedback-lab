# Issue #4 local verification

This record covers local implementation and verification for [#4](https://github.com/akbarsahata/feedback-lab/issues/4). The restricted corpus was run locally; its researcher sign-off and initial study freeze are pending.

## Commands run

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| Workers Vitest suite | 198 tests in 16 files pass |
| `python3 -m unittest discover -s runner -p 'test_*.py'` | 32 tests pass |

## Verified locally

- A package imports once; the same revision and digest is a no-op; changed contents under the same label are rejected.
- Package validation reports case-level errors for split/family conflicts, cross-split source reuse, mixed assignment revisions, same-path pairs, unresolved key evidence, unknown verification cases, malformed test rows, invalid UTF-8, and unsupported revision labels.
- UTF-8 BOM and exact source bytes are preserved; the stored SHA-256 is computed from those bytes.
- Import creates exact assignment snapshots in the same D1 batch as the revision, cases, and submissions. Dataset launches reuse the existing run and pending-result creation.
- Sign-off records the researcher, timestamp, evidence note, and a fingerprint over the case contents, assignment version, sources, and key. Changing scored contents invalidates the sign-off.
- Freeze is blocked until every case is signed off, every submission has a completed run with an outcome for every pinned test, every clean submission passes every supplied test, the 12-cell coverage matrix is complete, and each split/format has a buggy all-tests-pass submission.
- Failed attempts remain visible; a retry creates a new submission/run pair and freeze pins the successful one.
- A frozen revision rejects new launches and new sign-offs. Concurrent freezes of conflicting drafts publish at most one revision; the rejected draft retains no run pins.
- `use=pilot` lists and resolves only development evidence. `use=main` requires release and its matching #12 protocol lock. An arbitrary reference cannot unlock held-out cases. Direct lookup with a submission from the other split returns 404.
- The evidence response contains only the format, assignment instructions, rubric, source, and supplied tests with recorded results. It omits case/revision/submission identifiers, pair links, original/corrected labels, the scoring key, and authoring checks.
- The scoring read separately returns pair targets and keys linked to their exact submission IDs.
- The researcher-only study endpoints are guarded, schema-validated, and present in the generated OpenAPI document.

## Restricted corpus rehearsal

Imported the 12-case, 20-submission package through the researcher UI into a disposable local D1 database. The Worker queue dispatched all 20 runs to `native-python-runner/2` with Python `3.12.11` in a network-disabled local container. All 40 supplied test outcomes matched the recorded expectations; each split and assignment format has a source-evident bug that passes every supplied test. Another 40 targeted authoring checks matched their oracles and stayed outside the study suites. The freeze request returned the 12 missing human sign-offs. The package, local draft ID, full digest, and detailed results are in restricted local storage outside Git.

## Pending

- Human verification and sign-off, plus the initial freeze in the authorized study environment. The disposable rehearsal database is not the study database.
- Held-out release after #12 freezes the study protocol.
- The hosted pilot belongs to #12.

## Reproducing a fresh import

1. Apply all D1 migrations to an empty database.
2. Provision a researcher.
3. Start the app and open `/datasets`.
4. Import `manifest.json`, `scoring-key.json`, `verification.json`, and all referenced `.py` files from the restricted package.
5. Review each case, enter the evidence checked, and sign off.
6. Record a study run for every submission through the private runner.
7. Freeze when the detail page reports no blocking issues.
8. Record the frozen revision ID and package digest. Hold release until the study protocol is locked.

The disposable example in `examples/dataset-package/` exercises steps 1-4 only; it intentionally fails the freeze coverage matrix.
