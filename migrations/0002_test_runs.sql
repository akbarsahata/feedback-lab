-- Feedback Lab schema for issue #2: version-pinned submissions and test runs.
-- A submission version retains its exact source bytes. A test run pins the
-- assignment, rubric, and test suite versions it was launched against, so later
-- configuration edits cannot change its evidence.

CREATE TABLE submission_versions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  assignment_version_id TEXT NOT NULL REFERENCES assignment_versions(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX submission_versions_assignment_id
  ON submission_versions(assignment_id, created_at DESC);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submission_versions(id),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  assignment_version_id TEXT NOT NULL REFERENCES assignment_versions(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  comparison_rule TEXT NOT NULL CHECK (comparison_rule = 'function-value-v1'),
  python_release TEXT NOT NULL,
  runner_artifact TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'incomplete')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  incomplete_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE INDEX test_runs_assignment_version_id
  ON test_runs(assignment_version_id, queued_at DESC);
CREATE INDEX test_runs_status_queued_at ON test_runs(status, queued_at);

CREATE TABLE test_results (
  run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'running',
    'pass',
    'mismatch',
    'execution_error',
    'timed_out',
    'memory_limit',
    'output_limit',
    'infrastructure_failure',
    'not_run'
  )),
  started_at TEXT,
  finished_at TEXT,
  execution_ms INTEGER,
  startup_ms INTEGER,
  runner_warm INTEGER,
  actual_json TEXT,
  stdout TEXT,
  stderr TEXT,
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
  diagnostic TEXT,
  PRIMARY KEY (run_id, test_id),
  UNIQUE (run_id, position)
);
