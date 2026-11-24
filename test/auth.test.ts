import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  BASE_URL,
  TEST_PASSWORD,
  getCookieAttributes,
  seedUser,
  signIn,
} from './helpers';

async function sessionFor(cookie: string) {
  const response = await SELF.fetch(`${BASE_URL}/api/session`, {
    headers: { cookie },
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      authenticated: boolean;
      user?: { email: string; role: string };
      csrfToken?: string;
    },
  };
}

describe('sign-in', () => {
  it('shows a sign-in form with no public sign-up or account list', async () => {
    const response = await SELF.fetch(`${BASE_URL}/sign-in`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('Sign in');
    expect(html.toLowerCase()).not.toContain('sign up');
    expect(html.toLowerCase()).not.toContain('create account');
  });

  it('signs in a researcher and issues a hardened session cookie', async () => {
    const user = await seedUser('researcher');
    const response = await SELF.fetch(`${BASE_URL}/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
      },
      body: new URLSearchParams({ email: user.email, password: user.password }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/assignments');

    const attributes = getCookieAttributes(response);
    expect(attributes).toContain('fl_session=');
    expect(attributes).toContain('HttpOnly');
    expect(attributes).toContain('SameSite=Lax');
    expect(attributes).toContain('Secure');
    expect(attributes).toContain('Path=/');

    const cookie = attributes.split(';')[0]!;
    const session = await sessionFor(cookie);
    expect(session.status).toBe(200);
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user?.email).toBe(user.email);
    expect(session.body.user?.role).toBe('researcher');
    expect(session.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(session.body)).not.toContain(user.password);
  });

  it('stores only a hash of the session token', async () => {
    const user = await seedUser();
    const session = await signIn(user);
    const token = session.cookie.slice('fl_session='.length);

    const row = await env.DB.prepare('SELECT token_hash FROM sessions').first<{
      token_hash: string;
    }>();
    expect(row?.token_hash).toBeDefined();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the same generic failure for a wrong password and an unknown email', async () => {
    const user = await seedUser();

    const wrongPassword = await SELF.fetch(`${BASE_URL}/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
      },
      body: new URLSearchParams({ email: user.email, password: 'wrong-password' }).toString(),
      redirect: 'manual',
    });
    const wrongBody = await wrongPassword.text();

    const unknownEmail = await SELF.fetch(`${BASE_URL}/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
      },
      body: new URLSearchParams({
        email: 'nobody@example.test',
        password: TEST_PASSWORD,
      }).toString(),
      redirect: 'manual',
    });
    const unknownBody = await unknownEmail.text();

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongBody).toContain('Email or password is incorrect.');
    expect(unknownBody).toContain('Email or password is incorrect.');
    expect(wrongPassword.headers.get('set-cookie')).toBeNull();
    expect(unknownEmail.headers.get('set-cookie')).toBeNull();
  });

  it('redirects an already signed-in user away from the sign-in page', async () => {
    const session = await signIn(await seedUser());
    const response = await SELF.fetch(`${BASE_URL}/sign-in`, {
      headers: { cookie: session.cookie },
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/assignments');
  });
});

describe('sessions', () => {
  it('does not authenticate a tampered cookie', async () => {
    const user = await seedUser();
    const session = await signIn(user);
    const tampered = `${session.cookie.slice(0, -2)}xx`;

    const result = await sessionFor(tampered);
    expect(result.status).toBe(200);
    expect(result.body.authenticated).toBe(false);
  });

  it('does not authenticate an expired session', async () => {
    const user = await seedUser();
    const session = await signIn(user);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?')
      .bind('2000-01-01T00:00:00.000Z')
      .run();

    const result = await sessionFor(session.cookie);
    expect(result.body.authenticated).toBe(false);
  });

  it('signs out and invalidates the session', async () => {
    const session = await signIn(await seedUser());

    const response = await SELF.fetch(`${BASE_URL}/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: session.cookie,
        origin: BASE_URL,
      },
      body: new URLSearchParams({ _csrf: session.csrfToken }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/sign-in');
    expect(getCookieAttributes(response)).toContain('Max-Age=0');

    const result = await sessionFor(session.cookie);
    expect(result.body.authenticated).toBe(false);
  });

  it('rejects sign-out without a valid CSRF token', async () => {
    const session = await signIn(await seedUser());

    const response = await SELF.fetch(`${BASE_URL}/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: session.cookie,
        origin: BASE_URL,
      },
      body: new URLSearchParams({ _csrf: 'not-the-token' }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(403);
    const result = await sessionFor(session.cookie);
    expect(result.body.authenticated).toBe(true);
  });

  it('rejects an authenticated POST whose Origin does not match', async () => {
    const session = await signIn(await seedUser());

    const response = await SELF.fetch(`${BASE_URL}/sign-out`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: session.cookie,
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ _csrf: session.csrfToken }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(403);
    const result = await sessionFor(session.cookie);
    expect(result.body.authenticated).toBe(true);
  });

  it('rejects a sign-in POST from a foreign origin', async () => {
    const user = await seedUser();

    const response = await SELF.fetch(`${BASE_URL}/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ email: user.email, password: user.password }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
