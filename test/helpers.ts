import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '../src/password';

export const BASE_URL = 'https://feedback-lab.test';
export const TEST_PASSWORD = 'feedback-lab-test-password';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: 'researcher' | 'member';
}

export async function seedUser(
  role: 'researcher' | 'member' = 'researcher',
  options: { email?: string; password?: string } = {},
): Promise<TestUser> {
  const id = crypto.randomUUID();
  const email = options.email ?? `${role}-${id}@example.test`;
  const password = options.password ?? TEST_PASSWORD;
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, email, passwordHash, role, new Date().toISOString())
    .run();

  return { id, email, password, role };
}

export interface SignedIn {
  user: TestUser;
  cookie: string;
  csrfToken: string;
}

export async function signIn(user: TestUser): Promise<SignedIn> {
  const response = await SELF.fetch(`${BASE_URL}/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
    },
    body: new URLSearchParams({ email: user.email, password: user.password }).toString(),
    redirect: 'manual',
  });

  if (response.status !== 303) {
    throw new Error(`Sign-in failed with ${response.status}: ${await response.text()}`);
  }

  const cookie = extractCookie(response);
  const sessionResponse = await SELF.fetch(`${BASE_URL}/api/session`, {
    headers: { cookie },
  });
  const session = (await sessionResponse.json()) as {
    authenticated: boolean;
    csrfToken?: string;
  };
  if (!session.authenticated || session.csrfToken === undefined) {
    throw new Error('Sign-in did not produce an authenticated session.');
  }

  return { user, cookie, csrfToken: session.csrfToken };
}

export function extractCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) {
    throw new Error('Response did not set a cookie.');
  }
  const cookie = setCookie.split(';')[0];
  if (cookie === undefined) {
    throw new Error(`Could not parse Set-Cookie header: ${setCookie}`);
  }
  return cookie;
}

export function getCookieAttributes(response: Response): string {
  return response.headers.get('set-cookie') ?? '';
}

export async function apiFetch(
  path: string,
  init: RequestInit & { session?: SignedIn } = {},
): Promise<Response> {
  const { session, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('origin')) {
    headers.set('origin', BASE_URL);
  }
  if (session !== undefined) {
    headers.set('cookie', session.cookie);
  }
  return SELF.fetch(`${BASE_URL}${path}`, { ...rest, headers });
}

export async function apiJson(
  path: string,
  init: RequestInit & { session?: SignedIn } = {},
): Promise<{ response: Response; body: any }> {
  const response = await apiFetch(path, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${path}, got ${response.status}: ${text}`);
  }
  return { response, body };
}

export async function postJson(
  path: string,
  payload: unknown,
  session: SignedIn,
): Promise<{ response: Response; body: any }> {
  return apiJson(path, {
    method: 'POST',
    session,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify(payload),
  });
}

export async function postForm(
  path: string,
  fields: Record<string, string | string[]>,
  session: SignedIn,
  options: { includeCsrf?: boolean } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (options.includeCsrf !== false) {
    params.set('_csrf', session.csrfToken);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, value);
    }
  }

  return SELF.fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
      origin: BASE_URL,
    },
    body: params.toString(),
    redirect: 'manual',
  });
}

export async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE assignments SET active_version_id = NULL'),
    env.DB.prepare('DELETE FROM assignment_versions'),
    env.DB.prepare('DELETE FROM assignments'),
    env.DB.prepare('DELETE FROM rubric_criteria'),
    env.DB.prepare('DELETE FROM rubric_versions'),
    env.DB.prepare('DELETE FROM tests'),
    env.DB.prepare('DELETE FROM test_suite_versions'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
}

export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}
