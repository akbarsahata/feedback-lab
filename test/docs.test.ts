import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  assignmentsResponseSchema,
  errorResponseSchema,
  sessionResponseSchema,
  validationErrorResponseSchema,
  versionResponseSchema,
  versionsResponseSchema,
} from '../src/api-schemas';
import { validatedJsonResponse } from '../src/validated-response';
import {
  apiJson,
  countRows,
  postJson,
  seedUser,
  signIn,
  type SignedIn,
} from './helpers';
import { assignmentConfig, scriptConfig, type SerializedVersion } from './fixtures';

const BASE_URL = 'https://feedback-lab.test';

async function get(path: string, session?: SignedIn): Promise<Response> {
  return SELF.fetch(`${BASE_URL}${path}`, {
    headers: session === undefined ? {} : { cookie: session.cookie },
  });
}

describe('generated OpenAPI and docs access', () => {
  it('serves an OpenAPI 3.1 document with both assignment formats and the shared error bodies', async () => {
    const researcher = await signIn(await seedUser());
    const response = await get('/api/openapi.json', researcher);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const document = (await response.json()) as any;

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Feedback Lab JSON API');
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      '/api/session',
      '/api/assignments',
      '/api/assignments/{assignmentId}',
      '/api/assignments/{assignmentId}/versions',
      '/api/assignments/{assignmentId}/versions/{versionId}',
    ]));
    expect(document.components.securitySchemes.cookieAuth).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'fl_session',
    });
    expect(document.components.schemas.ScriptTestRequest.required).toEqual([
      'id', 'stdin', 'expectedStdout',
    ]);
    const serialized = JSON.stringify(document);
    expect(serialized).toContain('script');
    expect(serialized).toContain('stdin');
    expect(serialized).toContain('expectedStdout');
    expect(serialized).toContain('argumentsJson');
    expect(serialized).toContain('expectedReturnJson');
    expect(serialized).toContain('CSRF');
  });

  it('serves self-hosted Swagger UI configured for GET-only try-it-out', async () => {
    const researcher = await signIn(await seedUser());
    const page = await get('/api/docs', researcher);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('supportedSubmitMethods: [\'get\']');
    expect(html).toContain('/api/openapi.json');
    expect(html).toContain('X-CSRF-Token');
    expect(html).not.toContain('https://');

    const bundle = await get('/api/docs/swagger-ui-bundle.js', researcher);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('content-type')).toContain('javascript');
    await bundle.body?.cancel();

    const stylesheet = await get('/api/docs/swagger-ui.css', researcher);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-type')).toContain('text/css');
    await stylesheet.body?.cancel();
  });

  it('denies signed-out users and members on the spec, docs page, and assets', async () => {
    const member = await signIn(await seedUser('member'));
    for (const path of [
      '/api/openapi.json',
      '/api/docs',
      '/api/docs/swagger-ui-bundle.js',
      '/api/docs/swagger-ui.css',
    ]) {
      const signedOut = await get(path);
      expect(signedOut.status).toBe(401);
      expect(await signedOut.text()).toContain('unauthenticated');

      const memberResponse = await apiJson(path, { session: member });
      expect(memberResponse.response.status).toBe(403);
      expect(memberResponse.body).toEqual({ error: 'forbidden' });
    }
  });
});

describe('schemas validate real API responses', () => {
  it('validates session, function, script, list, history, and documented error bodies', async () => {
    const researcher = await signIn(await seedUser());

    const session = await apiJson('/api/session', { session: researcher });
    expect(sessionResponseSchema.safeParse(session.body).success).toBe(true);

    const createdFunction = await postJson('/api/assignments', {
      config: assignmentConfig(),
    }, researcher);
    expect(createdFunction.response.status).toBe(201);
    expect(versionResponseSchema.safeParse(createdFunction.body).success).toBe(true);
    const functionVersion = createdFunction.body.version as SerializedVersion;

    const createdScript = await postJson('/api/assignments', {
      config: scriptConfig(),
    }, researcher);
    expect(createdScript.response.status).toBe(201);
    expect(versionResponseSchema.safeParse(createdScript.body).success).toBe(true);
    const scriptVersion = createdScript.body.version as SerializedVersion;

    const library = await apiJson('/api/assignments', { session: researcher });
    expect(assignmentsResponseSchema.safeParse(library.body).success).toBe(true);
    expect(library.body.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: functionVersion.assignmentId, format: 'function' }),
      expect.objectContaining({ id: scriptVersion.assignmentId, format: 'script' }),
    ]));

    const history = await apiJson(
      `/api/assignments/${functionVersion.assignmentId}/versions`,
      { session: researcher },
    );
    expect(versionsResponseSchema.safeParse(history.body).success).toBe(true);

    const notFound = await apiJson(`/api/assignments/${crypto.randomUUID()}`, {
      session: researcher,
    });
    expect(notFound.response.status).toBe(404);
    expect(errorResponseSchema.safeParse(notFound.body).success).toBe(true);

    const invalid = await postJson('/api/assignments', {
      config: scriptConfig({ tests: [{ id: 'missing' }] }),
    }, researcher);
    expect(invalid.response.status).toBe(400);
    expect(validationErrorResponseSchema.safeParse(invalid.body).success).toBe(true);
    expect(await countRows('assignments')).toBe(2);
  });

  it('returns a generic server error instead of sending an invalid outgoing payload', async () => {
    const response = validatedJsonResponse(sessionResponseSchema, {
      authenticated: 'not-a-boolean',
      user: { id: 'secret-user' },
      csrfToken: 'secret-token',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('preserves lossless numeric text without sending decoded function values', async () => {
    const researcher = await signIn(await seedUser());
    const { body } = await postJson('/api/assignments', {
      config: assignmentConfig({
        tests: [{
          id: 'numbers',
          arguments: '[1, 1.0, -0.0]',
          expectedReturn: '{"big":100000000000000000000.0,"x":1.0}',
        }],
      }),
    }, researcher);
    expect(versionResponseSchema.safeParse(body).success).toBe(true);
    const test = body.version.testSuite.tests[0];
    expect(test.argumentsJson).toBe('[1,1.0,-0.0]');
    expect(test.expectedReturnJson).toBe('{"big":100000000000000000000.0,"x":1.0}');
    expect(test).not.toHaveProperty('arguments');
    expect(test).not.toHaveProperty('expectedReturn');
  });
});
