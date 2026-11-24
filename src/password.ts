export const PASSWORD_SCHEME = 'pbkdf2-sha256';
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordBits(password, salt, PASSWORD_ITERATIONS, HASH_BYTES);
  return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) {
    return false;
  }
  const [scheme, iterationsText, saltText, hashText] = parts;
  if (scheme !== PASSWORD_SCHEME || iterationsText === undefined || saltText === undefined || hashText === undefined) {
    return false;
  }

  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 1_000_000) {
    return false;
  }

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(saltText);
    expected = base64ToBytes(hashText);
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) {
    return false;
  }

  const actual = await derivePasswordBits(password, salt, iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function derivePasswordBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
