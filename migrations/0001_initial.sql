-- Feedback Lab schema for issue #1: versioned function assignments.
-- Snapshot tables are append-only. Assignment versions are activated by the
-- AFTER INSERT trigger below, so a version insert and its activation are one
-- atomic step.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('researcher', 'member')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  active_version_id TEXT REFERENCES assignment_versions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rubric_versions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE rubric_criteria (
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  position INTEGER NOT NULL,
  criterion_id TEXT NOT NULL,
  description TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  PRIMARY KEY (rubric_version_id, position),
  UNIQUE (rubric_version_id, criterion_id)
);

CREATE TABLE test_suite_versions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE tests (
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  position INTEGER NOT NULL,
  test_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  expected_return_json TEXT NOT NULL,
  comparison_rule TEXT NOT NULL,
  PRIMARY KEY (test_suite_version_id, position),
  UNIQUE (test_suite_version_id, test_id)
);

CREATE TABLE assignment_versions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format = 'function'),
  entry_point TEXT NOT NULL,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  test_suite_version_id TEXT NOT NULL REFERENCES test_suite_versions(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (assignment_id, version_number)
);

CREATE INDEX assignment_versions_assignment_id ON assignment_versions(assignment_id);

CREATE TRIGGER activate_assignment_version
AFTER INSERT ON assignment_versions
BEGIN
  UPDATE assignments
  SET active_version_id = NEW.id,
      updated_at = NEW.created_at
  WHERE id = NEW.assignment_id;
END;
