import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  hashPassword as scriptHashPassword,
  verifyPassword as scriptVerifyPassword,
} from '../scripts/password.mjs';
import { hashPassword, verifyPassword } from '../src/password';
import { BASE_URL, extractCookie, seedUser } from './helpers';

describe('provisioning password format', () => {
  it('produces the documented format', async () => {
    const hash = await scriptHashPassword('provisioned-password');
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash.split('$')).toHaveLength(4);
  });

  it('is compatible in both directions with the application verifier', async () => {
    const scriptHash = await scriptHashPassword('from-the-script');
    expect(await verifyPassword('from-the-script', scriptHash)).toBe(true);
    expect(await verifyPassword('wrong', scriptHash)).toBe(false);

    const appHash = await hashPassword('from-the-app');
    expect(await scriptVerifyPassword('from-the-app', appHash)).toBe(true);
    expect(await scriptVerifyPassword('wrong', appHash)).toBe(false);
  });

  it('generates a memorable 20-character password with no ambiguous characters', () => {
    const password = generatePassword(20);
    expect(password).toHaveLength(20);
    expect(password).toMatch(/^[A-Za-z0-9]+$/);
    expect(password).not.toMatch(/[IlO0]/);
    expect(generatePassword(20)).not.toBe(password);
  });

  it('lets a user provisioned with the script hash sign in through the app', async () => {
    const email = `provisioned-${crypto.randomUUID()}@example.test`;
    const password = generatePassword(20);
    const passwordHash = await scriptHashPassword(password);
    const user = await seedUser('researcher', { email, password });

    // Replace the helper's hash with the script-generated hash to exercise the
    // exact value a maintainer would write to D1.
    const { env } = await import('cloudflare:test');
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, user.id)
      .run();

    const response = await SELF.fetch(`${BASE_URL}/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
      },
      body: new URLSearchParams({ email, password }).toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    expect(extractCookie(response)).toContain('fl_session=');
  });

  it('rejects malformed and truncated stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$100000$abc')).toBe(false);
    expect(
      await verifyPassword(
        'x',
        'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ),
    ).toBe(false);
    expect(await scriptVerifyPassword('x', 'pbkdf2-sha256$999999999$abc$def')).toBe(false);
  });
});
