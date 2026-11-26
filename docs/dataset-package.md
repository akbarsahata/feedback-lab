# Dataset package format

A dataset package is three JSON files plus the Python sources embedded in the manifest. The researcher imports all three through `/datasets`.

| File | Contains | Enters model input? |
| --- | --- | --- |
| `manifest.json` | Dataset identity, assignment definitions, split and family membership, exact sources, and pair membership | Only the source and assignment data for one scored submission |
| `scoring.json` | Expected errors, acceptable evidence, clean designations, and targeted error IDs | No |
| `verification.json` | Authoring checks and their results | No |

The importer validates the package before writing any row. Errors are reported by case, assignment, or package field.

## Manifest

```json
{
  "format": 1,
  "datasetId": "intro-python-paired",
  "revision": "2026-11-27.1",
  "assignments": {
    "range-count": {
      "title": "Count values inside a range",
      "description": "Implement count_in_range(values, low, high). Return how many values are inside the inclusive range.",
      "format": "function",
      "entryPoint": "count_in_range",
      "criteria": [
        { "id": "inclusive-bounds", "description": "Inclusive bounds", "expectedBehavior": "Both endpoints count as inside." }
      ],
      "tests": [
        { "id": "both-bounds", "arguments": "[[1, 2, 3, 4], 2, 3]", "expectedReturn": "2" }
      ]
    }
  },
  "cases": [
    {
      "id": "dev-fn-clean",
      "familyId": "family-range-count",
      "split": "development",
      "assignmentId": "range-count",
      "submissions": [
        {
          "version": "single",
          "path": "cases/dev-fn-clean/submission.py",
          "assignmentRevision": "1"
        }
      ]
    }
  ],
  "submissions": {
    "cases/dev-fn-clean/submission.py": { "text": "def count_in_range(values, low, high):\n    return sum(1 for value in values if low <= value <= high)\n" }
  }
}
```

- `revision` uses `YYYY-MM-DD.N`. Importing the same dataset ID and revision twice is a no-op when the content digest matches; changed content under the same label is rejected.
- Each assignment is inserted as a new immutable assignment snapshot. `assignmentRevision` is a package label; a pair must use one revision on both submissions.
- A case is either one `single` submission or an `original`/`corrected` pair. A submission source is stored exactly as UTF-8.
- `split` is `development` or `held_out`. A family, or a source file, cannot appear in both splits.
- Sources are UTF-8 text by default. Use `{ "text": "<base64>", "encoding": "base64" }` when a file cannot be represented as a JSON string.
- The importer stores the exact decoded bytes, including a UTF-8 BOM, and hashes those bytes.

## Scoring key

```json
{
  "datasetId": "intro-python-paired",
  "revision": "2026-11-27.1",
  "cases": {
    "dev-fn-fix": {
      "targetedErrorIds": ["off-by-one"],
      "submissions": {
        "original": {
          "clean": false,
          "errors": [
            {
              "id": "off-by-one",
              "requirement": "inclusive-bounds",
              "evidence": [
                { "kind": "source", "path": "cases/dev-fn-fix/original.py", "startLine": 2, "endLine": 2 },
                { "kind": "test", "testId": "both-bounds" }
              ],
              "note": "The upper bound is excluded."
            }
          ]
        },
        "corrected": { "clean": true, "errors": [] }
      }
    }
  }
}
```

- A single case may be clean or buggy; a scored single with errors is allowed. A pair names at least one `targetedErrorId`; that error must appear in the original and be absent from the corrected key. Any unrelated surviving error keeps its identity on the corrected submission.
- Evidence references either a line range in that submission's source or a supplied study test. Rubric criterion IDs and test IDs must resolve against the assignment.
- Expected errors are established independently of either feedback workflow.

## Verification record

```json
{
  "datasetId": "intro-python-paired",
  "revision": "2026-11-27.1",
  "cases": {
    "dev-fn-clean": {
      "authoringChecks": [
        { "id": "source-review", "status": "pass", "note": "Researcher checked the requirement against the source." }
      ]
    }
  }
}
```

Authoring checks are separate from the supplied study tests. They never enter the study-test suite or model input.

## Researcher workflow

1. Open `/datasets` and import the three files. Fix any reported case-level errors.
2. Review each case on `/datasets/:revisionId`: exact source, task, rubric, supplied tests, source hash, scoring key, authoring checks, and study-run attempts. Record the evidence you checked in the sign-off form and sign off each case.
3. Use **Record study run** for every submission version. Runs use the existing pinned runner and limits. A failed assertion is valid evidence; an infrastructure failure or an unfinished test blocks freeze. Retry an incomplete run; failed attempts are retained.
4. Freeze. Freeze requires all 12 coverage cells (`development`/`held_out` × `function`/`script` × clean/fixed/partial), a signed-off case fingerprint for every case, a completed run with an outcome for every test of the pinned suite, every clean submission passing every supplied study test, and a buggy all-tests-pass submission in each split and format.
5. Release held-out cases only after the study protocol is frozen. Store the protocol reference; release is separate from freeze.

A correction is a new `revision`. Previous revisions remain frozen, resolve their pinned runs, and stay readable by study code that used them.

## Study read boundary

`/api/datasets/:revisionId/study/*` requires researcher access and an explicit `use`:

- `use=pilot` can read only development cases.
- `use=main` can read held-out cases only after release.
- Direct lookup by submission ID is scoped to the eligible case; an ID from the other split returns `404`.

The evidence response has no case key, revision ID, submission ID, counterpart source, original/corrected label, pair link, scoring key, or authoring verification evidence. The caller already knows the revision and submission it requested. `GET .../study/scoring/:caseKey` exposes pair links and the key separately for known-error and correction scoring.

## Public repository boundary

This repository is public. Commit the format, the importer, tests, and disposable examples. Keep the real development and held-out corpus, scoring key, verification record, and freeze identifiers in restricted researcher storage. Record the package digests and frozen revision IDs where the study needs to identify the corpus. In this design the scoring key is versioned with the dataset revision; there is no separate mutable key version.

The example under [`examples/dataset-package/`](../examples/dataset-package/) is a disposable import smoke test. It does not meet the freeze coverage matrix.
