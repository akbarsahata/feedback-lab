import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/coordinator';
import type { Runner, RunnerJob, RunnerResult } from '../src/runner';
import {
  claimRun,
  createSubmissionRun,
  getTestRun,
  markTestRunning,
  reconcileRuns,
  recordTestResult,
  StaleLaunchError,
} from '../src/runs';
import { sha256Hex } from '../src/upload';
import { postJson, seedUser, signIn, type SignedIn } from './helpers';
import { assignmentConfig, type SerializedVersion } from './fixtures';

const SOURCE = 'def first_positive(values):\n    return next((v for v in values if v > 0), None)\n';

async function createAssignment(session: SignedIn): Promise<SerializedVersion> {
  const { response, body } = await postJson('/api/assignments', {
    config: assignmentConfig(),
  }, session);
  expect(response.status).toBe(201);
  return body.version as SerializedVersion;
}

async function launch(
  session: SignedIn,
  version: SerializedVersion,
  source = SOURCE,
): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const created = await createSubmissionRun(env.DB, {
    assignmentId: version.assignmentId,
    assignmentVersionId: version.id,
    source: bytes,
    sourceSha256: await sha256Hex(bytes),
    userId: session.user.id,
    now: new Date().toISOString(),
  });
  return created.runId;
}

function result(
  job: RunnerJob,
  actual: unknown,
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  return {
    outcome: 'completed',
    actual,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    diagnostic: null,
    executionMs: 12,
    startupMs: 40,
    warm: false,
    ...overrides,
  };
}

function runnerFor(
  values: Record<string, unknown | Error | RunnerResult>,
): Runner {
  return {
    async runTest(job) {
      const value = values[job.testId];
      if (value instanceof Error) throw value;
      if (value !== undefined && typeof value === 'object' && value !== null && 'outcome' in value) {
        return value as RunnerResult;
      }
      return result(job, value);
    },
  };
}

describe('test runs', () => {
  it('persists each typed result and completes when every test has an outcome', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);

    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': { kind: 'int', value: '4' },
        'empty-list': { kind: 'none' },
      }),
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('complete');
    expect(run.tests.map((test) => test.status)).toEqual(['pass', 'pass']);
    expect(run.source).toEqual(new TextEncoder().encode(SOURCE));
    expect(run.pythonRelease).toBe('3.12.11');
    expect(run.limits).toEqual({ executionMs: 2000, memoryMiB: 128, outputBytes: 16384 });
    expect(run.tests[0]?.executionMs).toBe(12);
  });

  it('continues after a mismatch, exception, and confirmed limit', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);

    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': { kind: 'int', value: '5' },
        'empty-list': {
          outcome: 'execution_error',
          actual: null,
          stdout: 'partial',
          stderr: '',
          outputTruncated: false,
          diagnostic: 'IndexError: list index out of range',
          executionMs: 9,
          startupMs: 30,
          warm: true,
        },
      }),
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('complete');
    expect(run.tests.map((test) => test.status)).toEqual(['mismatch', 'execution_error']);
    expect(run.tests[1]?.diagnostic).toContain('IndexError');
  });

  it('treats a runner failure as an incomplete run without inventing results', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);

    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': new Error('runner connection lost'),
      }),
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('incomplete');
    expect(run.incompleteReason).toContain('runner connection lost');
    expect(run.tests.map((test) => test.status)).toEqual([
      'infrastructure_failure',
      'not_run',
    ]);
    expect(run.tests[0]?.diagnostic).toContain('runner connection lost');
  });

  it('does not execute a duplicate delivery twice', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    let calls = 0;
    const runner: Runner = {
      async runTest(job) {
        calls += 1;
        return result(job, job.testId === 'list-argument'
          ? { kind: 'int', value: '4' }
          : { kind: 'none' });
      },
    };

    await executeRun(env, runId, { runner });
    await executeRun(env, runId, { runner });
    expect(calls).toBe(2);
    expect((await getTestRun(env.DB, runId)).status).toBe('complete');
  });

  it('keeps a saved run pinned after a later version changes expected values', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': { kind: 'int', value: '4' },
        'empty-list': { kind: 'none' },
      }),
    });

    const revised = assignmentConfig();
    revised.tests[0] = { id: 'list-argument', arguments: '[[4, -1]]', expectedReturn: '5' };
    const { response } = await postJson(`/api/assignments/${version.assignmentId}/versions`, {
      baseVersionId: version.id,
      config: revised,
    }, researcher);
    expect(response.status).toBe(201);

    const run = await getTestRun(env.DB, runId);
    expect(run.assignmentVersionId).toBe(version.id);
    expect(run.tests[0]?.expectedReturnJson).toBe('4');
    expect(run.tests[0]?.status).toBe('pass');
  });

  it('records each confirmed limit as its own outcome and keeps going', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const config = assignmentConfig({
      tests: [
        { id: 't1', arguments: '[]', expectedReturn: '1' },
        { id: 't2', arguments: '[]', expectedReturn: '1' },
        { id: 't3', arguments: '[]', expectedReturn: '1' },
      ],
    });
    const { body } = await postJson('/api/assignments', { config }, researcher);
    const threeTests = body.version as SerializedVersion;
    const runId = await launch(researcher, threeTests);
    const failure = (outcome: string): RunnerResult => ({
      outcome: outcome as RunnerResult['outcome'],
      actual: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostic: `${outcome} observed`,
      executionMs: 2000,
      startupMs: 20,
      warm: true,
    });

    await executeRun(env, runId, {
      runner: runnerFor({
        t1: failure('timed_out'),
        t2: failure('memory_limit'),
        t3: failure('output_limit'),
      }),
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('complete');
    expect(run.tests.map((test) => test.status)).toEqual([
      'timed_out',
      'memory_limit',
      'output_limit',
    ]);
  });

  it('finalizes abandoned queued and running runs without resuming them', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const queuedId = await launch(researcher, version);
    await env.DB.prepare('UPDATE test_runs SET queued_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', queuedId)
      .run();

    const runningId = await launch(researcher, version);
    await claimRun(env.DB, runningId, new Date().toISOString());
    await markTestRunning(env.DB, runningId, 'list-argument', new Date().toISOString());
    await recordTestResult(env.DB, runningId, 'list-argument', {
      status: 'pass',
      actualJson: '{"kind":"int","value":"4"}',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostic: null,
      executionMs: 5,
      startupMs: 10,
      runnerWarm: false,
      now: new Date().toISOString(),
    });
    await env.DB.prepare('UPDATE test_runs SET started_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', runningId)
      .run();

    const reconciled = await reconcileRuns(env.DB, new Date());
    expect(reconciled).toEqual(expect.arrayContaining([queuedId, runningId]));

    const queued = await getTestRun(env.DB, queuedId);
    expect(queued.status).toBe('incomplete');
    expect(queued.tests.map((test) => test.status)).toEqual(['not_run', 'not_run']);
    expect(queued.tests[0]?.diagnostic).toContain('not dispatched');

    const interrupted = await getTestRun(env.DB, runningId);
    expect(interrupted.status).toBe('incomplete');
    expect(interrupted.tests.map((test) => test.status)).toEqual(['pass', 'not_run']);
    expect(interrupted.incompleteReason).toContain('did not finish');

    const late = await recordTestResult(env.DB, runningId, 'empty-list', {
      status: 'pass',
      actualJson: '{"kind":"none"}',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostic: null,
      executionMs: 5,
      startupMs: 10,
      runnerWarm: true,
      now: new Date().toISOString(),
    });
    expect(late).toBe(false);
  });

  it('rejects a launch whose version is no longer active', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const revised = assignmentConfig({ title: 'Revised title' });
    await postJson(`/api/assignments/${version.assignmentId}/versions`, {
      baseVersionId: version.id,
      config: revised,
    }, researcher);

    const bytes = new TextEncoder().encode(SOURCE);
    await expect(
      createSubmissionRun(env.DB, {
        assignmentId: version.assignmentId,
        assignmentVersionId: version.id,
        source: bytes,
        sourceSha256: await sha256Hex(bytes),
        userId: researcher.user.id,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow(StaleLaunchError);
  });
});
