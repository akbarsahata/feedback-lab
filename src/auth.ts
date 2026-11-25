import { constantTimeEqual } from './password';

export const SESSION_COOKIE = 'fl_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export type Role = 'researcher' | 'member';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  csrfToken: string;
  token: string;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export async function createSession(
  db: D1Database,
  userId: string,
  now: Date = new Date(),
): Promise<CreatedSession> {
  const token = randomToken();
  const csrfToken = randomToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  await db
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(await sha256Hex(token), userId, csrfToken, createdAt, expiresAt)
    .run();

  return { token, csrfToken, expiresAt };
}

export async function getSession(
  db: D1Database,
  request: Request,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null || token === '') {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT s.csrf_token, s.expires_at, u.id, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first<{
      csrf_token: string;
      expires_at: string;
      id: string;
      email: string;
      role: Role;
    }>();

  if (row === null || row.expires_at <= now.toISOString()) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    csrfToken: row.csrf_token,
    token,
  };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export function sessionCookie(request: Request, token: string): string {
  return cookie(request, `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}`);
}

export function clearSessionCookie(request: Request): string {
  return cookie(request, `${SESSION_COOKIE}=; Max-Age=0`);
}

function cookie(request: Request, value: string): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${value}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function requestOriginIsAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) {
    return true;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function csrfTokenIsValid(session: SessionUser, provided: string | null): boolean {
  if (provided === null || provided === '') {
    return false;
  }
  return constantTimeEqual(new TextEncoder().encode(provided), new TextEncoder().encode(session.csrfToken));
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
