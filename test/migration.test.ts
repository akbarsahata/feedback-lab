import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import { createAssignment, getVersion, reviseAssignment } from '../src/repository';
import { getRunTestEvidence, getTestRun } from '../src/runs';
import { assignmentConfig, scriptConfig } from './fixtures';

const NOW = '2026-11-25T00:00:00.000Z';

async function resetToLegacySchema(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS test_results'),
    env.DB.prepare('DROP TABLE IF EXISTS test_runs'),
    env.DB.prepare('DROP TABLE IF EXISTS submission_versions'),
    env.DB.prepare('DROP TABLE IF EXISTS assignment_versions'),
    env.DB.prepare('DROP TABLE IF EXISTS assignments'),
    env.DB.prepare('DROP TABLE IF EXISTS tests'),
    env.DB.prepare('DROP TABLE IF EXISTS test_suite_versions'),
    env.DB.prepare('DROP TABLE IF EXISTS rubric_criteria'),
    env.DB.prepare('DROP TABLE IF EXISTS rubric_versions'),
    env.DB.prepare('DROP TABLE IF EXISTS sessions'),
    env.DB.prepare('DROP TABLE IF EXISTS users'),
    env.DB.prepare('DELETE FROM d1_migrations'),
  ]);
  await applyD1Migrations(env.DB, env.LEGACY_TEST_MIGRATIONS);
}

async function seedLegacyEvidence(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ('u1', 'legacy@example.test', 'unused', 'researcher', ?)`,
    ).bind(NOW),
    env.DB.prepare(`INSERT INTO rubric_versions (id, created_at) VALUES ('rv1', ?)`).bind(NOW),
    env.DB.prepare(
      `INSERT INTO rubric_criteria
         (rubric_version_id, position, criterion_id, description, expected_behavior)
       VALUES ('rv1', 0, 'r1', 'Iteration order', 'Checks every item.')`,
    ),
    env.DB.prepare(`INSERT INTO test_suite_versions (id, created_at) VALUES ('ts1', ?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO test_suite_versions (id, created_at) VALUES ('ts2', ?)`).bind(NOW),
    env.DB.prepare(
      `INSERT INTO tests
         (test_suite_version_id, position, test_id, arguments_json,
          expected_return_json, comparison_rule)
       VALUES ('ts1', 0, 't1', '[1]', '4', 'function-value-v1')`,
    ),
    env.DB.prepare(
      `INSERT INTO tests
         (test_suite_version_id, position, test_id, arguments_json,
          expected_return_json, comparison_rule)
       VALUES ('ts2', 0, 't1', '[1]', '5', 'function-value-v1')`,
    ),
    env.DB.prepare(
      `INSERT INTO assignments (id, active_version_id, created_at, updated_at)
       VALUES ('a1', NULL, ?, ?)`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO assignment_versions
         (id, assignment_id, version_number, title, description, format, entry_point,
          rubric_version_id, test_suite_version_id, created_at, created_by)
       VALUES ('v1', 'a1', 1, 'Legacy function', 'Return four.', 'function', 'answer',
               'rv1', 'ts1', ?, 'u1')`,
    ).bind(NOW),
    // The active version is newer than the saved run below; the run still pins v1.
    env.DB.prepare(
      `INSERT INTO assignment_versions
         (id, assignment_id, version_number, title, description, format, entry_point,
          rubric_version_id, test_suite_version_id, created_at, created_by)
       VALUES ('v2', 'a1', 2, 'Legacy function revised', 'Return five.', 'function', 'answer',
               'rv1', 'ts2', ?, 'u1')`,
    ).bind('2026-11-25T01:00:00.000Z'),
  ]);

  await env.DB.prepare(
    `INSERT INTO submission_versions
       (id, assignment_id, assignment_version_id, rubric_version_id,
        test_suite_version_id, source, source_sha256, byte_size, created_by, created_at)
     VALUES ('s1', 'a1', 'v1', 'rv1', 'ts1', ?, 'hash', 22, 'u1', ?)`,
  ).bind(new TextEncoder().encode('def answer():\n    return 4\n'), NOW).run();
  await env.DB.prepare(
    `INSERT INTO test_runs
       (id, submission_id, assignment_id, assignment_version_id, rubric_version_id,
        test_suite_version_id, comparison_rule, python_release, runner_artifact,
        limits_json, status, queued_at, started_at, finished_at, created_by)
     VALUES ('run1', 's1', 'a1', 'v1', 'rv1', 'ts1', 'function-value-v1',
             '3.12.11', 'native-python-runner/1',
             '{"executionMs":2000,"memoryMiB":128,"outputBytes":16384}',
             'complete', ?, ?, ?, 'u1')`,
  ).bind(NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO test_results
       (run_id, test_id, position, status, started_at, finished_at, execution_ms,
        startup_ms, runner_warm, actual_json, stdout, stderr, output_truncated, diagnostic)
     VALUES ('run1', 't1', 0, 'pass', ?, ?, 12, 40, 0,
             '{"kind":"int","value":"4"}', 'printed', '', 0, NULL)`,
  ).bind(NOW, NOW).run();
}

describe('migration 0003 from old migrations and data', () => {
  it('preserves IDs and evidence, then saves script revisions without touching history', async () => {
    await resetToLegacySchema();
    await seedLegacyEvidence();
    const seededRuns = await env.DB.prepare('SELECT id FROM test_runs').all();
    if (JSON.stringify(seededRuns.results) !== JSON.stringify([{ id: 'run1' }])) {
      throw new Error(`Seed did not finish: ${JSON.stringify(seededRuns.results)}`);
    }

    const before = {
      assignments: 1,
      versions: 2,
      submissions: 1,
      runs: 1,
      results: 1,
      tests: 2,
    };
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const rows = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM assignments) AS assignments,
         (SELECT COUNT(*) FROM assignment_versions) AS versions,
         (SELECT COUNT(*) FROM submission_versions) AS submissions,
         (SELECT COUNT(*) FROM test_runs) AS runs,
         (SELECT COUNT(*) FROM test_results) AS results,
         (SELECT COUNT(*) FROM tests) AS tests`,
    ).first<typeof before>();
    expect(rows).toEqual(before);

    const violations = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(violations.results).toEqual([]);

    const active = await env.DB.prepare(
      'SELECT active_version_id AS id FROM assignments WHERE id = ?',
    ).bind('a1').first<{ id: string }>();
    expect(active?.id).toBe('v2');

    const run = await getTestRun(env.DB, 'run1');
    expect(run.assignmentVersionId).toBe('v1');
    expect(run.format).toBe('function');
    expect(run.tests[0]?.status).toBe('pass');
    expect(run.source).toEqual(new TextEncoder().encode('def answer():\n    return 4\n'));

    const evidence = await getRunTestEvidence(env.DB, 'run1', 't1');
    expect(evidence?.expectedReturnJson).toBe('4');
    expect(evidence?.actualJson).toBe('{"kind":"int","value":"4"}');
    expect(evidence?.stdout).toBe('printed');

    const legacyVersion = await getVersion(env.DB, 'a1', 'v1');
    expect(legacyVersion.format).toBe('function');
    expect(legacyVersion.versionNumber).toBe(1);

    const scriptValidation = validateConfig(scriptConfig());
    if (!scriptValidation.ok) throw new Error(JSON.stringify(scriptValidation.errors));
    const script = await createAssignment(env.DB, scriptValidation.config, 'u1', NOW);
    expect(script.format).toBe('script');
    expect('entryPoint' in script).toBe(false);

    const noOp = await reviseAssignment(
      env.DB,
      script.assignmentId,
      script.id,
      scriptValidation.config,
      'u1',
      '2026-11-25T02:00:00.000Z',
    );
    expect(noOp.changed).toBe(false);
    expect(noOp.version.id).toBe(script.id);

    const functionValidation = validateConfig(assignmentConfig({ title: 'Switched to function' }));
    if (!functionValidation.ok) throw new Error(JSON.stringify(functionValidation.errors));
    const switched = await reviseAssignment(
      env.DB,
      script.assignmentId,
      script.id,
      functionValidation.config,
      'u1',
      '2026-11-25T03:00:00.000Z',
    );
    expect(switched.changed).toBe(true);
    expect(switched.version.format).toBe('function');
    expect(switched.version.testSuiteVersionId).not.toBe(script.testSuiteVersionId);

    const originalScript = await getVersion(env.DB, script.assignmentId, script.id);
    expect(originalScript.format).toBe('script');
    if (originalScript.format === 'script') {
      expect(originalScript.tests[0]?.stdin).toBe('1\n2\n');
      expect(originalScript.tests[0]?.expectedStdout).toBe('3\n');
    }

    const legacyAfter = await getVersion(env.DB, 'a1', 'v1');
    expect(legacyAfter.title).toBe('Legacy function');
    expect(legacyAfter.format).toBe('function');
  });
});
