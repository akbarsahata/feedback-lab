import { RUN_LIMITS, type RunLimits } from './runs';
import type { AssignmentFormat } from './config';

export const RUNNER_PROTOCOL = 2;
export const MAX_ACTUAL_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = RUN_LIMITS.outputBytes;
export const MAX_RUNNER_RESPONSE_BYTES = MAX_ACTUAL_BYTES + 128 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2000;
const RUNNER_REQUEST_TIMEOUT_MS = 60_000;

interface RunnerJobBase {
  protocol: typeof RUNNER_PROTOCOL;
  runId: string;
  testId: string;
  source: string;
  pythonRelease: string;
  runnerArtifact: string;
  limits: RunLimits;
}

export interface FunctionRunnerJob extends RunnerJobBase {
  format: 'function';
  entryPoint: string;
  argumentsJson: string;
}

export interface ScriptRunnerJob extends RunnerJobBase {
  format: 'script';
  stdin: string;
}

export type RunnerJob = FunctionRunnerJob | ScriptRunnerJob;

export type RunnerOutcome =
  | 'completed'
  | 'execution_error'
  | 'timed_out'
  | 'memory_limit'
  | 'output_limit';

export interface RunnerResult {
  format: AssignmentFormat;
  outcome: RunnerOutcome;
  actual: unknown;
  stdout: string;
  stderr: string;
  stdoutValid: boolean;
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
  job: Pick<RunnerJob, 'protocol' | 'runId' | 'testId' | 'limits' | 'runnerArtifact' | 'format'>,
): RunnerResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunnerProtocolError('Runner response must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== job.protocol) {
    throw new RunnerProtocolError('Runner protocol version is not supported.');
  }
  if (
    record.runId !== job.runId ||
    record.testId !== job.testId ||
    record.runnerArtifact !== job.runnerArtifact
  ) {
    throw new RunnerProtocolError('Runner response identity does not match the job.');
  }
  if (record.format !== job.format) {
    throw new RunnerProtocolError('Runner response format does not match the job.');
  }
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome)) {
    throw new RunnerProtocolError('Runner response has an unknown outcome.');
  }

  const stdout = runnerText(record.stdout, 'stdout', job.format === 'script');
  const stderr = runnerText(record.stderr, 'stderr', job.format === 'script');
  const stdoutValid = job.format === 'script'
    ? requiredBoolean(record.stdoutValid, 'stdoutValid')
    : record.stdoutValid === undefined || requiredBoolean(record.stdoutValid, 'stdoutValid');
  const encoder = new TextEncoder();
  const stdoutBytes = encoder.encode(stdout).byteLength;
  const stderrBytes = encoder.encode(stderr).byteLength;
  const outputCap = Math.min(job.limits.outputBytes, MAX_OUTPUT_BYTES);
  if (job.format === 'script') {
    const capturedBytes = optionalInteger(record.capturedOutputBytes, 'capturedOutputBytes');
    const stderrValid = requiredBoolean(record.stderrValid, 'stderrValid');
    const minimumCaptured = Math.ceil(stdoutBytes / (stdoutValid ? 1 : 3))
      + Math.ceil(stderrBytes / (stderrValid ? 1 : 3));
    if (capturedBytes === null || capturedBytes < minimumCaptured
      || capturedBytes > stdoutBytes + stderrBytes || capturedBytes > outputCap) {
      throw new RunnerProtocolError('Runner script response violates the configured output cap.');
    }
  } else if (stdoutBytes + stderrBytes > outputCap) {
    throw new RunnerProtocolError('Runner response exceeds the configured output cap.');
  }
  if (job.format === 'script') requiredBoolean(record.outputTruncated, 'outputTruncated');
  const outputTruncated = record.outputTruncated === true;
  const diagnostic = optionalDiagnostic(record.diagnostic);
  const executionMs = optionalInteger(record.executionMs, 'executionMs');
  const startupMs = optionalInteger(record.startupMs, 'startupMs');
  const warm = parseWarm(record.warm);

  if (record.outcome === 'completed') {
    if (job.format === 'script') {
      if (record.actual !== undefined && record.actual !== null) {
        throw new RunnerProtocolError('A completed script must not include a function return value.');
      }
      return {
        format: 'script',
        outcome: 'completed',
        actual: null,
        stdout,
        stderr,
        stdoutValid,
        outputTruncated,
        diagnostic,
        executionMs,
        startupMs,
        warm,
      };
    }
    if (!Object.hasOwn(record, 'actual')) {
      throw new RunnerProtocolError('A completed test must include an actual value.');
    }
    const encoded = JSON.stringify(record.actual);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_ACTUAL_BYTES) {
      throw new RunnerProtocolError('Runner actual value exceeds the configured return budget.');
    }
    return {
      format: 'function',
      outcome: 'completed',
      actual: record.actual,
      stdout,
      stderr,
      stdoutValid,
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
    format: job.format,
    outcome: record.outcome as RunnerOutcome,
    actual: null,
    stdout,
    stderr,
    stdoutValid,
    outputTruncated,
    diagnostic,
    executionMs,
    startupMs,
    warm,
  };
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RunnerProtocolError(`Runner ${field} flag must be a boolean.`);
  }
  return value;
}

function parseWarm(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new RunnerProtocolError('Runner warm flag must be a boolean.');
  }
  return value;
}

function runnerText(value: unknown, field: string, required: boolean): string {
  if (!required && (value === undefined || value === null)) return '';
  if (typeof value !== 'string') {
    throw new RunnerProtocolError(`Runner ${field} must be a string.`);
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
        headers: {
          'content-type': 'application/json',
          'x-run-id': job.runId,
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new RunnerUnavailableError(`Runner returned HTTP ${response.status}.`);
      }
      let value: unknown;
      try {
        value = JSON.parse(await readBoundedResponse(response));
      } catch (error) {
        if (error instanceof RunnerProtocolError) throw error;
        throw new RunnerProtocolError('Runner returned invalid JSON.');
      }
      const parsed = parseRunnerResult(value, job);
      // A container adapter can report cold-start readiness separately from the
      // Python execution clock. The Python service itself leaves this absent.
      const startup = response.headers.get('x-runner-startup-ms');
      if (startup !== null && /^[0-9]+$/.test(startup)) {
        // The container adapter measures cold-start readiness, which is wider
        // than the Python service's own process-start timestamp.
        parsed.startupMs = Number.parseInt(startup, 10);
      }
      const warm = response.headers.get('x-runner-warm');
      if (warm === 'true' || warm === 'false') {
        parsed.warm = warm === 'true';
      }
      return parsed;
    },
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (!Number.isFinite(size) || size > MAX_RUNNER_RESPONSE_BYTES) {
      throw new RunnerProtocolError('Runner response exceeds the configured size bound.');
    }
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RUNNER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RunnerProtocolError('Runner response exceeds the configured size bound.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}
