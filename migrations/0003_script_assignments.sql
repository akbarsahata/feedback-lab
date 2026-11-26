-- Feedback Lab schema for issue #3: script assignments and script test runs.
-- Existing function assignments, tests, submissions, runs, and results keep
-- their IDs and values. New columns are nullable where old function data does
-- not need them, so a rollback to the function-only application can still
-- read and write function data.
--
-- The assignment/run graph is cyclic. Rebuilding it in place while child rows
-- exist leaves deferred foreign-key state behind in D1, so this migration
-- creates parallel "v2" tables, copies every row, drops the old tables
-- leaf-first, and renames the replacements into place inside one transaction.

PRAGMA defer_foreign_keys = on;

CREATE TABLE tests_new (
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  position INTEGER NOT NULL,
  test_id TEXT NOT NULL,
  arguments_json TEXT,
  expected_return_json TEXT,
  stdin TEXT,
  expected_stdout TEXT,
  comparison_rule TEXT NOT NULL CHECK (
    (comparison_rule = 'function-value-v1'
      AND arguments_json IS NOT NULL
      AND expected_return_json IS NOT NULL
      AND stdin IS NULL
      AND expected_stdout IS NULL)
    OR
    (comparison_rule = 'script-stdout-v1'
      AND arguments_json IS NULL
      AND expected_return_json IS NULL
      AND stdin IS NOT NULL
      AND expected_stdout IS NOT NULL)
  ),
  PRIMARY KEY (test_suite_version_id, position),
  UNIQUE (test_suite_version_id, test_id)
);

INSERT INTO tests_new
  (test_suite_version_id, position, test_id, arguments_json,
   expected_return_json, stdin, expected_stdout, comparison_rule)
SELECT test_suite_version_id, position, test_id, arguments_json,
       expected_return_json, NULL, NULL, comparison_rule
FROM tests;

DROP TABLE tests;
ALTER TABLE tests_new RENAME TO tests;

CREATE TABLE assignment_versions_v2 (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments_v2(id),
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('function', 'script')),
  entry_point TEXT,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (assignment_id, version_number),
  CHECK (
    (format = 'function' AND entry_point IS NOT NULL)
    OR (format = 'script' AND entry_point IS NULL)
  )
);

CREATE TABLE assignments_v2 (
  id TEXT PRIMARY KEY,
  active_version_id TEXT REFERENCES assignment_versions_v2(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE submission_versions_v2 (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments_v2(id),
  assignment_version_id TEXT NOT NULL REFERENCES assignment_versions_v2(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  source BLOB NOT NULL,
  source_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE test_runs_v2 (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submission_versions_v2(id),
  assignment_id TEXT NOT NULL REFERENCES assignments_v2(id),
  assignment_version_id TEXT NOT NULL REFERENCES assignment_versions_v2(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  comparison_rule TEXT NOT NULL CHECK (
    comparison_rule IN ('function-value-v1', 'script-stdout-v1')
  ),
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

CREATE TABLE test_results_v2 (
  run_id TEXT NOT NULL REFERENCES test_runs_v2(id) ON DELETE CASCADE,
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
  stdout_lossy INTEGER NOT NULL DEFAULT 0 CHECK (stdout_lossy IN (0, 1)),
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
  diagnostic TEXT,
  PRIMARY KEY (run_id, test_id),
  UNIQUE (run_id, position)
);

INSERT INTO assignment_versions_v2
  (id, assignment_id, version_number, title, description, format, entry_point,
   rubric_version_id, test_suite_version_id, created_at, created_by)
SELECT id, assignment_id, version_number, title, description, format, entry_point,
       rubric_version_id, test_suite_version_id, created_at, created_by
FROM assignment_versions;

INSERT INTO assignments_v2
  (id, active_version_id, created_at, updated_at)
SELECT id, active_version_id, created_at, updated_at
FROM assignments;

INSERT INTO submission_versions_v2
  (id, assignment_id, assignment_version_id, rubric_version_id,
   test_suite_version_id, source, source_sha256, byte_size, created_by, created_at)
SELECT id, assignment_id, assignment_version_id, rubric_version_id,
       test_suite_version_id, source, source_sha256, byte_size, created_by, created_at
FROM submission_versions;

INSERT INTO test_runs_v2
  (id, submission_id, assignment_id, assignment_version_id, rubric_version_id,
   test_suite_version_id, comparison_rule, python_release, runner_artifact,
   limits_json, status, queued_at, started_at, finished_at, incomplete_reason,
   created_by)
SELECT id, submission_id, assignment_id, assignment_version_id, rubric_version_id,
       test_suite_version_id, comparison_rule, python_release, runner_artifact,
       limits_json, status, queued_at, started_at, finished_at, incomplete_reason,
       created_by
FROM test_runs;

INSERT INTO test_results_v2
  (run_id, test_id, position, status, started_at, finished_at, execution_ms,
   startup_ms, runner_warm, actual_json, stdout, stderr, stdout_lossy,
   output_truncated, diagnostic)
SELECT run_id, test_id, position, status, started_at, finished_at, execution_ms,
       startup_ms, runner_warm, actual_json, stdout, stderr, 0,
       output_truncated, diagnostic
FROM test_results;

DROP TRIGGER activate_assignment_version;
DROP TABLE test_results;
DROP TABLE test_runs;
DROP TABLE submission_versions;
DROP TABLE assignments;
DROP TABLE assignment_versions;

ALTER TABLE assignments_v2 RENAME TO assignments;
ALTER TABLE assignment_versions_v2 RENAME TO assignment_versions;
ALTER TABLE submission_versions_v2 RENAME TO submission_versions;
ALTER TABLE test_runs_v2 RENAME TO test_runs;
ALTER TABLE test_results_v2 RENAME TO test_results;

CREATE INDEX assignment_versions_assignment_id ON assignment_versions(assignment_id);
CREATE INDEX submission_versions_assignment_id
  ON submission_versions(assignment_id, created_at DESC);
CREATE INDEX test_runs_assignment_version_id
  ON test_runs(assignment_version_id, queued_at DESC);
CREATE INDEX test_runs_status_queued_at ON test_runs(status, queued_at);

CREATE TRIGGER activate_assignment_version
AFTER INSERT ON assignment_versions
BEGIN
  UPDATE assignments
  SET active_version_id = NEW.id,
      updated_at = NEW.created_at
  WHERE id = NEW.assignment_id;
END;
