import { COMPARISON_RULE } from './config';

export const MAX_SOURCE_BYTES = 64 * 1024;
export const PYTHON_RELEASE = '3.12.11';
export const RUNNER_ARTIFACT = 'native-python-runner/1';

export interface RunLimits {
  executionMs: number;
  memoryMiB: number;
  outputBytes: number;
}

export const RUN_LIMITS: RunLimits = {
  executionMs: 2000,
  memoryMiB: 128,
  outputBytes: 16384,
};

export const QUEUED_TIMEOUT_MS = 2 * 60 * 1000;
export const RUNNING_TIMEOUT_MS = 15 * 60 * 1000;

export type RunStatus = 'queued' | 'running' | 'complete' | 'incomplete';

export type TestStatus =
  | 'pending'
  | 'running'
  | 'pass'
  | 'mismatch'
  | 'execution_error'
  | 'timed_out'
  | 'memory_limit'
  | 'output_limit'
  | 'infrastructure_failure'
  | 'not_run';

export const EXECUTION_OUTCOMES: ReadonlySet<TestStatus> = new Set([
  'pass',
  'mismatch',
  'execution_error',
  'timed_out',
  'memory_limit',
  'output_limit',
]);

export class StaleLaunchError extends Error {
  constructor() {
    super('The assignment version is no longer active');
    this.name = 'StaleLaunchError';
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super('Test run not found');
    this.name = 'RunNotFoundError';
  }
}

export interface CreatedRun {
  runId: string;
  submissionId: string;
}

export interface LaunchSubmission {
  assignmentId: string;
  assignmentVersionId: string;
  source: Uint8Array;
  sourceSha256: string;
  userId: string;
  now: string;
}

/**
 * Creates the submission, test run, and pending per-test records only when the
 * requested version is still the assignment's active version. The D1 batch is
 * one transaction; a stale request inserts zero rows and is reported as such.
 */
export async function createSubmissionRun(
  db: D1Database,
  launch: LaunchSubmission,
): Promise<CreatedRun> {
  const submissionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO submission_versions
           (id, assignment_id, assignment_version_id, rubric_version_id,
            test_suite_version_id, source, source_sha256, byte_size, created_by, created_at)
         SELECT ?, a.id, v.id, v.rubric_version_id, v.test_suite_version_id, ?, ?, ?, ?, ?
         FROM assignments a
         JOIN assignment_versions v ON v.id = a.active_version_id
         WHERE a.id = ? AND v.id = ?`,
      )
      .bind(
        submissionId,
        launch.source,
        launch.sourceSha256,
        launch.source.byteLength,
        launch.userId,
        launch.now,
        launch.assignmentId,
        launch.assignmentVersionId,
      ),
    db
      .prepare(
        `INSERT INTO test_runs
           (id, submission_id, assignment_id, assignment_version_id, rubric_version_id,
            test_suite_version_id, comparison_rule, python_release, runner_artifact,
            limits_json, status, queued_at, created_by)
         SELECT ?, s.id, s.assignment_id, s.assignment_version_id, s.rubric_version_id,
                s.test_suite_version_id, ?, ?, ?, ?, 'queued', ?, ?
         FROM submission_versions s
         JOIN assignments a ON a.id = s.assignment_id
         WHERE s.id = ? AND a.active_version_id = s.assignment_version_id`,
      )
      .bind(
        runId,
        COMPARISON_RULE,
        PYTHON_RELEASE,
        RUNNER_ARTIFACT,
        JSON.stringify(RUN_LIMITS),
        launch.now,
        launch.userId,
        submissionId,
      ),
    db
      .prepare(
        `INSERT INTO test_results (run_id, test_id, position, status)
         SELECT r.id, t.test_id, t.position, 'pending'
         FROM test_runs r
         JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
         WHERE r.id = ?`,
      )
      .bind(runId),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new StaleLaunchError();
  }
  return { runId, submissionId };
}

export interface RunTestSummary {
  id: string;
  position: number;
  argumentsJson: string;
  expectedReturnJson: string;
  status: TestStatus;
  startedAt: string | null;
  finishedAt: string | null;
  executionMs: number | null;
  startupMs: number | null;
  runnerWarm: boolean | null;
  outputTruncated: boolean;
  diagnostic: string | null;
}

export interface RunTestEvidence extends RunTestSummary {
  actualJson: string | null;
  stdout: string;
  stderr: string;
}

export interface TestRunDetail {
  id: string;
  submissionId: string;
  assignmentId: string;
  assignmentVersionId: string;
  assignmentVersionNumber: number;
  title: string;
  entryPoint: string;
  rubricVersionId: string;
  testSuiteVersionId: string;
  comparisonRule: string;
  pythonRelease: string;
  runnerArtifact: string;
  limits: RunLimits;
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  incompleteReason: string | null;
  source: Uint8Array;
  tests: RunTestSummary[];
}

interface RunRow {
  id: string;
  submission_id: string;
  assignment_id: string;
  assignment_version_id: string;
  assignment_version_number: number;
  title: string;
  entry_point: string;
  rubric_version_id: string;
  test_suite_version_id: string;
  comparison_rule: string;
  python_release: string;
  runner_artifact: string;
  limits_json: string;
  status: RunStatus;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  incomplete_reason: string | null;
  source: ArrayBuffer;
}

interface ResultRow {
  test_id: string;
  position: number;
  arguments_json: string;
  expected_return_json: string;
  status: TestStatus;
  started_at: string | null;
  finished_at: string | null;
  execution_ms: number | null;
  startup_ms: number | null;
  runner_warm: number | null;
  output_truncated: number;
  diagnostic: string | null;
}

interface EvidenceRow extends ResultRow {
  actual_json: string | null;
  stdout: string | null;
  stderr: string | null;
}

export async function getTestRun(db: D1Database, runId: string): Promise<TestRunDetail> {
  const run = await db
    .prepare(
      `SELECT r.id, r.submission_id, r.assignment_id, r.assignment_version_id,
              v.version_number AS assignment_version_number, v.title, v.entry_point,
              r.rubric_version_id, r.test_suite_version_id, r.comparison_rule,
              r.python_release, r.runner_artifact, r.limits_json, r.status,
              r.queued_at, r.started_at, r.finished_at, r.incomplete_reason,
              s.source
       FROM test_runs r
       JOIN submission_versions s ON s.id = r.submission_id
       JOIN assignment_versions v ON v.id = r.assignment_version_id
       WHERE r.id = ?`,
    )
    .bind(runId)
    .first<RunRow>();
  if (run === null) throw new RunNotFoundError();

  const { results } = await db
    .prepare(
      `SELECT t.test_id, t.position, t.arguments_json, t.expected_return_json,
              tr.status, tr.started_at, tr.finished_at, tr.execution_ms, tr.startup_ms,
              tr.runner_warm, tr.output_truncated, tr.diagnostic
       FROM test_runs r
       JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
       JOIN test_results tr ON tr.run_id = r.id AND tr.test_id = t.test_id
       WHERE r.id = ?
       ORDER BY t.position`,
    )
    .bind(runId)
    .all<ResultRow>();

  return {
    id: run.id,
    submissionId: run.submission_id,
    assignmentId: run.assignment_id,
    assignmentVersionId: run.assignment_version_id,
    assignmentVersionNumber: run.assignment_version_number,
    title: run.title,
    entryPoint: run.entry_point,
    rubricVersionId: run.rubric_version_id,
    testSuiteVersionId: run.test_suite_version_id,
    comparisonRule: run.comparison_rule,
    pythonRelease: run.python_release,
    runnerArtifact: run.runner_artifact,
    limits: JSON.parse(run.limits_json) as RunLimits,
    status: run.status,
    queuedAt: run.queued_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    incompleteReason: run.incomplete_reason,
    source: new Uint8Array(run.source),
    tests: results.map((row) => ({
      id: row.test_id,
      position: row.position,
      argumentsJson: row.arguments_json,
      expectedReturnJson: row.expected_return_json,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      executionMs: row.execution_ms,
      startupMs: row.startup_ms,
      runnerWarm: row.runner_warm === null ? null : row.runner_warm === 1,
      outputTruncated: row.output_truncated === 1,
      diagnostic: row.diagnostic,
    })),
  };
}

export async function getRunTestEvidence(
  db: D1Database,
  runId: string,
  testId: string,
): Promise<RunTestEvidence | null> {
  const row = await db
    .prepare(
      `SELECT t.test_id, t.position, t.arguments_json, t.expected_return_json,
              tr.status, tr.started_at, tr.finished_at, tr.execution_ms, tr.startup_ms,
              tr.runner_warm, tr.output_truncated, tr.diagnostic,
              tr.actual_json, tr.stdout, tr.stderr
       FROM test_runs r
       JOIN tests t ON t.test_suite_version_id = r.test_suite_version_id
       JOIN test_results tr ON tr.run_id = r.id AND tr.test_id = t.test_id
       WHERE r.id = ? AND t.test_id = ?`,
    )
    .bind(runId, testId)
    .first<EvidenceRow>();
  if (row === null) return null;
  return {
    id: row.test_id,
    position: row.position,
    argumentsJson: row.arguments_json,
    expectedReturnJson: row.expected_return_json,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    executionMs: row.execution_ms,
    startupMs: row.startup_ms,
    runnerWarm: row.runner_warm === null ? null : row.runner_warm === 1,
    outputTruncated: row.output_truncated === 1,
    diagnostic: row.diagnostic,
    actualJson: row.actual_json,
    stdout: row.stdout ?? '',
    stderr: row.stderr ?? '',
  };
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  queuedAt: string;
  finishedAt: string | null;
  sourceBytes: number;
  passedCount: number;
  testCount: number;
}

export async function listRunsForVersion(
  db: D1Database,
  assignmentVersionId: string,
  limit = 10,
): Promise<RunSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.status, r.queued_at, r.finished_at, s.byte_size AS source_bytes,
              (SELECT COUNT(*) FROM test_results tr
                WHERE tr.run_id = r.id AND tr.status = 'pass') AS passed_count,
              (SELECT COUNT(*) FROM test_results tr
                WHERE tr.run_id = r.id) AS test_count
       FROM test_runs r
       JOIN submission_versions s ON s.id = r.submission_id
       WHERE r.assignment_version_id = ?
       ORDER BY r.queued_at DESC
       LIMIT ?`,
    )
    .bind(assignmentVersionId, limit)
    .all<{
      id: string;
      status: RunStatus;
      queued_at: string;
      finished_at: string | null;
      source_bytes: number;
      passed_count: number;
      test_count: number;
    }>();

  return results.map((row) => ({
    id: row.id,
    status: row.status,
    queuedAt: row.queued_at,
    finishedAt: row.finished_at,
    sourceBytes: row.source_bytes,
    passedCount: row.passed_count,
    testCount: row.test_count,
  }));
}

export async function claimRun(
  db: D1Database,
  runId: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE test_runs SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status = 'queued'`,
    )
    .bind(now, runId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markTestRunning(
  db: D1Database,
  runId: string,
  testId: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE test_results SET status = 'running', started_at = ?
       WHERE run_id = ? AND test_id = ? AND status = 'pending'
         AND EXISTS (SELECT 1 FROM test_runs WHERE id = ? AND status = 'running')`,
    )
    .bind(now, runId, testId, runId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface RecordedResult {
  status: Exclude<TestStatus, 'pending' | 'running' | 'not_run'>;
  actualJson: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostic: string | null;
  executionMs: number | null;
  startupMs: number | null;
  runnerWarm: boolean | null;
  now: string;
}

export async function recordTestResult(
  db: D1Database,
  runId: string,
  testId: string,
  result: RecordedResult,
): Promise<boolean> {
  const update = await db
    .prepare(
      `UPDATE test_results
       SET status = ?, finished_at = ?, execution_ms = ?, startup_ms = ?,
           runner_warm = ?, actual_json = ?, stdout = ?, stderr = ?,
           output_truncated = ?, diagnostic = ?
       WHERE run_id = ? AND test_id = ? AND status = 'running'`,
    )
    .bind(
      result.status,
      result.now,
      result.executionMs,
      result.startupMs,
      result.runnerWarm === null ? null : result.runnerWarm ? 1 : 0,
      result.actualJson,
      result.stdout,
      result.stderr,
      result.outputTruncated ? 1 : 0,
      result.diagnostic,
      runId,
      testId,
    )
    .run();
  return (update.meta.changes ?? 0) > 0;
}

/**
 * Finalizes a run once every test has a terminal record. A run is complete when
 * every configured test has an execution outcome, even if some tests failed.
 */
export async function finalizeRunIfDone(
  db: D1Database,
  runId: string,
  now: string,
): Promise<RunStatus | null> {
  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status IN ('infrastructure_failure', 'not_run') THEN 1 ELSE 0 END)
           AS incomplete_count
       FROM test_results WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{ open_count: number | null; incomplete_count: number | null }>();
  if (counts === null || (counts.open_count ?? 0) > 0) return null;

  const status: RunStatus = (counts.incomplete_count ?? 0) > 0 ? 'incomplete' : 'complete';
  const result = await db
    .prepare(
      `UPDATE test_runs SET status = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(status, now, runId)
    .run();
  return (result.meta.changes ?? 0) > 0 ? status : null;
}

export async function markRunIncomplete(
  db: D1Database,
  runId: string,
  reason: string,
  now: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE test_results
         SET status = 'infrastructure_failure', finished_at = ?,
             diagnostic = COALESCE(diagnostic, ?)
         WHERE run_id = ? AND status = 'running'
           AND EXISTS (SELECT 1 FROM test_runs WHERE id = ? AND status IN ('queued', 'running'))`,
      )
      .bind(now, reason, runId, runId),
    db
      .prepare(
        `UPDATE test_results
         SET status = 'not_run', finished_at = ?, diagnostic = COALESCE(diagnostic, ?)
         WHERE run_id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM test_runs WHERE id = ? AND status IN ('queued', 'running'))`,
      )
      .bind(now, reason, runId, runId),
    db
      .prepare(
        `UPDATE test_runs SET status = 'incomplete', finished_at = ?, incomplete_reason = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .bind(now, reason, runId),
  ]);
}

export async function reconcileRuns(
  db: D1Database,
  now: Date,
): Promise<string[]> {
  const queuedBefore = new Date(now.getTime() - QUEUED_TIMEOUT_MS).toISOString();
  const runningBefore = new Date(now.getTime() - RUNNING_TIMEOUT_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, status FROM test_runs
       WHERE (status = 'queued' AND queued_at < ?)
          OR (status = 'running' AND started_at < ?)
       ORDER BY queued_at
       LIMIT 50`,
    )
    .bind(queuedBefore, runningBefore)
    .all<{ id: string; status: 'queued' | 'running' }>();

  const reconciled: string[] = [];
  for (const row of results) {
    if (row.status === 'running') {
      const finalized = await finalizeRunIfDone(db, row.id, now.toISOString());
      if (finalized !== null) continue;
    }
    await markRunIncomplete(
      db,
      row.id,
      row.status === 'queued'
        ? 'The test run was not dispatched before its deadline.'
        : 'The test run did not finish before its deadline.',
      now.toISOString(),
    );
    reconciled.push(row.id);
  }
  return reconciled;
}
