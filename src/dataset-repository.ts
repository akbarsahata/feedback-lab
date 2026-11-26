import type { AssignmentFormat } from './config';
import {
  assignmentSnapshotStatements,
  getVersion,
} from './repository';
import {
  coverageForCases,
  type AuthoringCheck,
  type DatasetCoverage,
  type DatasetPackageFiles,
  type DatasetSplit,
  type ParsedDatasetPackage,
  type ScoringEntry,
} from './dataset-package';
import { EXECUTION_TEST_STATUSES, submissionRunStatements, type ExecutionTestStatus } from './runs';
import { sha256Hex } from './upload';

export class DatasetNotFoundError extends Error {
  constructor() {
    super('Dataset revision not found');
    this.name = 'DatasetNotFoundError';
  }
}

export class DatasetRevisionConflictError extends Error {
  constructor(message = 'This dataset revision was already imported with different contents') {
    super(message);
    this.name = 'DatasetRevisionConflictError';
  }
}

export class DatasetStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetStateError';
  }
}

export class DatasetFreezeError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super('The dataset is not ready to freeze');
    this.name = 'DatasetFreezeError';
    this.issues = issues;
  }
}

export type StudyUse = 'pilot' | 'main';

interface RevisionRow {
  id: string;
  dataset_id: string;
  package_revision: string;
  package_digest: string;
  status: 'draft' | 'frozen';
  imported_by: string;
  imported_at: string;
  frozen_by: string | null;
  frozen_at: string | null;
  released_by: string | null;
  released_at: string | null;
  study_protocol_ref: string | null;
}

interface CaseRow {
  id: string;
  revision_id: string;
  case_key: string;
  family_id: string;
  split: DatasetSplit;
  assignment_id: string;
  assignment_version_id: string;
  package_assignment_revision: string | null;
  format: AssignmentFormat;
  pair_targeted_json: string | null;
  authoring_checks_json: string;
}

interface SubmissionRow {
  id: string;
  case_id: string;
  version: 'single' | 'original' | 'corrected';
  source_path: string;
  source: ArrayBuffer;
  source_sha256: string;
  byte_size: number;
  scoring_json: string;
  frozen_run_id: string | null;
}

interface AttemptRow {
  id: string;
  dataset_submission_id: string;
  run_id: string;
  attempt_number: number;
  created_at: string;
  run_status: 'queued' | 'running' | 'complete' | 'incomplete';
  test_count: number;
  resolved_count: number;
  passed_count: number;
}

interface SignoffRow {
  case_id: string;
  user_id: string;
  email: string;
  signed_at: string;
  case_fingerprint: string;
  evidence_note: string;
}

export interface DatasetAttempt {
  id: string;
  runId: string;
  attemptNumber: number;
  createdAt: string;
  runStatus: AttemptRow['run_status'];
  testCount: number;
  resolvedCount: number;
  passedCount: number;
}

export interface DatasetSubmissionDetail {
  id: string;
  version: 'single' | 'original' | 'corrected';
  path: string;
  sha256: string;
  source: string;
  key: ScoringEntry;
  attempts: DatasetAttempt[];
  frozenRunId: string | null;
}

export interface DatasetCaseDetail {
  id: string;
  caseKey: string;
  familyId: string;
  split: DatasetSplit;
  format: AssignmentFormat;
  assignmentId: string;
  assignmentVersionId: string;
  packageAssignmentRevision: string | null;
  assignment: {
    title: string;
    description: string;
    entryPoint: string | null;
    rubric: { id: string; description: string; expectedBehavior: string }[];
    tests: {
      id: string;
      argumentsJson?: string;
      expectedReturnJson?: string;
      stdin?: string;
      expectedStdout?: string;
    }[];
  };
  pairTargetedErrorIds: string[] | null;
  authoringChecks: AuthoringCheck[];
  signoff: {
    userId: string;
    email: string;
    signedAt: string;
    fingerprint: string;
    evidenceNote: string;
  } | null;
  submissions: DatasetSubmissionDetail[];
}

export interface DatasetRevisionDetail {
  id: string;
  datasetId: string;
  packageRevision: string;
  packageDigest: string;
  status: 'draft' | 'frozen';
  importedAt: string;
  importedBy: { id: string; email: string };
  frozenAt: string | null;
  frozenBy: { id: string; email: string } | null;
  releasedAt: string | null;
  releasedBy: { id: string; email: string } | null;
  studyProtocolRef: string | null;
  lockedProtocolRef: string | null;
  cases: DatasetCaseDetail[];
  coverage: DatasetCoverage;
}

export interface DatasetLibraryEntry {
  datasetId: string;
  activeRevisionId: string | null;
  packageRevision: string | null;
  status: 'draft' | 'frozen' | 'missing';
  caseCount: number;
  updatedAt: string;
}

export async function datasetPackageDigest(files: DatasetPackageFiles): Promise<string> {
  const { sources, ...documents } = files;
  const contents = sources === undefined ? documents : {
    ...documents,
    sources: Object.fromEntries(await Promise.all(
      [...sources].map(async ([path, bytes]) => [path, await sha256Hex(bytes)]),
    )),
  };
  return sha256Hex(new TextEncoder().encode(canonicalJson(contents)));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export async function importDatasetPackage(
  db: D1Database,
  parsed: ParsedDatasetPackage,
  files: DatasetPackageFiles,
  userId: string,
  now: string,
): Promise<{ revisionId: string; created: boolean }> {
  const digest = await datasetPackageDigest(files);
  const existing = await db
    .prepare(
      `SELECT id, package_digest FROM dataset_revisions
       WHERE dataset_id = ? AND package_revision = ?`,
    )
    .bind(parsed.datasetId, parsed.revision)
    .first<{ id: string; package_digest: string }>();
  if (existing !== null) {
    if (existing.package_digest !== digest) throw new DatasetRevisionConflictError();
    return { revisionId: existing.id, created: false };
  }

  const revisionId = crypto.randomUUID();
  await assertSplitStability(db, parsed);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO datasets (id, active_revision_id, created_at, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(parsed.datasetId, now, now),
    db
      .prepare(
        `INSERT INTO dataset_revisions
           (id, dataset_id, package_revision, package_digest, status, imported_by, imported_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(revisionId, parsed.datasetId, parsed.revision, digest, userId, now),
  ];

  const snapshots = new Map<string, { assignmentId: string; versionId: string }>();
  for (const assignment of parsed.assignments) {
    const snapshot = assignmentSnapshotStatements(db, assignment.config, userId, now);
    snapshots.set(assignment.id, snapshot);
    statements.push(...snapshot.statements);
  }

  for (const datasetCase of parsed.cases) {
    const caseId = crypto.randomUUID();
    const snapshot = snapshots.get(datasetCase.assignmentId);
    if (snapshot === undefined) {
      throw new DatasetStateError(`Assignment ${datasetCase.assignmentId} was not prepared.`);
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO dataset_cases
             (id, revision_id, case_key, family_id, split, assignment_id,
               assignment_version_id, format, pair_targeted_json, authoring_checks_json,
               package_assignment_id, package_assignment_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          caseId,
          revisionId,
          datasetCase.id,
          datasetCase.familyId,
          datasetCase.split,
          snapshot.assignmentId,
          snapshot.versionId,
          datasetCase.format,
          datasetCase.pair === null ? null : JSON.stringify(datasetCase.pair.targetedErrorIds),
          JSON.stringify(datasetCase.authoringChecks),
          datasetCase.assignmentId,
          datasetCase.assignmentRevision,
        ),
    );
    for (const submission of datasetCase.submissions) {
      const bytes = submission.sourceBytes;
      statements.push(
        db
          .prepare(
            `INSERT INTO dataset_submissions
               (id, case_id, version, source_path, source, source_sha256, byte_size, scoring_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            caseId,
            submission.version,
            submission.path,
            bytes,
            await sha256Hex(bytes),
            bytes.byteLength,
            JSON.stringify(submission.key),
          ),
      );
    }
  }

  statements.push(
    db
      .prepare('UPDATE datasets SET active_revision_id = ?, updated_at = ? WHERE id = ?')
      .bind(revisionId, now, parsed.datasetId),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await db
      .prepare(
        `SELECT id, package_digest FROM dataset_revisions
         WHERE dataset_id = ? AND package_revision = ?`,
      )
      .bind(parsed.datasetId, parsed.revision)
      .first<{ id: string; package_digest: string }>();
    if (raced !== null) {
      if (raced.package_digest !== digest) throw new DatasetRevisionConflictError();
      return { revisionId: raced.id, created: false };
    }
    throw error;
  }

  return { revisionId, created: true };
}

async function assertSplitStability(db: D1Database, parsed: ParsedDatasetPackage): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT c.family_id, c.split, s.source_path
       FROM dataset_cases c
       JOIN dataset_submissions s ON s.case_id = c.id
       JOIN dataset_revisions r ON r.id = c.revision_id
       WHERE r.dataset_id = ? AND r.status = 'frozen'`,
    )
    .bind(parsed.datasetId)
    .all<{ family_id: string; split: DatasetSplit; source_path: string }>();
  if (results.length === 0) return;

  const familySplits = new Map(results.map((row) => [row.family_id, row.split]));
  const sourceSplits = new Map(results.map((row) => [row.source_path, row.split]));
  for (const datasetCase of parsed.cases) {
    const frozenSplit = familySplits.get(datasetCase.familyId);
    if (frozenSplit !== undefined && frozenSplit !== datasetCase.split) {
      throw new DatasetStateError(
        `Family ${datasetCase.familyId} already belongs to the ${frozenSplit} split in a frozen revision.`,
      );
    }
    for (const submission of datasetCase.submissions) {
      const sourceSplit = sourceSplits.get(submission.path);
      if (sourceSplit !== undefined && sourceSplit !== datasetCase.split) {
        throw new DatasetStateError(
          `Source ${submission.path} already belongs to the ${sourceSplit} split in a frozen revision.`,
        );
      }
    }
  }
}

export async function listDatasets(db: D1Database): Promise<DatasetLibraryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id AS dataset_id, d.active_revision_id, d.updated_at,
              r.package_revision, r.status,
              (SELECT COUNT(*) FROM dataset_cases c WHERE c.revision_id = r.id) AS case_count
       FROM datasets d
       LEFT JOIN dataset_revisions r ON r.id = d.active_revision_id
       ORDER BY d.updated_at DESC, d.id ASC`,
    )
    .all<{
      dataset_id: string;
      active_revision_id: string | null;
      updated_at: string;
      package_revision: string | null;
      status: 'draft' | 'frozen' | null;
      case_count: number;
    }>();

  return results.map((row) => ({
    datasetId: row.dataset_id,
    activeRevisionId: row.active_revision_id,
    packageRevision: row.package_revision,
    status: row.status ?? 'missing',
    caseCount: row.case_count,
    updatedAt: row.updated_at,
  }));
}

export async function getDatasetRevision(
  db: D1Database,
  revisionId: string,
): Promise<DatasetRevisionDetail> {
  const revision = await db
    .prepare(
      `SELECT r.*, importer.email AS imported_by_email,
              freezer.email AS frozen_by_email, releaser.email AS released_by_email,
              lock.protocol_ref AS locked_protocol_ref
       FROM dataset_revisions r
       JOIN users importer ON importer.id = r.imported_by
       LEFT JOIN users freezer ON freezer.id = r.frozen_by
       LEFT JOIN users releaser ON releaser.id = r.released_by
       LEFT JOIN dataset_protocol_locks lock ON lock.revision_id = r.id
       WHERE r.id = ?`,
    )
    .bind(revisionId)
    .first<RevisionRow & {
      imported_by_email: string;
      frozen_by_email: string | null;
      released_by_email: string | null;
      locked_protocol_ref: string | null;
    }>();
  if (revision === null) throw new DatasetNotFoundError();

  const { results: caseRows } = await db
    .prepare(
      `SELECT c.*
       FROM dataset_cases c
       WHERE c.revision_id = ?
       ORDER BY c.case_key`,
    )
    .bind(revisionId)
    .all<CaseRow>();
  const { results: submissions } = await db
    .prepare(
      `SELECT s.* FROM dataset_submissions s
       JOIN dataset_cases c ON c.id = s.case_id
       WHERE c.revision_id = ?
       ORDER BY s.case_id, s.version`,
    )
    .bind(revisionId)
    .all<SubmissionRow>();
  const { results: attempts } = await db
    .prepare(
      `SELECT a.id, a.dataset_submission_id, a.run_id, a.attempt_number, a.created_at,
              r.status AS run_status,
              (SELECT COUNT(*) FROM tests t
               WHERE t.test_suite_version_id = r.test_suite_version_id) AS test_count,
              (SELECT COUNT(*) FROM test_results tr
               JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
                 AND t.test_id = tr.test_id
               WHERE tr.run_id = r.id
                 AND tr.status IN (${EXECUTION_TEST_STATUSES.map(() => '?').join(', ')}))
                AS resolved_count,
              (SELECT COUNT(*) FROM test_results tr
               JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
                 AND t.test_id = tr.test_id
               WHERE tr.run_id = r.id AND tr.status = 'pass') AS passed_count
       FROM dataset_attempts a
       JOIN test_runs r ON r.id = a.run_id
       JOIN dataset_submissions s ON s.id = a.dataset_submission_id
       JOIN dataset_cases c ON c.id = s.case_id
       WHERE c.revision_id = ?
       ORDER BY a.attempt_number`,
    )
    .bind(...EXECUTION_TEST_STATUSES, revisionId)
    .all<AttemptRow>();
  const { results: signoffs } = await db
    .prepare(
      `SELECT s.case_id, s.user_id, u.email, s.signed_at, s.case_fingerprint,
              s.evidence_note
       FROM dataset_signoffs s
       JOIN users u ON u.id = s.user_id
       JOIN dataset_cases c ON c.id = s.case_id
       WHERE c.revision_id = ?`,
    )
    .bind(revisionId)
    .all<SignoffRow>();

  const attemptsBySubmission = new Map<string, DatasetAttempt[]>();
  for (const attempt of attempts) {
    const list = attemptsBySubmission.get(attempt.dataset_submission_id) ?? [];
    list.push({
      id: attempt.id,
      runId: attempt.run_id,
      attemptNumber: attempt.attempt_number,
      createdAt: attempt.created_at,
      runStatus: attempt.run_status,
      testCount: attempt.test_count,
      resolvedCount: attempt.resolved_count,
      passedCount: attempt.passed_count,
    });
    attemptsBySubmission.set(attempt.dataset_submission_id, list);
  }
  const signoffByCase = new Map(signoffs.map((signoff) => [signoff.case_id, signoff]));
  const versionIds = [...new Set(caseRows.map((row) => row.assignment_version_id))];
  const versions = new Map(
    await Promise.all(versionIds.map(async (versionId) => {
      const row = caseRows.find((candidate) => candidate.assignment_version_id === versionId)!;
      return [versionId, await getVersion(db, row.assignment_id, versionId)] as const;
    })),
  );

  const cases: DatasetCaseDetail[] = caseRows.map((row) => {
    const signoff = signoffByCase.get(row.id);
    const version = versions.get(row.assignment_version_id)!;
    return {
      id: row.id,
      caseKey: row.case_key,
      familyId: row.family_id,
      split: row.split,
      format: row.format,
      assignmentId: row.assignment_id,
      assignmentVersionId: row.assignment_version_id,
      packageAssignmentRevision: row.package_assignment_revision,
      assignment: {
        title: version.title,
        description: version.description,
        entryPoint: version.format === 'function' ? version.entryPoint : null,
        rubric: version.criteria,
        tests: version.tests,
      },
      pairTargetedErrorIds: row.pair_targeted_json === null
        ? null
        : JSON.parse(row.pair_targeted_json) as string[],
      authoringChecks: JSON.parse(row.authoring_checks_json) as AuthoringCheck[],
      signoff: signoff === undefined
        ? null
        : {
            userId: signoff.user_id,
            email: signoff.email,
            signedAt: signoff.signed_at,
            fingerprint: signoff.case_fingerprint,
            evidenceNote: signoff.evidence_note,
          },
      submissions: submissions
        .filter((submission) => submission.case_id === row.id)
        .map((submission) => ({
          id: submission.id,
          version: submission.version,
          path: submission.source_path,
          sha256: submission.source_sha256,
          source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
            .decode(new Uint8Array(submission.source)),
          key: JSON.parse(submission.scoring_json) as ScoringEntry,
          attempts: attemptsBySubmission.get(submission.id) ?? [],
          frozenRunId: submission.frozen_run_id,
        })),
    };
  });

  return {
    id: revision.id,
    datasetId: revision.dataset_id,
    packageRevision: revision.package_revision,
    packageDigest: revision.package_digest,
    status: revision.status,
    importedAt: revision.imported_at,
    importedBy: { id: revision.imported_by, email: revision.imported_by_email },
    frozenAt: revision.frozen_at,
    frozenBy: revision.frozen_by === null
      ? null
      : { id: revision.frozen_by, email: revision.frozen_by_email ?? '' },
    releasedAt: revision.released_at,
    releasedBy: revision.released_by === null
      ? null
      : { id: revision.released_by, email: revision.released_by_email ?? '' },
    studyProtocolRef: revision.study_protocol_ref,
    lockedProtocolRef: revision.locked_protocol_ref,
    cases,
    coverage: coverageForCases(cases),
  };
}

export async function recordDatasetSignoff(
  db: D1Database,
  revisionId: string,
  caseKey: string,
  userId: string,
  evidenceNote: string,
  now: string,
): Promise<void> {
  if (evidenceNote.trim() === '') {
    throw new DatasetStateError('Describe the evidence you checked before signing off.');
  }
  const revision = await db
    .prepare('SELECT status FROM dataset_revisions WHERE id = ?')
    .bind(revisionId)
    .first<{ status: 'draft' | 'frozen' }>();
  if (revision === null) throw new DatasetNotFoundError();
  if (revision.status !== 'draft') {
    throw new DatasetStateError('A frozen revision cannot receive new sign-offs.');
  }
  const detail = await getDatasetRevision(db, revisionId);
  const datasetCase = detail.cases.find((value) => value.caseKey === caseKey);
  if (datasetCase === undefined) throw new DatasetNotFoundError();
  const fingerprint = await caseFingerprint(datasetCase);

  const result = await db
    .prepare(
      `INSERT INTO dataset_signoffs
         (id, case_id, user_id, signed_at, case_fingerprint, evidence_note)
       SELECT ?, c.id, ?, ?, ?, ?
       FROM dataset_cases c
       JOIN dataset_revisions r ON r.id = c.revision_id
       WHERE c.id = ? AND r.status = 'draft'
       ON CONFLICT(case_id) DO UPDATE SET
         user_id = excluded.user_id,
         signed_at = excluded.signed_at,
         case_fingerprint = excluded.case_fingerprint,
         evidence_note = excluded.evidence_note`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      now,
      fingerprint,
      evidenceNote.trim(),
      datasetCase.id,
    )
    .run();
  if (result.meta.changes === 0) {
    throw new DatasetStateError('A frozen revision cannot receive new sign-offs.');
  }
}

async function caseFingerprint(datasetCase: DatasetCaseDetail): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    caseKey: datasetCase.caseKey,
    familyId: datasetCase.familyId,
    split: datasetCase.split,
    assignmentVersionId: datasetCase.assignmentVersionId,
    format: datasetCase.format,
    pairTargetedErrorIds: datasetCase.pairTargetedErrorIds,
    authoringChecks: datasetCase.authoringChecks,
    submissions: datasetCase.submissions.map((submission) => ({
      version: submission.version,
      path: submission.path,
      sha256: submission.sha256,
      key: submission.key,
    })),
  })));
}

export interface LaunchedEvidence {
  attemptId: string;
  runId: string;
  submissionId: string;
}

export async function launchDatasetRun(
  db: D1Database,
  revisionId: string,
  datasetSubmissionId: string,
  userId: string,
  now: string,
): Promise<LaunchedEvidence> {
  const submissionRecordId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO submission_versions
           (id, assignment_id, assignment_version_id, rubric_version_id,
            test_suite_version_id, source, source_sha256, byte_size, created_by, created_at)
         SELECT ?, c.assignment_id, c.assignment_version_id, v.rubric_version_id,
                v.test_suite_version_id, s.source, s.source_sha256, s.byte_size, ?, ?
         FROM dataset_submissions s
         JOIN dataset_cases c ON c.id = s.case_id
         JOIN dataset_revisions r ON r.id = c.revision_id
         JOIN assignment_versions v ON v.id = c.assignment_version_id AND v.assignment_id = c.assignment_id
         WHERE s.id = ? AND r.id = ? AND r.status = 'draft'
           AND NOT EXISTS (
             SELECT 1 FROM dataset_attempts a
             JOIN test_runs tr ON tr.id = a.run_id
             WHERE a.dataset_submission_id = s.id
               AND tr.status IN ('queued', 'running', 'complete')
           )`,
      )
      .bind(submissionRecordId, userId, now, datasetSubmissionId, revisionId),
    ...submissionRunStatements(db, {
      runId,
      submissionId: submissionRecordId,
      userId,
      now,
      requireActive: false,
    }),
    db
      .prepare(
        `INSERT INTO dataset_attempts
           (id, dataset_submission_id, submission_id, run_id, attempt_number, created_by, created_at)
         SELECT ?, s.id, tr.submission_id, tr.id, (SELECT COALESCE(MAX(attempt_number), 0) + 1
                                  FROM dataset_attempts WHERE dataset_submission_id = s.id),
                ?, ?
         FROM dataset_submissions s
         JOIN test_runs tr ON tr.id = ?
         WHERE s.id = ?`,
       )
      .bind(attemptId, userId, now, runId, datasetSubmissionId),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new DatasetStateError(
      'Only a submission in a draft with no active or completed study run can be launched.',
    );
  }
  return { attemptId, runId, submissionId: submissionRecordId };
}

export async function freezeDataset(
  db: D1Database,
  revisionId: string,
  userId: string,
  now: string,
): Promise<DatasetRevisionDetail> {
  const detail = await getDatasetRevision(db, revisionId);
  if (detail.status !== 'draft') {
    throw new DatasetStateError('This revision is already frozen.');
  }
  const issues = await freezeIssues(detail);
  if (issues.length > 0) throw new DatasetFreezeError(issues);

  // Package inputs are immutable and a completed run cannot be replaced.
  // Every pin and the publish step check the draft state in the same batch.
  const statements: D1PreparedStatement[] = [];
  for (const datasetCase of detail.cases) {
    for (const submission of datasetCase.submissions) {
      const usable = usableAttempt(submission);
      if (usable === null) continue;
      statements.push(
        db
          .prepare(
            `UPDATE dataset_submissions SET frozen_run_id = ?
             WHERE id = ? AND EXISTS (
               SELECT 1 FROM dataset_revisions WHERE id = ? AND status = 'draft'
             )`,
          )
          .bind(usable.runId, submission.id, revisionId),
      );
    }
  }
  statements.push(db.prepare(
    `UPDATE dataset_revisions
     SET status = 'frozen', frozen_by = ?, frozen_at = ?
     WHERE id = ? AND status = 'draft'`,
  ).bind(userId, now, revisionId));
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('dataset_split_conflict')) {
      throw new DatasetFreezeError(['A family or source in this draft belongs to the other split in an earlier freeze.']);
    }
    throw error;
  }
  if (results.at(-1)?.meta.changes === 0) {
    throw new DatasetStateError('The revision changed before it was frozen.');
  }
  return getDatasetRevision(db, revisionId);
}

function usableAttempt(submission: DatasetSubmissionDetail): DatasetAttempt | null {
  for (let index = submission.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = submission.attempts[index]!;
    if (
      attempt.runStatus === 'complete'
      && attempt.testCount > 0
      && attempt.resolvedCount === attempt.testCount
    ) {
      return attempt;
    }
  }
  return null;
}

async function freezeIssues(detail: DatasetRevisionDetail): Promise<string[]> {
  const issues: string[] = [];
  for (const [split, formats] of Object.entries(detail.coverage) as [
    DatasetSplit,
    DatasetCoverage[DatasetSplit],
  ][]) {
    for (const format of ['function', 'script'] as AssignmentFormat[]) {
      const cell = formats[format];
      if (cell.clean < 1) issues.push(`${split}/${format}: add a clean single case.`);
      if (cell.fixed < 1) issues.push(`${split}/${format}: add a pair whose targeted fix leaves it clean.`);
      if (cell.partial < 1) issues.push(`${split}/${format}: add a pair with a remaining unrelated error.`);
    }
  }

  const allTestsPassBuggyCells = new Set<string>();
  for (const datasetCase of detail.cases) {
    if (datasetCase.signoff === null) {
      issues.push(`${datasetCase.caseKey}: a researcher must verify and sign off before freeze.`);
    } else {
      const fingerprint = await caseFingerprint(datasetCase);
      if (fingerprint !== datasetCase.signoff.fingerprint) {
        issues.push(`${datasetCase.caseKey}: the case changed after sign-off; verify it again.`);
      }
    }

    for (const submission of datasetCase.submissions) {
      const label = `${datasetCase.caseKey}/${submission.version}`;
      if (submission.attempts.length === 0) {
        issues.push(`${label}: record a study run before freeze.`);
        continue;
      }
      if (submission.attempts.some((attempt) => attempt.runStatus === 'queued' || attempt.runStatus === 'running')) {
        issues.push(`${label}: wait for the current study run to finish.`);
        continue;
      }
      const usable = usableAttempt(submission);
      if (usable === null) {
        issues.push(`${label}: a completed run with an outcome for every test is required.`);
        continue;
      }
      if (submission.key.clean && usable.passedCount !== usable.testCount) {
        issues.push(`${label}: a clean submission must pass every supplied study test.`);
      }
      if (usable.passedCount === usable.testCount
        && submission.key.errors.some((error) => error.evidence.some((item) => item.kind === 'source'))) {
        allTestsPassBuggyCells.add(`${datasetCase.split}/${datasetCase.format}`);
      }
    }
  }

  for (const split of ['development', 'held_out'] as DatasetSplit[]) {
    for (const format of ['function', 'script'] as AssignmentFormat[]) {
      if (!allTestsPassBuggyCells.has(`${split}/${format}`)) {
        issues.push(
          `${split}/${format}: include a source-evident error in a submission that passes every supplied study test.`,
        );
      }
    }
  }
  return issues;
}

export async function releaseDataset(
  db: D1Database,
  revisionId: string,
  userId: string,
  studyProtocolRef: string,
  now: string,
): Promise<void> {
  if (studyProtocolRef.trim() === '') {
    throw new DatasetStateError('Reference the frozen study protocol before releasing held-out cases.');
  }
  const result = await db
    .prepare(
      `UPDATE dataset_revisions
       SET released_by = ?, released_at = ?, study_protocol_ref = ?
       WHERE id = ? AND status = 'frozen' AND released_at IS NULL
         AND EXISTS (
           SELECT 1 FROM dataset_protocol_locks
           WHERE revision_id = dataset_revisions.id AND protocol_ref = ?
         )`,
    )
    .bind(userId, now, studyProtocolRef.trim(), revisionId, studyProtocolRef.trim())
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new DatasetStateError('Release requires a frozen, unreleased revision and its locked study protocol.');
  }
}

async function studySplit(
  db: D1Database,
  revisionId: string,
  use: StudyUse,
): Promise<DatasetSplit> {
  const revision = await db
    .prepare(
      `SELECT r.status, (r.released_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM dataset_protocol_locks l
         WHERE l.revision_id = r.id AND l.protocol_ref = r.study_protocol_ref
       )) AS has_valid_release
       FROM dataset_revisions r WHERE r.id = ?`,
    )
    .bind(revisionId)
    .first<{ status: 'draft' | 'frozen'; has_valid_release: number }>();
  if (revision === null || revision.status !== 'frozen') throw new DatasetNotFoundError();
  if (use === 'pilot') return 'development';
  if (use === 'main' && revision.has_valid_release === 1) return 'held_out';
  throw new DatasetNotFoundError();
}

export interface StudyCaseSummary {
  caseKey: string;
  format: AssignmentFormat;
  submissionIds: string[];
}

export async function listStudyCases(
  db: D1Database,
  revisionId: string,
  use: StudyUse,
): Promise<StudyCaseSummary[]> {
  const split = await studySplit(db, revisionId, use);
  const { results } = await db
    .prepare(
      `SELECT c.case_key, c.format, s.id
       FROM dataset_cases c
       JOIN dataset_submissions s ON s.case_id = c.id
       WHERE c.revision_id = ? AND c.split = ?
       ORDER BY c.case_key, s.version`,
    )
    .bind(revisionId, split)
    .all<{ case_key: string; format: AssignmentFormat; id: string }>();

  const cases = new Map<string, StudyCaseSummary>();
  for (const row of results) {
    const existing = cases.get(row.case_key) ?? {
      caseKey: row.case_key,
      format: row.format,
      submissionIds: [],
    };
    existing.submissionIds.push(row.id);
    cases.set(row.case_key, existing);
  }
  return [...cases.values()];
}

export interface StudyEvidence {
  format: AssignmentFormat;
  assignment: {
    title: string;
    description: string;
    entryPoint: string | null;
    rubric: { id: string; description: string; expectedBehavior: string }[];
  };
  submission: {
    source: string;
    tests: {
      id: string;
      argumentsJson: string | null;
      expectedReturnJson: string | null;
      stdin: string | null;
      expectedStdout: string | null;
      status: ExecutionTestStatus;
      actualJson: string | null;
      stdout: string | null;
      stderr: string;
      diagnostic: string | null;
    }[];
  };
}

export async function getStudyEvidence(
  db: D1Database,
  revisionId: string,
  use: StudyUse,
  datasetSubmissionId: string,
): Promise<StudyEvidence> {
  const split = await studySplit(db, revisionId, use);
  const row = await db
    .prepare(
      `SELECT s.id, s.source, s.frozen_run_id, c.case_key, c.split, c.format,
              c.assignment_id, c.assignment_version_id
       FROM dataset_submissions s
       JOIN dataset_cases c ON c.id = s.case_id
       WHERE s.id = ? AND c.revision_id = ?`,
    )
    .bind(datasetSubmissionId, revisionId)
    .first<{
      id: string;
      source: ArrayBuffer;
      frozen_run_id: string | null;
      case_key: string;
      split: DatasetSplit;
      format: AssignmentFormat;
      assignment_id: string;
      assignment_version_id: string;
    }>();
  if (row === null || row.split !== split || row.frozen_run_id === null) {
    throw new DatasetNotFoundError();
  }
  const version = await getVersion(db, row.assignment_id, row.assignment_version_id);

  const { results: resultsRows } = await db
    .prepare(
      `SELECT t.test_id, t.arguments_json, t.expected_return_json, t.stdin, t.expected_stdout,
              tr.status, tr.actual_json, tr.stdout, tr.stderr, tr.diagnostic
       FROM test_runs r
       JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
       JOIN test_results tr ON tr.run_id = r.id AND tr.test_id = t.test_id
       WHERE r.id = ?
       ORDER BY t.position`,
    )
    .bind(row.frozen_run_id)
    .all<{
      test_id: string;
      arguments_json: string | null;
      expected_return_json: string | null;
      stdin: string | null;
      expected_stdout: string | null;
      status: ExecutionTestStatus;
      actual_json: string | null;
      stdout: string | null;
      stderr: string | null;
      diagnostic: string | null;
    }>();

  return {
    format: row.format,
    assignment: {
      title: version.title,
      description: version.description,
      entryPoint: version.format === 'function' ? version.entryPoint : null,
      rubric: version.criteria,
    },
    submission: {
      source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        new Uint8Array(row.source),
      ),
      tests: resultsRows.map((test) => ({
        id: test.test_id,
        argumentsJson: test.arguments_json,
        expectedReturnJson: test.expected_return_json,
        stdin: test.stdin,
        expectedStdout: test.expected_stdout,
        status: test.status,
        actualJson: test.actual_json,
        stdout: test.stdout,
        stderr: test.stderr ?? '',
        diagnostic: test.diagnostic,
      })),
    },
  };
}

export interface ScoringRead {
  revisionId: string;
  caseKey: string;
  targetedErrorIds: string[] | null;
  submissions: {
    submissionId: string;
    version: 'single' | 'original' | 'corrected';
    key: ScoringEntry;
  }[];
}

export async function getScoringRead(
  db: D1Database,
  revisionId: string,
  use: StudyUse,
  caseKey: string,
): Promise<ScoringRead> {
  const split = await studySplit(db, revisionId, use);
  const { results } = await db
    .prepare(
      `SELECT c.case_key, c.split, c.pair_targeted_json, s.id, s.version, s.scoring_json
       FROM dataset_cases c
       JOIN dataset_submissions s ON s.case_id = c.id
       WHERE c.revision_id = ? AND c.case_key = ?
       ORDER BY s.version`,
    )
    .bind(revisionId, caseKey)
    .all<{
      case_key: string;
      split: DatasetSplit;
      pair_targeted_json: string | null;
      id: string;
      version: 'single' | 'original' | 'corrected';
      scoring_json: string;
    }>();
  if (results.length === 0 || results[0]!.split !== split) throw new DatasetNotFoundError();
  return {
    revisionId,
    caseKey: results[0]!.case_key,
    targetedErrorIds: results[0]!.pair_targeted_json === null
      ? null
      : JSON.parse(results[0]!.pair_targeted_json) as string[],
    submissions: results.map((row) => ({
      submissionId: row.id,
      version: row.version,
      key: JSON.parse(row.scoring_json) as ScoringEntry,
    })),
  };
}
