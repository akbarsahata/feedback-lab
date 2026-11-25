import { handleAssignmentsApi } from './api';
import { executeRun } from './coordinator';
import { reconcileRuns } from './runs';
import { handleRunsHtml } from './runs-web';
import { handleAssignmentsHtml } from './web';
import {
  authenticatedPostError,
  createSession,
  clearSessionCookie,
  deleteSession,
  getSession,
  requestOriginIsAllowed,
  sessionCookie,
  type SessionUser,
} from './auth';
import { formString } from './forms';
import { messagePage, signInPage } from './html';
import { htmlResponse, jsonResponse, localRedirectPath, methodNotAllowed, redirect } from './http';
import { PASSWORD_ITERATIONS, PASSWORD_SCHEME, verifyPassword } from './password.mjs';

const GENERIC_SIGN_IN_ERROR = 'Email or password is incorrect.';
const SIGN_IN_RETRY_AFTER_SECONDS = 60;
// A syntactically valid hash used to spend the same PBKDF2 work when the email
// does not exist, so sign-in timing does not reveal registered accounts.
const DUMMY_PASSWORD_HASH =
  `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: 'internal_error' }, 500);
    }
  },

  async queue(batch: MessageBatch<{ runId?: unknown }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const runId = message.body?.runId;
      if (typeof runId === 'string' && runId !== '') {
        await executeRun(env, runId);
      }
      // #2 has no automatic execution retry: an infrastructure failure is
      // recorded as an incomplete run and recovery uses a new run.
      message.ack();
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reconcileRuns(env.DB, new Date());
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (path === '/sign-in') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return methodNotAllowed('GET, POST');
    }
    // A signed-in visit or submission does not replace or revoke a session.
    if (await getSession(env.DB, request) !== null) return redirect('/assignments');
    return request.method === 'POST'
      ? signIn(request, env)
      : htmlResponse(signInPage({ next: safeNext(url.searchParams.get('next')) }));
  }

  if (path === '/sign-out' && request.method === 'POST') {
    return signOut(request, env);
  }

  if (path === '/api/session' && request.method === 'GET') {
    const session = await getSession(env.DB, request);
    if (session === null) {
      return jsonResponse({ authenticated: false });
    }
    return jsonResponse({
      authenticated: true,
      user: { id: session.id, email: session.email, role: session.role },
      csrfToken: session.csrfToken,
    });
  }

  if (path === '/') {
    return redirect('/assignments');
  }

  const htmlResponseForAssignments = await handleAssignmentsHtml(request, env, path);
  if (htmlResponseForAssignments !== null) {
    return htmlResponseForAssignments;
  }

  if (path === '/api/assignments' || path.startsWith('/api/assignments/')) {
    return handleAssignmentsApi(request, env, path);
  }

  const runsResponse = await handleRunsHtml(request, env, path);
  if (runsResponse !== null) {
    return runsResponse;
  }

  return notFound(request, await getSession(env.DB, request));
}

async function signIn(request: Request, env: Env): Promise<Response> {
  if (!requestOriginIsAllowed(request)) {
    return htmlResponse(signInPage({ error: 'This sign-in request was blocked.' }), 403);
  }

  // The public Cloudflare edge supplies this header. Do not trust forwarded
  // address lists; direct local requests without an edge share a single bucket.
  const clientIp = request.headers.get('CF-Connecting-IP') ?? 'local-no-edge';
  const { success } = await env.SIGN_IN_LIMITER.limit({ key: `feedback-lab:sign-in:${clientIp}` });
  if (!success) {
    return htmlResponse(
      signInPage({ error: 'Too many sign-in attempts. Wait a minute and try again.' }),
      429,
      { 'retry-after': String(SIGN_IN_RETRY_AFTER_SECONDS) },
    );
  }

  const form = await request.formData();
  const email = formString(form, 'email').trim().toLowerCase();
  const password = formString(form, 'password');
  const next = safeNext(formString(form, 'next'));

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, role FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; role: 'researcher' | 'member' }>();

  const passwordMatches = await verifyPassword(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (user === null || !passwordMatches) {
    return htmlResponse(
      signInPage({ error: GENERIC_SIGN_IN_ERROR, email, next }),
      401,
    );
  }

  const session = await createSession(env.DB, user.id);
  return redirect(next, { 'set-cookie': sessionCookie(request, session.token) });
}

async function signOut(request: Request, env: Env): Promise<Response> {
  const session = await getSession(env.DB, request);
  if (session === null) {
    return redirect('/sign-in');
  }

  const form = await request.formData();
  const csrfToken = formString(form, '_csrf');
  if (authenticatedPostError(request, session, csrfToken) !== null) {
    return htmlResponse(
      messagePage({
        title: 'Request blocked',
        message: 'The sign-out request could not be verified. Reload the page and try again.',
        user: session,
      }),
      403,
    );
  }

  await deleteSession(env.DB, session.token);
  return redirect('/sign-in', { 'set-cookie': clearSessionCookie(request) });
}

async function notFound(request: Request, session: SessionUser | null): Promise<Response> {
  if (new URL(request.url).pathname.startsWith('/api/')) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  return htmlResponse(
    messagePage({
      title: 'Page not found',
      message: 'That page does not exist.',
      user: session ?? undefined,
    }),
    404,
  );
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function safeNext(value: string | null): string {
  return localRedirectPath(value) ?? '/assignments';
}
