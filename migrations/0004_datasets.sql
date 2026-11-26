-- Feedback Lab schema for issue #4: versioned paired datasets, researcher
-- verification, study evidence, and held-out release.
--
-- A dataset revision is an immutable import. Corrections create a new revision;
-- previous revisions, their pinned runs, and their sign-offs stay readable.

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  active_revision_id TEXT REFERENCES dataset_revisions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dataset_revisions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  package_revision TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'frozen')),
  imported_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL,
  frozen_by TEXT REFERENCES users(id),
  frozen_at TEXT,
  released_by TEXT REFERENCES users(id),
  released_at TEXT,
  study_protocol_ref TEXT,
  UNIQUE (dataset_id, package_revision),
  CHECK (
    (status = 'draft' AND frozen_by IS NULL AND frozen_at IS NULL
      AND released_by IS NULL AND released_at IS NULL AND study_protocol_ref IS NULL)
    OR
    (status = 'frozen' AND frozen_by IS NOT NULL AND frozen_at IS NOT NULL)
  ),
  CHECK (
    (released_by IS NULL AND released_at IS NULL AND study_protocol_ref IS NULL)
    OR
    (status = 'frozen' AND released_by IS NOT NULL AND released_at IS NOT NULL
      AND study_protocol_ref IS NOT NULL)
  )
);

CREATE INDEX dataset_revisions_dataset_id ON dataset_revisions(dataset_id, imported_at);

CREATE TABLE dataset_cases (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES dataset_revisions(id),
  case_key TEXT NOT NULL,
  family_id TEXT NOT NULL,
  split TEXT NOT NULL CHECK (split IN ('development', 'held_out')),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  assignment_version_id TEXT NOT NULL REFERENCES assignment_versions(id),
  format TEXT NOT NULL CHECK (format IN ('function', 'script')),
  pair_targeted_json TEXT,
  authoring_checks_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (revision_id, case_key)
);

CREATE INDEX dataset_cases_revision_id ON dataset_cases(revision_id, split);

CREATE TABLE dataset_submissions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES dataset_cases(id),
  version TEXT NOT NULL CHECK (version IN ('single', 'original', 'corrected')),
  source_path TEXT NOT NULL,
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  scoring_json TEXT NOT NULL,
  frozen_run_id TEXT REFERENCES test_runs(id),
  UNIQUE (case_id, version)
);

CREATE TABLE dataset_attempts (
  id TEXT PRIMARY KEY,
  dataset_submission_id TEXT NOT NULL REFERENCES dataset_submissions(id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submission_versions(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES test_runs(id),
  attempt_number INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (dataset_submission_id, attempt_number)
);

CREATE TABLE dataset_signoffs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES dataset_cases(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  signed_at TEXT NOT NULL,
  case_fingerprint TEXT NOT NULL,
  evidence_note TEXT NOT NULL CHECK (length(trim(evidence_note)) > 0)
);
