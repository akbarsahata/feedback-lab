import { markRunIncomplete } from './runs';

/**
 * Publishes a committed run for background execution. A publication failure is
 * made terminal rather than retried, matching #2's no-automatic-retry scope.
 * When no queue is bound (local development), the run stays queued for a
 * maintainer to wire a runner; it is never reported as executed.
 */
export async function dispatchRun(
  env: Env,
  runId: string,
  now: Date = new Date(),
): Promise<void> {
  if (env.TEST_RUN_QUEUE === undefined || env.RUNNER === undefined) return;
  try {
    await env.TEST_RUN_QUEUE.send({ runId });
  } catch {
    await markRunIncomplete(
      env.DB,
      runId,
      'The test run could not be dispatched to the runner.',
      now.toISOString(),
    );
  }
}
