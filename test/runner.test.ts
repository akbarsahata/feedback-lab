import { describe, expect, it } from 'vitest';
import {
  parseRunnerResult,
  RunnerProtocolError,
  type RunnerJob,
} from '../src/runner';

const job = {
  protocol: 2,
  format: 'function',
  runId: 'run-1',
  testId: 'test-1',
  runnerArtifact: 'native-python-runner/2',
  limits: { executionMs: 2000, memoryMiB: 128, outputBytes: 16384 },
} satisfies Pick<RunnerJob, 'protocol' | 'format' | 'runId' | 'testId' | 'limits' | 'runnerArtifact'>;

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 2,
    format: 'function',
    runId: 'run-1',
    testId: 'test-1',
    runnerArtifact: 'native-python-runner/2',
    outcome: 'completed',
    actual: { kind: 'none' },
    stdout: '',
    stderr: '',
    stdoutValid: true,
    outputTruncated: false,
    executionMs: 10,
    warm: true,
    ...overrides,
  };
}

describe('runner protocol', () => {
  it('accepts a completed typed result with bounded output', () => {
    const parsed = parseRunnerResult(response(), job);
    expect(parsed.outcome).toBe('completed');
    expect(parsed.actual).toEqual({ kind: 'none' });
    expect(parsed.warm).toBe(true);
  });

  it('accepts a classified execution failure without an actual value', () => {
    const parsed = parseRunnerResult(
      response({
        outcome: 'execution_error',
        actual: undefined,
        diagnostic: 'ValueError: bad input',
      }),
      job,
    );
    expect(parsed.outcome).toBe('execution_error');
    expect(parsed.diagnostic).toContain('ValueError');
  });

  it('rejects identity mismatches and unknown outcomes', () => {
    expect(() => parseRunnerResult(response({ runId: 'other' }), job)).toThrow(
      RunnerProtocolError,
    );
    expect(() => parseRunnerResult(response({ outcome: 'pass' }), job)).toThrow(
      RunnerProtocolError,
    );
  });

  it('rejects a completed result without an actual value', () => {
    expect(() => parseRunnerResult(response({ actual: undefined }), job)).toThrow(
      /actual value/i,
    );
  });

  it('rejects a failure that carries an actual value or lacks a diagnostic', () => {
    expect(() =>
      parseRunnerResult(response({ outcome: 'timed_out' }), job),
    ).toThrow(/actual value/i);
    expect(() =>
      parseRunnerResult(
        response({ outcome: 'execution_error', actual: undefined }),
        job,
      ),
    ).toThrow(/diagnostic/i);
  });

  it('enforces output and return budgets', () => {
    expect(() =>
      parseRunnerResult(response({ stdout: 'x'.repeat(16385) }), job),
    ).toThrow(/output cap/i);
    expect(() =>
      parseRunnerResult(
        response({
          actual: { kind: 'str', value: 'x'.repeat(1024 * 1024 + 1) },
        }),
        job,
      ),
    ).toThrow(/return budget/i);
  });

  it('accepts a completed script with stdout but no fabricated return value', () => {
    const scriptJob = {
      ...job,
      format: 'script',
      runId: 'run-script',
      testId: 'test-script',
    } satisfies Pick<RunnerJob, 'protocol' | 'format' | 'runId' | 'testId' | 'limits' | 'runnerArtifact'>;
    const parsed = parseRunnerResult(
      response({
        runId: 'run-script',
        testId: 'test-script',
        format: 'script',
        actual: undefined,
        stdout: '7\ufffd',
        stdoutValid: false,
        stderrValid: true,
        capturedOutputBytes: 2,
      }),
      scriptJob,
    );
    expect(parsed.format).toBe('script');
    expect(parsed.outcome).toBe('completed');
    expect(parsed.stdout).toBe('7\ufffd');
    expect(parsed.stdoutValid).toBe(false);
  });

  it('rejects a script result that carries an actual value or the wrong format', () => {
    const scriptJob = {
      ...job,
      format: 'script',
    } satisfies Pick<RunnerJob, 'protocol' | 'format' | 'runId' | 'testId' | 'limits' | 'runnerArtifact'>;
    expect(() =>
      parseRunnerResult(
        response({
          format: 'script',
          actual: { kind: 'none' },
          stderrValid: true,
          capturedOutputBytes: 0,
        }),
        scriptJob,
      ),
    ).toThrow(/must not include/i);
    expect(() =>
      parseRunnerResult(response({ format: 'script', actual: undefined }), job),
    ).toThrow(/format does not match/i);
  });

  it('keeps valid stdout complete when a lossy stderr preview expands beyond the raw cap', () => {
    const scriptJob = { ...job, format: 'script' as const };
    const stdout = 'x'.repeat(14000);
    const stderr = '\ufffd'.repeat(2384);
    const evidence = response({
      format: 'script',
      actual: undefined,
      stdout,
      stderr,
      stderrValid: false,
      capturedOutputBytes: 16384,
    });
    expect(parseRunnerResult(evidence, scriptJob)).toMatchObject({
      stdout,
      stderr,
      outputTruncated: false,
    });
    expect(() => parseRunnerResult({ ...evidence, capturedOutputBytes: 16385 }, scriptJob))
      .toThrow(/output cap/i);
    expect(() => parseRunnerResult({ ...evidence, stdout: null }, scriptJob))
      .toThrow(/stdout/i);
  });

  it('rejects an older protocol or an artifact different from the one pinned to the job', () => {
    expect(() => parseRunnerResult(response({ protocol: 1 }), job)).toThrow(/protocol/i);
    expect(() => parseRunnerResult(response({ runnerArtifact: 'native-python-runner/1' }), job))
      .toThrow(/identity/i);
  });
});
