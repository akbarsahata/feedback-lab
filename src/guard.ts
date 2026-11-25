import { getSession, type SessionUser } from './auth';
import { messagePage } from './html';
import { htmlResponse, jsonResponse, redirect } from './http';

export type Guarded =
  | { ok: true; session: SessionUser }
  | { ok: false; response: Response };

export async function requireResearcher(
  request: Request,
  env: Env,
  mode: 'html' | 'api',
): Promise<Guarded> {
  const session = await getSession(env.DB, request);

  if (session === null) {
    if (mode === 'api') {
      return { ok: false, response: jsonResponse({ error: 'unauthenticated' }, 401) };
    }
    const url = new URL(request.url);
    const next = encodeURIComponent(`${url.pathname}${url.search}`);
    return { ok: false, response: redirect(`/sign-in?next=${next}`) };
  }

  if (session.role !== 'researcher') {
    if (mode === 'api') {
      return { ok: false, response: jsonResponse({ error: 'forbidden' }, 403) };
    }
    return {
      ok: false,
      response: htmlResponse(
        messagePage({
          title: 'Researcher access required',
          message:
            'You are signed in, but this account does not have researcher access. Ask a maintainer to grant access.',
          user: session,
        }),
        403,
      ),
    };
  }

  return { ok: true, session };
}
