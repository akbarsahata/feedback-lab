import { SCRIPT_COMPARISON_RULE, type TestCase } from './config';
import {
  compareFunctionValue,
  FunctionValueError,
  type ActualValue,
} from './function-value';
import { parseJsonValue } from './json';
import { compareScriptStdout } from './script-output';
import {
  claimRun,
  finalizeRunIfDone,
  getTestExecutionInput,
  getTestRun,
  markRunIncomplete,
  markTestRunning,
  recordTestResult,
  RUNNER_ARTIFACT,
  type RunTestSummary,
  type TestRunDetail,
} from './runs';
import {
  RUNNER_PROTOCOL,
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

  if (run.runnerArtifact !== RUNNER_ARTIFACT) {
    await markRunIncomplete(
      env.DB,
      runId,
      'The pinned runner artifact is no longer available.',
      clock().toISOString(),
    );
    return;
  }

  let runner: Runner;
  try {
    runner = options.runner ?? createServiceRunner(env);
  } catch (error) {
    await markRunIncomplete(env.DB, runId, reasonFor(error), clock().toISOString());
    return;
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(run.source);
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

    const input = await getTestExecutionInput(env.DB, runId, test.id);
    if (input === null || input.comparisonRule !== run.comparisonRule) {
      await markRunIncomplete(
        env.DB,
        runId,
        'The pinned test input could not be loaded.',
        clock().toISOString(),
      );
      return;
    }

    let result: RunnerResult;
    try {
      result = await runner.runTest(jobFor(run, test, input, source));
    } catch (error) {
      await markRunIncomplete(env.DB, runId, reasonFor(error), clock().toISOString());
      return;
    }

    const recorded = classify(input, result);
    const written = await recordTestResult(env.DB, runId, test.id, {
      ...recorded,
      now: clock().toISOString(),
    });
    if (!written) return;
  }

  await finalizeRunIfDone(env.DB, runId, clock().toISOString());
}

function jobFor(
  run: TestRunDetail,
  test: RunTestSummary,
  input: TestCase,
  source: string,
): RunnerJob {
  const common = {
    protocol: RUNNER_PROTOCOL,
    runId: run.id,
    testId: test.id,
    source,
    pythonRelease: run.pythonRelease,
    runnerArtifact: run.runnerArtifact,
    limits: run.limits,
  } as const;
  if (input.comparisonRule === SCRIPT_COMPARISON_RULE) {
    return { ...common, format: 'script', stdin: input.stdin };
  }
  return {
    ...common,
    format: 'function',
    entryPoint: run.entryPoint ?? '',
    argumentsJson: input.argumentsJson,
  };
}

function classify(
  input: TestCase,
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
  stdout: string | null;
  stderr: string;
  stdoutLossy: boolean;
  outputTruncated: boolean;
  diagnostic: string | null;
  executionMs: number | null;
  startupMs: number | null;
  runnerWarm: boolean | null;
} {
  const common = {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutLossy: !result.stdoutValid,
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

  if (input.comparisonRule === SCRIPT_COMPARISON_RULE) {
    if (!result.stdoutValid) {
      return {
        ...common,
        status: 'execution_error',
        actualJson: null,
        diagnostic: "The script's standard output was not valid UTF-8, so it was not compared.",
      };
    }
    if (result.outputTruncated) {
      return {
        ...common,
        status: 'execution_error',
        actualJson: null,
        diagnostic: 'The captured standard output was incomplete, so it was not compared.',
      };
    }
    return {
      ...common,
      status: compareScriptStdout(input.expectedStdout, result.stdout) ? 'pass' : 'mismatch',
      actualJson: null,
      diagnostic: result.diagnostic,
    };
  }

  const actualJson = JSON.stringify(result.actual);
  try {
    const comparison = compareFunctionValue(
      parseJsonValue(input.expectedReturnJson),
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
