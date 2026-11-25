import {
  compareFunctionValue,
  FunctionValueError,
  type ActualValue,
} from './function-value';
import { parseJsonValue } from './json';
import {
  RUN_LIMITS,
  RUNNER_ARTIFACT,
  claimRun,
  finalizeRunIfDone,
  getTestRun,
  markRunIncomplete,
  markTestRunning,
  recordTestResult,
  type RunTestSummary,
  type TestRunDetail,
} from './runs';
import {
  RunnerProtocolError,
  createServiceRunner,
  type Runner,
  type RunnerJob,
  type RunnerResult,
} from './runner';

export interface ExecuteRunOptions {
  runner?: Runner;
  now?: () => Date;
}

/**
 * Executes one queued run sequentially. Each test is persisted as running
 * before the runner receives it, and each terminal result is persisted before
 * the next test begins. A duplicate queue delivery finds no queued run and
 * returns without doing work.
 */
export async function executeRun(
  env: { DB: D1Database; RUNNER?: Fetcher },
  runId: string,
  options: ExecuteRunOptions = {},
): Promise<void> {
  const clock = options.now ?? (() => new Date());
  let run: TestRunDetail;
  try {
    run = await getTestRun(env.DB, runId);
  } catch {
    return;
  }
  if (run.status !== 'queued') return;

  const started = await claimRun(env.DB, runId, clock().toISOString());
  if (!started) return;

  let runner: Runner;
  try {
    runner = options.runner ?? createServiceRunner(env);
  } catch (error) {
    await markRunIncomplete(env.DB, runId, reasonFor(error), clock().toISOString());
    return;
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(run.source);
  } catch {
    await markRunIncomplete(
      env.DB,
      runId,
      'The stored source is not valid UTF-8.',
      clock().toISOString(),
    );
    return;
  }
  for (const test of run.tests) {
    if (test.status !== 'pending') continue;
    const now = clock().toISOString();
    // A false claim means another coordinator or a terminal state changed the
    // run. Stop rather than re-executing or skipping ahead.
    if (!(await markTestRunning(env.DB, runId, test.id, now))) return;

    let result: RunnerResult;
    try {
      result = await runner.runTest(jobFor(run, test, source));
    } catch (error) {
      await markRunIncomplete(env.DB, runId, reasonFor(error), clock().toISOString());
      return;
    }

    const recorded = classify(test, result);
    const written = await recordTestResult(env.DB, runId, test.id, {
      ...recorded,
      now: clock().toISOString(),
    });
    if (!written) return;
  }

  await finalizeRunIfDone(env.DB, runId, clock().toISOString());
}

function jobFor(run: TestRunDetail, test: RunTestSummary, source: string): RunnerJob {
  return {
    protocol: 1,
    runId: run.id,
    testId: test.id,
    entryPoint: run.entryPoint,
    source,
    argumentsJson: test.argumentsJson,
    pythonRelease: run.pythonRelease,
    runnerArtifact: run.runnerArtifact || RUNNER_ARTIFACT,
    limits: { ...RUN_LIMITS, ...run.limits },
  };
}

function classify(
  test: RunTestSummary,
  result: RunnerResult,
): {
  status:
    | 'pass'
    | 'mismatch'
    | 'execution_error'
    | 'timed_out'
    | 'memory_limit'
    | 'output_limit';
  actualJson: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostic: string | null;
  executionMs: number | null;
  startupMs: number | null;
  runnerWarm: boolean | null;
} {
  const common = {
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    executionMs: result.executionMs,
    startupMs: result.startupMs,
    runnerWarm: result.warm,
  };

  if (result.outcome !== 'completed') {
    return {
      ...common,
      status: result.outcome,
      actualJson: null,
      diagnostic: result.diagnostic,
    };
  }

  const actualJson = JSON.stringify(result.actual);
  try {
    const comparison = compareFunctionValue(
      parseJsonValue(test.expectedReturnJson),
      result.actual as ActualValue,
    );
    return {
      ...common,
      status: comparison.matches ? 'pass' : 'mismatch',
      actualJson,
      diagnostic: result.diagnostic,
    };
  } catch (error) {
    return {
      ...common,
      status: 'execution_error',
      actualJson: null,
      diagnostic: error instanceof FunctionValueError
        ? error.message
        : 'The returned value could not be compared with the expected value.',
    };
  }
}

function reasonFor(error: unknown): string {
  if (error instanceof RunnerProtocolError) {
    return `The runner returned an unusable result: ${error.message}`.slice(0, 500);
  }
  if (error instanceof Error && error.message !== '') {
    return error.message.slice(0, 500);
  }
  return 'The test runner could not complete the run.';
}
