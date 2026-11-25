const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // Keep the Origin on same-origin browser form POSTs for CSRF validation.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
};

function headersWith(extra: Record<string, string> | undefined): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      headers.set(key, value);
    }
  }
  return headers;
}

export function htmlResponse(
  body: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = headersWith(extraHeaders);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
}

const LOCAL_BASE = new URL('https://feedback-lab.invalid');

export function localRedirectPath(value: string | null): string | null {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const target = new URL(value, LOCAL_BASE);
    if (target.origin !== LOCAL_BASE.origin || target.pathname.startsWith('//')) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export function redirect(location: string, extraHeaders?: Record<string, string>): Response {
  const local = localRedirectPath(location);
  if (local === null) throw new Error('Redirect requires a same-origin path');
  return new Response(null, {
    status: 303,
    headers: headersWith({ ...extraHeaders, location: local }),
  });
}

export function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonTextResponse(JSON.stringify(value), status, extraHeaders);
}

export function jsonTextResponse(
  body: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = headersWith(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(body, { status, headers });
}

export function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { allow });
}
