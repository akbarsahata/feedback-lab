import { env } from 'cloudflare:test';
import { executeRun } from '../src/coordinator';
import { getDatasetRevision, launchDatasetRun, recordDatasetSignoff } from '../src/dataset-repository';
import { getTestExecutionInput } from '../src/runs';
import type { Runner, RunnerJob } from '../src/runner';

export const DATASET_NOW = '2026-11-27T09:00:00.000Z';
const EVIDENCE_NOTE = 'Checked the rubric, source range, and study tests.';

function tagged(value: unknown): unknown {
  if (value === null) return { kind: 'none' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { kind: 'int', value: String(value) }
      : { kind: 'float', value: String(value) };
  }
  if (typeof value === 'string') return { kind: 'str', value };
  throw new Error('Unsupported fixture value');
}

export function passingRunner(): Runner {
  return {
    async runTest(job: RunnerJob) {
      const input = await getTestExecutionInput(env.DB, job.runId, job.testId);
      if (input === null) throw new Error('Missing test input');
      const common = {
        format: job.format,
        outcome: 'completed' as const,
        actual: null,
        stdout: '',
        stderr: '',
        stdoutValid: true,
        outputTruncated: false,
        diagnostic: null,
        executionMs: 10,
        startupMs: 30,
        warm: false,
      };
      if ('stdin' in input) return { ...common, stdout: input.expectedStdout };
      return { ...common, actual: tagged(JSON.parse(input.expectedReturnJson)) };
    },
  };
}

export async function signEveryCase(revisionId: string, userId: string): Promise<void> {
  const detail = await getDatasetRevision(env.DB, revisionId);
  for (const datasetCase of detail.cases) {
    await recordDatasetSignoff(
      env.DB,
      revisionId,
      datasetCase.caseKey,
      userId,
      EVIDENCE_NOTE,
      DATASET_NOW,
    );
  }
}

export async function runEverySubmission(revisionId: string, userId: string): Promise<void> {
  const detail = await getDatasetRevision(env.DB, revisionId);
  for (const datasetCase of detail.cases) {
    for (const submission of datasetCase.submissions) {
      const launched = await launchDatasetRun(
        env.DB,
        revisionId,
        submission.id,
        userId,
        DATASET_NOW,
      );
      await executeRun({ DB: env.DB }, launched.runId, { runner: passingRunner() });
    }
  }
}
