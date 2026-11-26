import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/coordinator';
import type { Runner, RunnerJob, RunnerResult } from '../src/runner';
import {
  claimRun,
  createSubmissionRun,
  getRunTestEvidence,
  getTestRun,
  markRunIncomplete,
  markTestRunning,
  reconcileRuns,
  recordTestResult,
  StaleLaunchError,
} from '../src/runs';
import { sha256Hex } from '../src/upload';
import { postJson, seedUser, signIn, type SignedIn } from './helpers';
import { assignmentConfig, scriptConfig, type SerializedVersion } from './fixtures';

const SOURCE = 'def first_positive(values):\n    return next((v for v in values if v > 0), None)\n';
const SCRIPT_SOURCE = 'import sys\nif __name__ == "__main__":\n    print(sum(int(line) for line in sys.stdin))\n';

async function createAssignment(session: SignedIn): Promise<SerializedVersion> {
  const { response, body } = await postJson('/api/assignments', {
    config: assignmentConfig(),
  }, session);
  expect(response.status).toBe(201);
  return body.version as SerializedVersion;
}

async function createScriptAssignment(session: SignedIn): Promise<SerializedVersion> {
  const { response, body } = await postJson('/api/assignments', {
    config: scriptConfig(),
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
    format: job.format,
    outcome: 'completed',
    actual,
    stdout: '',
    stderr: '',
    stdoutValid: true,
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
          format: 'function',
          outcome: 'execution_error',
          actual: null,
          stdout: 'partial',
          stderr: '',
          stdoutValid: true,
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

  it('executes the exact submitted bytes, including a UTF-8 BOM', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const source = '\uFEFFdef first_positive(values):\n    return 4\n';
    const runId = await launch(researcher, version, source);
    let seen = '';
    await executeRun(env, runId, {
      runner: {
        async runTest(job) {
          seen = job.source;
          return result(job, job.testId === 'list-argument'
            ? { kind: 'int', value: '4' }
            : { kind: 'none' });
        },
      },
    });
    expect(seen).toBe(source);
    expect(seen.charCodeAt(0)).toBe(0xfeff);
  });

  it('rejects a late result after the run is already complete', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': { kind: 'int', value: '4' },
        'empty-list': { kind: 'none' },
      }),
    });

    const late = await recordTestResult(env.DB, runId, 'empty-list', {
      status: 'mismatch',
      actualJson: '{"kind":"int","value":"1"}',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostic: null,
      executionMs: 5,
      startupMs: 10,
      stdoutLossy: false,
      runnerWarm: true,
      now: new Date().toISOString(),
    });
    expect(late).toBe(false);
    expect((await getTestRun(env.DB, runId)).status).toBe('complete');
    expect((await getTestRun(env.DB, runId)).tests[1]?.status).toBe('pass');
  });

  it('stores a return value at the 1 MiB budget without overshooting D1 rows', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    const large = 'x'.repeat(1024 * 1024 - 64);
    await executeRun(env, runId, {
      runner: runnerFor({
        'list-argument': { kind: 'str', value: large },
        'empty-list': { kind: 'none' },
      }),
    });

    const evidence = await getRunTestEvidence(env.DB, runId, 'list-argument');
    expect(evidence?.status).toBe('mismatch');
    expect(evidence?.actualJson?.length).toBeGreaterThan(1024 * 1024 - 100);
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
    const evidence = await getRunTestEvidence(env.DB, runId, 'list-argument');
    expect(run.assignmentVersionId).toBe(version.id);
    expect(evidence?.expectedReturnJson).toBe('4');
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
      format: 'function',
      outcome: outcome as RunnerResult['outcome'],
      actual: null,
      stdout: '',
      stderr: '',
      stdoutValid: true,
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
      stdoutLossy: false,
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
      stdoutLossy: false,
      runnerWarm: true,
      now: new Date().toISOString(),
    });
    expect(late).toBe(false);
  });

  it('rejects a late in-flight result after an interruption finalizes the run', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    await claimRun(env.DB, runId, new Date().toISOString());
    await markTestRunning(env.DB, runId, 'list-argument', new Date().toISOString());
    await markRunIncomplete(env.DB, runId, 'runner interrupted', new Date().toISOString());

    const late = await recordTestResult(env.DB, runId, 'list-argument', {
      status: 'pass',
      actualJson: '{"kind":"int","value":"4"}',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      diagnostic: null,
      executionMs: 5,
      startupMs: 10,
      stdoutLossy: false,
      runnerWarm: false,
      now: new Date().toISOString(),
    });
    expect(late).toBe(false);
    const run = await getTestRun(env.DB, runId);
    expect(run.tests[0]?.status).toBe('infrastructure_failure');
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

  it('marks a queued run incomplete rather than substituting its pinned artifact', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    await env.DB.prepare('UPDATE test_runs SET runner_artifact = ? WHERE id = ?')
      .bind('native-python-runner/1', runId).run();

    let dispatched = false;
    await executeRun(env, runId, {
      runner: {
        async runTest(job) {
          dispatched = true;
          return result(job, { kind: 'none' });
        },
      },
    });
    expect(dispatched).toBe(false);
    const run = await getTestRun(env.DB, runId);
    expect(run).toMatchObject({
      status: 'incomplete',
      runnerArtifact: 'native-python-runner/1',
      incompleteReason: 'The pinned runner artifact is no longer available.',
    });
    expect(run.tests.map((test) => test.status)).toEqual(['not_run', 'not_run']);
  });
});

function scriptResult(stdout: string, overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    format: 'script',
    outcome: 'completed',
    actual: null,
    stdout,
    stderr: '',
    stdoutValid: true,
    outputTruncated: false,
    diagnostic: null,
    executionMs: 15,
    startupMs: 25,
    warm: false,
    ...overrides,
  };
}

describe('script test runs', () => {
  it('compares pinned stdout and distinguishes empty from unavailable output', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createScriptAssignment(researcher);
    expect(version.format).toBe('script');
    expect(version).not.toHaveProperty('entryPoint');
    expect(version.testSuite.tests[0]).toMatchObject({
      id: 'two-values',
      stdin: '1\n2\n',
      expectedStdout: '3\n',
      comparisonRule: 'script-stdout-v1',
    });

    const runId = await launch(researcher, version, SCRIPT_SOURCE);
    await executeRun(env, runId, {
      runner: {
        async runTest(job) {
          if (job.format !== 'script') throw new Error('expected a script job');
          expect(job.stdin).toBe(job.testId === 'two-values' ? '1\n2\n' : '');
          return scriptResult(job.testId === 'two-values' ? '3\n' : '');
        },
      },
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('complete');
    expect(run.format).toBe('script');
    expect(run.entryPoint).toBeNull();
    expect(run.tests.map((test) => test.status)).toEqual(['pass', 'pass']);

    const empty = await getRunTestEvidence(env.DB, runId, 'empty');
    expect(empty?.format).toBe('script');
    expect(empty?.stdin).toBe('');
    expect(empty?.expectedStdout).toBe('');
    expect(empty?.stdout).toBe('');
    expect(empty?.actualJson).toBeNull();
  });

  it('applies only the documented stdout comparison and treats invalid output as an execution error', async () => {
    const researcher = await signIn(await seedUser());
    const config = scriptConfig({
      tests: [
        { id: 'seven-newline', stdin: '', expectedStdout: '7' },
        { id: 'seven-space', stdin: '', expectedStdout: '7' },
        { id: 'invalid-utf8', stdin: '', expectedStdout: '7' },
        { id: 'nonzero', stdin: '', expectedStdout: '7' },
        { id: 'limit', stdin: '', expectedStdout: '7' },
      ],
    });
    const { response, body } = await postJson('/api/assignments', { config }, researcher);
    expect(response.status).toBe(201);
    const version = body.version as SerializedVersion;
    const runId = await launch(researcher, version, SCRIPT_SOURCE);

    await executeRun(env, runId, {
      runner: {
        async runTest(job) {
          switch (job.testId) {
            case 'seven-newline':
              return scriptResult('7\n');
            case 'seven-space':
              return scriptResult('7 ');
            case 'invalid-utf8':
              return scriptResult('7\ufffd', { stdoutValid: false });
            case 'nonzero':
              return scriptResult('7\n', {
                outcome: 'execution_error',
                diagnostic: 'SystemExit: 3',
              });
            case 'limit':
              return scriptResult('7\n', {
                outcome: 'output_limit',
                outputTruncated: true,
                diagnostic: 'The combined output reached the configured cap.',
              });
            default:
              throw new Error(`Unexpected test ${job.testId}`);
          }
        },
      },
    });

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('complete');
    expect(run.tests.map((test) => test.status)).toEqual([
      'pass',
      'mismatch',
      'execution_error',
      'execution_error',
      'output_limit',
    ]);
    const invalid = await getRunTestEvidence(env.DB, runId, 'invalid-utf8');
    expect(invalid?.stdoutLossy).toBe(true);
    expect(invalid?.diagnostic).toContain('valid UTF-8');
  });

  it('keeps the pinned format and evidence after switching formats in both directions', async () => {
    const researcher = await signIn(await seedUser());
    const functionVersion = await createAssignment(researcher);
    const functionRun = await launch(researcher, functionVersion);
    await executeRun(env, functionRun, {
      runner: runnerFor({
        'list-argument': { kind: 'int', value: '4' },
        'empty-list': { kind: 'none' },
      }),
    });

    await postJson(`/api/assignments/${functionVersion.assignmentId}/versions`, {
      baseVersionId: functionVersion.id,
      config: scriptConfig({ title: 'Now a script' }),
    }, researcher);

    const original = await getTestRun(env.DB, functionRun);
    const originalEvidence = await getRunTestEvidence(env.DB, functionRun, 'list-argument');
    expect(original.format).toBe('function');
    expect(original.entryPoint).toBe('first_positive');
    expect(originalEvidence?.format).toBe('function');
    expect(originalEvidence?.expectedReturnJson).toBe('4');
    expect(originalEvidence?.actualJson).toBe('{"kind":"int","value":"4"}');
    expect(originalEvidence?.stdout).toBe('');

    const scriptVersion = await createScriptAssignment(researcher);
    const scriptRun = await launch(researcher, scriptVersion, SCRIPT_SOURCE);
    await executeRun(env, scriptRun, {
      runner: { async runTest() { return scriptResult('3\n'); } },
    });
    await postJson(`/api/assignments/${scriptVersion.assignmentId}/versions`, {
      baseVersionId: scriptVersion.id,
      config: assignmentConfig({ title: 'Now a function' }),
    }, researcher);

    const scriptEvidence = await getRunTestEvidence(env.DB, scriptRun, 'two-values');
    expect(scriptEvidence?.format).toBe('script');
    expect(scriptEvidence?.stdin).toBe('1\n2\n');
    expect(scriptEvidence?.expectedStdout).toBe('3\n');
    expect(scriptEvidence?.stdout).toBe('3\n');
  });

  it('continues after a script submission failure and preserves completed results on interruption', async () => {
    const researcher = await signIn(await seedUser());
    const config = scriptConfig({
      tests: [
        { id: 'first', stdin: '', expectedStdout: '1' },
        { id: 'second', stdin: '', expectedStdout: '2' },
        { id: 'third', stdin: '', expectedStdout: '3' },
      ],
    });
    const { body } = await postJson('/api/assignments', { config }, researcher);
    const version = body.version as SerializedVersion;
    const runId = await launch(researcher, version, SCRIPT_SOURCE);

    await executeRun(env, runId, {
      runner: {
        async runTest(job) {
          if (job.testId === 'second') throw new Error('runner connection lost');
          return scriptResult(job.testId === 'first' ? '1\n' : '3\n');
        },
      },
    });

    const interrupted = await getTestRun(env.DB, runId);
    expect(interrupted.status).toBe('incomplete');
    expect(interrupted.tests.map((test) => test.status)).toEqual([
      'pass',
      'infrastructure_failure',
      'not_run',
    ]);
    expect((await getRunTestEvidence(env.DB, runId, 'first'))?.status).toBe('pass');
  });
});
