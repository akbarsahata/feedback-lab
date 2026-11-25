// @ts-check
export const PASSWORD_SCHEME = 'pbkdf2-sha256';
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + 'abcdefghijkmnopqrstuvwxyz' + '123456789';

/** @param {string} password */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordBits(password, salt, PASSWORD_ITERATIONS, HASH_BYTES);
  return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/**
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
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

  let salt;
  let expected;
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

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function generatePassword(length = 20) {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let password = '';
  while (password.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      password += PASSWORD_ALPHABET.charAt(byte % PASSWORD_ALPHABET.length);
      if (password.length === length) break;
    }
  }
  return password;
}

/**
 * @param {string} password
 * @param {Uint8Array<ArrayBuffer>} salt
 * @param {number} iterations
 * @param {number} length
 */
async function derivePasswordBits(password, salt, iterations, length) {
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

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** @param {string} value */
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
