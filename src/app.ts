import { handleAssignmentsApi } from './api';
import {
  createSession,
  clearSessionCookie,
  csrfTokenIsValid,
  deleteSession,
  getSession,
  requestOriginIsAllowed,
  sessionCookie,
  type SessionUser,
} from './auth';
import { messagePage, signInPage } from './html';
import { htmlResponse, jsonResponse, methodNotAllowed, redirect } from './http';
import { verifyPassword } from './password';

const GENERIC_SIGN_IN_ERROR = 'Email or password is incorrect.';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: 'internal_error' }, 500);
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (path === '/sign-in') {
    if (request.method === 'GET') {
      const session = await getSession(env.DB, request);
      if (session !== null) {
        return redirect('/assignments');
      }
      return htmlResponse(signInPage({ next: safeNext(url.searchParams.get('next')) }));
    }
    if (request.method === 'POST') {
      return signIn(request, env);
    }
    return methodNotAllowed('GET, POST');
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

  if (path === '/api/assignments' || path.startsWith('/api/assignments/')) {
    return handleAssignmentsApi(request, env, path);
  }

  return notFound(request, await getSession(env.DB, request));
}

async function signIn(request: Request, env: Env): Promise<Response> {
  if (!requestOriginIsAllowed(request)) {
    return htmlResponse(signInPage({ error: 'This sign-in request was blocked.' }), 403);
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

  const passwordMatches =
    user !== null && (await verifyPassword(password, user.password_hash));
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
  if (!requestOriginIsAllowed(request) || !csrfTokenIsValid(session, csrfToken)) {
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

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function safeNext(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) {
    return '/assignments';
  }
  return value;
}


