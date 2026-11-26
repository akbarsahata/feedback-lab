import {
  COMPARISON_RULE,
  SCRIPT_COMPARISON_RULE,
  compareConfigs,
  isChanged,
  type AssignmentFormat,
  type FunctionConfig,
  type FunctionTestCase,
  type RawCriterion,
  type ScriptConfig,
  type ScriptTestCase,
  type TestCase,
  type ValidatedConfig,
} from './config';

export class AssignmentNotFoundError extends Error {
  constructor() {
    super('Assignment not found');
    this.name = 'AssignmentNotFoundError';
  }
}

export class StaleVersionError extends Error {
  readonly currentVersionId: string;

  constructor(currentVersionId: string) {
    super('The assignment has a newer active version');
    this.name = 'StaleVersionError';
    this.currentVersionId = currentVersionId;
  }
}

export interface AssignmentSummary {
  id: string;
  activeVersionId: string;
  versionNumber: number;
  title: string;
  format: AssignmentFormat;
  criteriaCount: number;
  testsCount: number;
  updatedAt: string;
}

interface VersionIdentity {
  id: string;
  assignmentId: string;
  versionNumber: number;
  rubricVersionId: string;
  testSuiteVersionId: string;
}

interface AssignmentVersionBase extends VersionIdentity {
  title: string;
  description: string;
  criteria: RawCriterion[];
  createdAt: string;
  createdBy: { id: string; email: string };
}

export type AssignmentVersionDetail =
  | (AssignmentVersionBase & {
      format: 'function';
      entryPoint: string;
      tests: FunctionTestCase[];
    })
  | (AssignmentVersionBase & {
      format: 'script';
      tests: ScriptTestCase[];
    });

export interface AssignmentVersionSummary {
  id: string;
  versionNumber: number;
  title: string;
  createdAt: string;
  createdBy: { id: string; email: string };
  isActive: boolean;
}

interface VersionRow {
  id: string;
  assignment_id: string;
  version_number: number;
  title: string;
  description: string;
  format: AssignmentFormat;
  entry_point: string | null;
  rubric_version_id: string;
  test_suite_version_id: string;
  created_at: string;
  created_by: string;
  created_by_email: string;
}

export interface StoredTestRow {
  test_id: string;
  arguments_json: string | null;
  expected_return_json: string | null;
  stdin: string | null;
  expected_stdout: string | null;
  comparison_rule: TestCase['comparisonRule'];
}

export function readStoredTest(row: StoredTestRow): TestCase | null {
  if (row.comparison_rule === COMPARISON_RULE && row.arguments_json !== null
    && row.expected_return_json !== null) {
    return {
      id: row.test_id,
      argumentsJson: row.arguments_json,
      expectedReturnJson: row.expected_return_json,
      comparisonRule: row.comparison_rule,
    };
  }
  if (row.comparison_rule === SCRIPT_COMPARISON_RULE && row.stdin !== null
    && row.expected_stdout !== null) {
    return {
      id: row.test_id,
      stdin: row.stdin,
      expectedStdout: row.expected_stdout,
      comparisonRule: row.comparison_rule,
    };
  }
  return null;
}

export async function listAssignments(db: D1Database): Promise<AssignmentSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id,
              a.active_version_id AS active_version_id,
              a.updated_at AS updated_at,
              v.version_number AS version_number,
              v.title AS title,
              v.format AS format,
              (SELECT COUNT(*) FROM rubric_criteria rc
                WHERE rc.rubric_version_id = v.rubric_version_id) AS criteria_count,
              (SELECT COUNT(*) FROM tests t
                WHERE t.test_suite_version_id = v.test_suite_version_id) AS tests_count
       FROM assignments a
       JOIN assignment_versions v ON v.id = a.active_version_id
       ORDER BY a.updated_at DESC, a.id ASC`,
    )
    .all<{
      id: string;
      active_version_id: string;
      updated_at: string;
      version_number: number;
      title: string;
      format: AssignmentFormat;
      criteria_count: number;
      tests_count: number;
    }>();

  return results.map((row) => ({
    id: row.id,
    activeVersionId: row.active_version_id,
    versionNumber: row.version_number,
    title: row.title,
    format: row.format,
    criteriaCount: row.criteria_count,
    testsCount: row.tests_count,
    updatedAt: row.updated_at,
  }));
}

export async function getActiveVersion(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentVersionDetail> {
  const row = await db
    .prepare(
      `SELECT v.*, u.email AS created_by_email
       FROM assignments a
       JOIN assignment_versions v ON v.id = a.active_version_id
       JOIN users u ON u.id = v.created_by
       WHERE a.id = ?`,
    )
    .bind(assignmentId)
    .first<VersionRow>();

  if (row === null) {
    throw new AssignmentNotFoundError();
  }
  return loadVersionDetail(db, row);
}

export async function getVersion(
  db: D1Database,
  assignmentId: string,
  versionId: string,
): Promise<AssignmentVersionDetail> {
  const row = await db
    .prepare(
      `SELECT v.*, u.email AS created_by_email
       FROM assignment_versions v
       JOIN users u ON u.id = v.created_by
       WHERE v.assignment_id = ? AND v.id = ?`,
    )
    .bind(assignmentId, versionId)
    .first<VersionRow>();

  if (row === null) {
    throw new AssignmentNotFoundError();
  }
  return loadVersionDetail(db, row);
}

export async function listVersions(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentVersionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.version_number, v.title, v.created_at, u.id AS user_id, u.email,
              (v.id = a.active_version_id) AS is_active
       FROM assignments a
       JOIN assignment_versions v ON v.assignment_id = a.id
       JOIN users u ON u.id = v.created_by
       WHERE a.id = ?
       ORDER BY v.version_number DESC`,
    )
    .bind(assignmentId)
    .all<{
      id: string;
      version_number: number;
      title: string;
      created_at: string;
      user_id: string;
      email: string;
      is_active: 0 | 1;
    }>();

  // A saved assignment always has a version: creation and activation are atomic.
  if (results.length === 0) throw new AssignmentNotFoundError();

  return results.map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    title: row.title,
    createdAt: row.created_at,
    createdBy: { id: row.user_id, email: row.email },
    isActive: row.is_active === 1,
  }));
}

export interface AssignmentSnapshot {
  assignmentId: string;
  versionId: string;
  statements: D1PreparedStatement[];
}

/**
 * Builds the insert batch for a brand-new assignment and its first version.
 * Callers that need assignment creation in a larger transaction can append
 * these statements instead of calling createAssignment.
 */
export function assignmentSnapshotStatements(
  db: D1Database,
  config: ValidatedConfig,
  userId: string,
  now: string,
): AssignmentSnapshot {
  const assignmentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const rubricVersionId = crypto.randomUUID();
  const testSuiteVersionId = crypto.randomUUID();

  return {
    assignmentId,
    versionId,
    statements: [
      db
        .prepare('INSERT INTO assignments (id, active_version_id, created_at, updated_at) VALUES (?, NULL, ?, ?)')
        .bind(assignmentId, now, now),
      ...rubricStatements(db, rubricVersionId, config, now),
      ...testSuiteStatements(db, testSuiteVersionId, config, now),
      versionInsert(db, {
        id: versionId, assignmentId, versionNumber: 1, rubricVersionId, testSuiteVersionId,
      }, config, userId, now),
    ],
  };
}

export async function createAssignment(
  db: D1Database,
  config: ValidatedConfig,
  userId: string,
  now: string = new Date().toISOString(),
): Promise<AssignmentVersionDetail> {
  const snapshot = assignmentSnapshotStatements(db, config, userId, now);
  await db.batch(snapshot.statements);
  return getVersion(db, snapshot.assignmentId, snapshot.versionId);
}

export interface RevisionResult {
  changed: boolean;
  version: AssignmentVersionDetail;
}

export async function reviseAssignment(
  db: D1Database,
  assignmentId: string,
  baseVersionId: string,
  config: ValidatedConfig,
  userId: string,
  now: string = new Date().toISOString(),
): Promise<RevisionResult> {
  const active = await getActiveVersion(db, assignmentId);
  if (active.id !== baseVersionId) {
    throw new StaleVersionError(active.id);
  }

  const changes = compareConfigs(active, config);
  if (!isChanged(changes)) {
    return { changed: false, version: active };
  }

  const rubricVersionId = changes.rubric ? crypto.randomUUID() : active.rubricVersionId;
  const testSuiteVersionId = changes.tests
    ? crypto.randomUUID()
    : active.testSuiteVersionId;
  const versionId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [];
  if (changes.rubric) {
    statements.push(...rubricStatements(db, rubricVersionId, config, now));
  }
  if (changes.tests) {
    statements.push(...testSuiteStatements(db, testSuiteVersionId, config, now));
  }
  statements.push(versionInsert(db, {
    id: versionId,
    assignmentId,
    versionNumber: active.versionNumber + 1,
    rubricVersionId,
    testSuiteVersionId,
  }, config, userId, now));

  try {
    await db.batch(statements);
  } catch (error) {
    const latest = await getActiveVersionOrNull(db, assignmentId);
    if (latest !== null && latest.id === baseVersionId) {
      throw error;
    }
    if (latest !== null) {
      throw new StaleVersionError(latest.id);
    }
    throw error;
  }

  return { changed: true, version: await getVersion(db, assignmentId, versionId) };
}

function versionInsert(
  db: D1Database,
  version: VersionIdentity,
  config: ValidatedConfig,
  userId: string,
  now: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO assignment_versions
      (id, assignment_id, version_number, title, description, format, entry_point,
       rubric_version_id, test_suite_version_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    version.id,
    version.assignmentId,
    version.versionNumber,
    config.title,
    config.description,
    config.format,
    config.format === 'function' ? config.entryPoint : null,
    version.rubricVersionId,
    version.testSuiteVersionId,
    now,
    userId,
  );
}

async function getActiveVersionOrNull(
  db: D1Database,
  assignmentId: string,
): Promise<AssignmentVersionDetail | null> {
  try {
    return await getActiveVersion(db, assignmentId);
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return null;
    }
    throw error;
  }
}

async function loadVersionDetail(
  db: D1Database,
  row: VersionRow,
): Promise<AssignmentVersionDetail> {
  const [criteriaResult, testsResult] = await Promise.all([
    db
      .prepare(
        `SELECT criterion_id, description, expected_behavior
         FROM rubric_criteria
         WHERE rubric_version_id = ?
         ORDER BY position ASC`,
      )
      .bind(row.rubric_version_id)
      .all<{ criterion_id: string; description: string; expected_behavior: string }>(),
    db
      .prepare(
        `SELECT test_id, arguments_json, expected_return_json, stdin,
                expected_stdout, comparison_rule
         FROM tests
         WHERE test_suite_version_id = ?
         ORDER BY position ASC`,
      )
      .bind(row.test_suite_version_id)
      .all<StoredTestRow>(),
  ]);

  const base = {
    id: row.id,
    assignmentId: row.assignment_id,
    versionNumber: row.version_number,
    title: row.title,
    description: row.description,
    rubricVersionId: row.rubric_version_id,
    testSuiteVersionId: row.test_suite_version_id,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: row.created_by_email },
    criteria: criteriaResult.results.map((criterion) => ({
      id: criterion.criterion_id,
      description: criterion.description,
      expectedBehavior: criterion.expected_behavior,
    })),
  };

  if (row.format === 'function') {
    return {
      ...base,
      format: 'function',
      entryPoint: row.entry_point ?? '',
      tests: testsResult.results.map((row): FunctionTestCase => {
        const test = readStoredTest(row);
        if (test?.comparisonRule !== COMPARISON_RULE) {
          throw new Error('The saved function test is inconsistent with its assignment version.');
        }
        return test;
      }),
    };
  }

  return {
    ...base,
    format: 'script',
    tests: testsResult.results.map((row): ScriptTestCase => {
      const test = readStoredTest(row);
      if (test?.comparisonRule !== SCRIPT_COMPARISON_RULE) {
        throw new Error('The saved script test is inconsistent with its assignment version.');
      }
      return test;
    }),
  };
}

function rubricStatements(
  db: D1Database,
  rubricVersionId: string,
  config: ValidatedConfig,
  now: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare('INSERT INTO rubric_versions (id, created_at) VALUES (?, ?)')
      .bind(rubricVersionId, now),
    ...config.criteria.map((criterion, position) =>
      db
        .prepare(
          `INSERT INTO rubric_criteria
            (rubric_version_id, position, criterion_id, description, expected_behavior)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          rubricVersionId,
          position,
          criterion.id,
          criterion.description,
          criterion.expectedBehavior,
        ),
    ),
  ];
}

function testSuiteStatements(
  db: D1Database,
  testSuiteVersionId: string,
  config: ValidatedConfig,
  now: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare('INSERT INTO test_suite_versions (id, created_at) VALUES (?, ?)')
      .bind(testSuiteVersionId, now),
    ...config.tests.map((test, position) =>
      test.comparisonRule === COMPARISON_RULE
        ? db
          .prepare(
            `INSERT INTO tests
              (test_suite_version_id, position, test_id, arguments_json,
               expected_return_json, comparison_rule)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            testSuiteVersionId,
            position,
            test.id,
            test.argumentsJson,
            test.expectedReturnJson,
            test.comparisonRule,
          )
        : db
          .prepare(
            `INSERT INTO tests
              (test_suite_version_id, position, test_id, stdin,
               expected_stdout, comparison_rule)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            testSuiteVersionId,
            position,
            test.id,
            test.stdin,
            test.expectedStdout,
            test.comparisonRule,
          ),
    ),
  ];
}
