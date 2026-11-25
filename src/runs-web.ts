import type { SessionUser } from './auth';
import { requireResearcher } from './guard';
import { htmlResponse, methodNotAllowed } from './http';
import { messagePage } from './html';
import { runPage } from './run-pages';
import {
  getRunTestEvidence,
  getTestRun,
  RunNotFoundError,
} from './runs';

const RUN_PATH = /^\/runs\/([^/]+)$/;
const RUN_TEST_PATH = /^\/runs\/([^/]+)\/tests\/([^/]+)$/;

export async function handleRunsHtml(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== '/runs' && !path.startsWith('/runs/')) return null;

  const guarded = await requireResearcher(request, env, 'html');
  if (!guarded.ok) return guarded.response;
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }

  try {
    const testMatch = RUN_TEST_PATH.exec(path);
    if (testMatch !== null) {
      const runId = testMatch[1] as string;
      const testId = testMatch[2] as string;
      const run = await getTestRun(env.DB, runId);
      const evidence = await getRunTestEvidence(env.DB, runId, testId);
      if (evidence === null) return notFound(guarded.session);
      return htmlResponse(runPage(guarded.session, run, evidence));
    }

    const runMatch = RUN_PATH.exec(path);
    if (runMatch !== null) {
      const run = await getTestRun(env.DB, runMatch[1] as string);
      return htmlResponse(runPage(guarded.session, run, null));
    }
  } catch (error) {
    if (error instanceof RunNotFoundError) return notFound(guarded.session);
    throw error;
  }

  return notFound(guarded.session);
}

function notFound(session: SessionUser): Response {
  return htmlResponse(
    messagePage({
      title: 'Page not found',
      message: 'That test run does not exist.',
      user: session,
    }),
    404,
  );
}
