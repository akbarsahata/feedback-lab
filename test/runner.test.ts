import { describe, expect, it } from 'vitest';
import {
  parseRunnerResult,
  RunnerProtocolError,
  type RunnerJob,
} from '../src/runner';

const job = {
  runId: 'run-1',
  testId: 'test-1',
  limits: { executionMs: 2000, memoryMiB: 128, outputBytes: 16384 },
} satisfies Pick<RunnerJob, 'runId' | 'testId' | 'limits'>;

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 1,
    runId: 'run-1',
    testId: 'test-1',
    outcome: 'completed',
    actual: { kind: 'none' },
    stdout: '',
    stderr: '',
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
});
