import {
  compareConfigs,
  isChanged,
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
  criteriaCount: number;
  testsCount: number;
  updatedAt: string;
}

export interface CriterionRecord {
  id: string;
  description: string;
  expectedBehavior: string;
}

export interface TestRecord {
  id: string;
  argumentsJson: string;
  expectedReturnJson: string;
  comparisonRule: string;
}

export interface AssignmentVersionDetail {
  id: string;
  assignmentId: string;
  versionNumber: number;
  title: string;
  description: string;
  format: 'function';
  entryPoint: string;
  rubricVersionId: string;
  testSuiteVersionId: string;
  createdAt: string;
  createdBy: { id: string; email: string };
  criteria: CriterionRecord[];
  tests: TestRecord[];
}

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
  format: 'function';
  entry_point: string;
  rubric_version_id: string;
  test_suite_version_id: string;
  created_at: string;
  created_by: string;
  created_by_email: string;
}

export async function listAssignments(db: D1Database): Promise<AssignmentSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id,
              a.active_version_id AS active_version_id,
              a.updated_at AS updated_at,
              v.version_number AS version_number,
              v.title AS title,
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
      criteria_count: number;
      tests_count: number;
    }>();

  return results.map((row) => ({
    id: row.id,
    activeVersionId: row.active_version_id,
    versionNumber: row.version_number,
    title: row.title,
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
  const assignment = await db
    .prepare('SELECT id, active_version_id FROM assignments WHERE id = ?')
    .bind(assignmentId)
    .first<{ id: string; active_version_id: string | null }>();
  if (assignment === null) {
    throw new AssignmentNotFoundError();
  }

  const { results } = await db
    .prepare(
      `SELECT v.id, v.version_number, v.title, v.created_at, u.id AS user_id, u.email
       FROM assignment_versions v
       JOIN users u ON u.id = v.created_by
       WHERE v.assignment_id = ?
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
    }>();

  return results.map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    title: row.title,
    createdAt: row.created_at,
    createdBy: { id: row.user_id, email: row.email },
    isActive: row.id === assignment.active_version_id,
  }));
}

export async function createAssignment(
  db: D1Database,
  config: ValidatedConfig,
  userId: string,
  now: string = new Date().toISOString(),
): Promise<AssignmentVersionDetail> {
  const assignmentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const rubricVersionId = crypto.randomUUID();
  const testSuiteVersionId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO assignments (id, active_version_id, created_at, updated_at) VALUES (?, NULL, ?, ?)')
      .bind(assignmentId, now, now),
    ...rubricStatements(db, rubricVersionId, config, now),
    ...testSuiteStatements(db, testSuiteVersionId, config, now),
    db
      .prepare(
        `INSERT INTO assignment_versions
          (id, assignment_id, version_number, title, description, format, entry_point,
           rubric_version_id, test_suite_version_id, created_at, created_by)
         VALUES (?, ?, 1, ?, ?, 'function', ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        assignmentId,
        config.title,
        config.description,
        config.entryPoint,
        rubricVersionId,
        testSuiteVersionId,
        now,
        userId,
      ),
  ];

  await db.batch(statements);
  return getVersion(db, assignmentId, versionId);
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

  const changes = compareConfigs(configFromDetail(active), config);
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
  statements.push(
    db
      .prepare(
        `INSERT INTO assignment_versions
          (id, assignment_id, version_number, title, description, format, entry_point,
           rubric_version_id, test_suite_version_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'function', ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        assignmentId,
        active.versionNumber + 1,
        config.title,
        config.description,
        config.entryPoint,
        rubricVersionId,
        testSuiteVersionId,
        now,
        userId,
      ),
  );

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

export function configFromDetail(detail: AssignmentVersionDetail): ValidatedConfig {
  return {
    title: detail.title,
    description: detail.description,
    entryPoint: detail.entryPoint,
    criteria: detail.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      expectedBehavior: criterion.expectedBehavior,
    })),
    tests: detail.tests.map((test) => ({
      id: test.id,
      argumentsJson: test.argumentsJson,
      expectedReturnJson: test.expectedReturnJson,
      comparisonRule: 'function-value-v1',
    })),
  };
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
        `SELECT test_id, arguments_json, expected_return_json, comparison_rule
         FROM tests
         WHERE test_suite_version_id = ?
         ORDER BY position ASC`,
      )
      .bind(row.test_suite_version_id)
      .all<{
        test_id: string;
        arguments_json: string;
        expected_return_json: string;
        comparison_rule: string;
      }>(),
  ]);

  return {
    id: row.id,
    assignmentId: row.assignment_id,
    versionNumber: row.version_number,
    title: row.title,
    description: row.description,
    format: row.format,
    entryPoint: row.entry_point,
    rubricVersionId: row.rubric_version_id,
    testSuiteVersionId: row.test_suite_version_id,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: row.created_by_email },
    criteria: criteriaResult.results.map((criterion) => ({
      id: criterion.criterion_id,
      description: criterion.description,
      expectedBehavior: criterion.expected_behavior,
    })),
    tests: testsResult.results.map((test) => ({
      id: test.test_id,
      argumentsJson: test.arguments_json,
      expectedReturnJson: test.expected_return_json,
      comparisonRule: test.comparison_rule,
    })),
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
      db
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
        ),
    ),
  ];
}
