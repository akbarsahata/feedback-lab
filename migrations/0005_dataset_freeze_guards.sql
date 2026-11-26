CREATE TABLE dataset_protocol_locks (
  revision_id TEXT PRIMARY KEY REFERENCES dataset_revisions(id),
  protocol_ref TEXT NOT NULL CHECK (length(trim(protocol_ref)) > 0),
  locked_by TEXT NOT NULL REFERENCES users(id),
  locked_at TEXT NOT NULL
);

ALTER TABLE dataset_cases ADD COLUMN package_assignment_id TEXT;
ALTER TABLE dataset_cases ADD COLUMN package_assignment_revision TEXT;

CREATE TRIGGER dataset_freeze_split_guard
BEFORE UPDATE OF status ON dataset_revisions
WHEN OLD.status = 'draft' AND NEW.status = 'frozen' AND (
  EXISTS (
    SELECT 1 FROM dataset_cases candidate
    JOIN dataset_cases previous ON previous.family_id = candidate.family_id
      OR previous.package_assignment_id = candidate.package_assignment_id
    JOIN dataset_revisions prior ON prior.id = previous.revision_id
    WHERE candidate.revision_id = NEW.id AND prior.dataset_id = NEW.dataset_id
      AND prior.status = 'frozen' AND candidate.split <> previous.split
  ) OR EXISTS (
    SELECT 1 FROM dataset_cases candidate
    JOIN dataset_submissions source ON source.case_id = candidate.id
    JOIN dataset_revisions prior ON prior.dataset_id = NEW.dataset_id AND prior.status = 'frozen'
    JOIN dataset_cases previous ON previous.revision_id = prior.id AND previous.split <> candidate.split
    JOIN dataset_submissions earlier ON earlier.case_id = previous.id
    WHERE candidate.revision_id = NEW.id
      AND (source.source_path = earlier.source_path OR source.source_sha256 = earlier.source_sha256)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'dataset_split_conflict');
END;
