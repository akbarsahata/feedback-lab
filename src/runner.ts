import { RUN_LIMITS, type RunLimits } from './runs';

export const RUNNER_PROTOCOL = 1;
export const MAX_ACTUAL_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = RUN_LIMITS.outputBytes;
const MAX_DIAGNOSTIC_CHARS = 2000;

export interface RunnerJob {
  protocol: typeof RUNNER_PROTOCOL;
  runId: string;
  testId: string;
  entryPoint: string;
  source: string;
  argumentsJson: string;
  pythonRelease: string;
  runnerArtifact: string;
  limits: RunLimits;
}

export type RunnerOutcome =
  | 'completed'
  | 'execution_error'
  | 'timed_out'
  | 'memory_limit'
  | 'output_limit';

export interface RunnerResult {
  outcome: RunnerOutcome;
  actual: unknown;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostic: string | null;
  executionMs: number | null;
  startupMs: number | null;
  warm: boolean | null;
}

export interface Runner {
  runTest(job: RunnerJob): Promise<RunnerResult>;
}

export class RunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerProtocolError';
  }
}

export class RunnerUnavailableError extends Error {
  constructor(message = 'The test runner is not configured.') {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

const OUTCOMES: ReadonlySet<string> = new Set([
  'completed',
  'execution_error',
  'timed_out',
  'memory_limit',
  'output_limit',
]);

export function parseRunnerResult(
  value: unknown,
  job: Pick<RunnerJob, 'runId' | 'testId' | 'limits'>,
): RunnerResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerProtocolError('Runner response must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== RUNNER_PROTOCOL) {
    throw new RunnerProtocolError('Runner protocol version is not supported.');
  }
  if (record.runId !== job.runId || record.testId !== job.testId) {
    throw new RunnerProtocolError('Runner response identity does not match the job.');
  }
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome)) {
    throw new RunnerProtocolError('Runner response has an unknown outcome.');
  }

  const stdout = boundedText(record.stdout, 'stdout');
  const stderr = boundedText(record.stderr, 'stderr');
  if (new TextEncoder().encode(stdout + stderr).byteLength > job.limits.outputBytes) {
    throw new RunnerProtocolError('Runner response exceeds the configured output cap.');
  }
  const outputTruncated = record.outputTruncated === true;
  const diagnostic = optionalDiagnostic(record.diagnostic);
  const executionMs = optionalInteger(record.executionMs, 'executionMs');
  const startupMs = optionalInteger(record.startupMs, 'startupMs');
  const warm = parseWarm(record.warm);

  if (record.outcome === 'completed') {
    if (!Object.hasOwn(record, 'actual')) {
      throw new RunnerProtocolError('A completed test must include an actual value.');
    }
    const encoded = JSON.stringify(record.actual);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_ACTUAL_BYTES) {
      throw new RunnerProtocolError('Runner actual value exceeds the configured return budget.');
    }
    return {
      outcome: 'completed',
      actual: record.actual,
      stdout,
      stderr,
      outputTruncated,
      diagnostic,
      executionMs,
      startupMs,
      warm,
    };
  }

  if (record.outcome === 'execution_error' && diagnostic === null) {
    throw new RunnerProtocolError('An execution error must include a diagnostic.');
  }
  if (record.actual !== undefined && record.actual !== null) {
    throw new RunnerProtocolError('A failed execution must not include an actual value.');
  }
  return {
    outcome: record.outcome as RunnerOutcome,
    actual: null,
    stdout,
    stderr,
    outputTruncated,
    diagnostic,
    executionMs,
    startupMs,
    warm,
  };
}

function parseWarm(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new RunnerProtocolError('Runner warm flag must be a boolean.');
  }
  return value;
}

function boundedText(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new RunnerProtocolError(`Runner ${field} must be a string.`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_OUTPUT_BYTES) {
    throw new RunnerProtocolError(`Runner ${field} exceeds the configured output cap.`);
  }
  return value;
}

function optionalDiagnostic(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new RunnerProtocolError('Runner diagnostic must be a string.');
  }
  return value.slice(0, MAX_DIAGNOSTIC_CHARS);
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RunnerProtocolError(`Runner ${field} must be a non-negative integer.`);
  }
  return value as number;
}

/**
 * Sends one test job to the private runner service. The browser never reaches
 * this binding. An absent binding is an infrastructure failure, not a pass.
 */
export function createServiceRunner(env: { RUNNER?: Fetcher }): Runner {
  const binding = env.RUNNER;
  if (binding === undefined) throw new RunnerUnavailableError();
  return {
    async runTest(job: RunnerJob): Promise<RunnerResult> {
      const response = await binding.fetch('https://runner/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      });
      if (!response.ok) {
        throw new RunnerUnavailableError(`Runner returned HTTP ${response.status}.`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new RunnerProtocolError('Runner returned invalid JSON.');
      }
      const parsed = parseRunnerResult(value, job);
      // A container adapter can report cold-start readiness separately from the
      // Python execution clock. The Python service itself leaves this absent.
      const startup = response.headers.get('x-runner-startup-ms');
      if (parsed.startupMs === null && startup !== null && /^[0-9]+$/.test(startup)) {
        parsed.startupMs = Number.parseInt(startup, 10);
      }
      const warm = response.headers.get('x-runner-warm');
      if (parsed.warm === null && (warm === 'true' || warm === 'false')) {
        parsed.warm = warm === 'true';
      }
      return parsed;
    },
  };
}
