import { errorResponseSchema, openApiDocument } from './api-schemas';
import { requireResearcher } from './guard';
import { htmlResponse, jsonResponse } from './http';
import { validatedJsonResponse } from './validated-response';

const DOCS_PATH = '/api/docs';
const SPEC_PATH = '/api/openapi.json';
const ASSET_PREFIX = '/api/docs/';

// Swagger UI loads same-origin scripts and styles from this page.
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ALLOWED_ASSETS = new Set([
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'LICENSE',
  'NOTICE',
]);

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback Lab API docs</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css">
</head>
<body>
<header style="font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px 22px;border-bottom:1px solid #d7dee8;background:#fff">
  <strong>Feedback Lab JSON API</strong>
  <span style="color:#546176">Researcher access is required. The session cookie is sent automatically. Writes need <code>X-CSRF-Token</code> from <code>GET /api/session</code> and a matching <code>Origin</code>. Try it out is limited to GET; write examples in the operation descriptions are documentation only.</span>
  <a href="/assignments" style="margin-left:12px">Back to assignments</a>
</header>
<div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script>
<script src="/api/docs/swagger-ui-standalone-preset.js"></script>
<script>
window.addEventListener('load', () => {
  window.ui = SwaggerUIBundle({
    url: '/api/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    supportedSubmitMethods: ['get'],
    tryItOutEnabled: false,
    validatorUrl: null,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout'
  });
});
</script>
</body>
</html>`;

export async function handleApiDocs(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== DOCS_PATH && path !== SPEC_PATH && !path.startsWith(ASSET_PREFIX)) {
    return null;
  }

  const guarded = await requireResearcher(request, env, 'api');
  if (!guarded.ok) return guarded.response;

  if (request.method !== 'GET') {
    return validatedJsonResponse(
      errorResponseSchema,
      { error: 'method_not_allowed' },
      405,
      { allow: 'GET' },
    );
  }

  if (path === SPEC_PATH) {
    return jsonResponse(openApiDocument());
  }

  if (path === DOCS_PATH) {
    return htmlResponse(DOCS_HTML, 200, { 'content-security-policy': DOCS_CSP });
  }

  const asset = path.slice(ASSET_PREFIX.length);
  if (!ALLOWED_ASSETS.has(asset)) {
    return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
  }
  if (env.ASSETS === undefined) {
    return validatedJsonResponse(errorResponseSchema, { error: 'internal_error' }, 500);
  }

  const response = await env.ASSETS.fetch(request);
  if (!response.ok) {
    return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
  }
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
