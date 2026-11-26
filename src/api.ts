import {
  authenticatedPostError,
  type SessionUser,
} from './auth';
import {
  COMPARISON_RULE,
  SCRIPT_COMPARISON_RULE,
  validateConfig,
  type ConfigErrors,
} from './config';
import { requireResearcher } from './guard';
import {
  assignmentsResponseSchema,
  configRequestSchema,
  errorResponseSchema,
  reviseRequestSchema,
  validationErrorResponseSchema,
  versionResponseSchema,
  versionsResponseSchema,
  wrappedCreateRequestSchema,
} from './api-schemas';
import { validatedJsonResponse } from './validated-response';
import type { z } from 'zod';
import {
  AssignmentNotFoundError,
  createAssignment,
  getActiveVersion,
  getVersion,
  listAssignments,
  listVersions,
  reviseAssignment,
  StaleVersionError,
  type AssignmentVersionDetail,
} from './repository';

class InvalidRequestError extends Error {}
class InvalidConfigError extends Error {
  constructor(readonly errors: ConfigErrors) {
    super('Invalid assignment configuration.');
  }
}

export async function handleAssignmentsApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const guarded = await requireResearcher(request, env, 'api');
  if (!guarded.ok) {
    return guarded.response;
  }
  try {
    return await routeAssignmentsApi(request, env, path, guarded.session);
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
    }
    if (error instanceof InvalidRequestError) {
      return validatedJsonResponse(
        errorResponseSchema,
        { error: 'invalid_request', message: error.message },
        400,
      );
    }
    if (error instanceof InvalidConfigError) {
      return invalidConfigResponse(error.errors);
    }
    throw error;
  }
}

async function routeAssignmentsApi(
  request: Request,
  env: Env,
  path: string,
  session: SessionUser,
): Promise<Response> {
  if (path === '/api/assignments') {
    if (request.method === 'GET') {
      return validatedJsonResponse(
        assignmentsResponseSchema,
        { assignments: await listAssignments(env.DB) },
      );
    }
    if (request.method === 'POST') {
      return createHandler(request, env, session);
    }
    return validatedJsonResponse(
      errorResponseSchema,
      { error: 'method_not_allowed' },
      405,
      { allow: 'GET, POST' },
    );
  }

  const versionsMatch = /^\/api\/assignments\/([^/]+)\/versions$/.exec(path);
  if (versionsMatch !== null) {
    const assignmentId = versionsMatch[1] as string;
    if (request.method === 'GET') {
      return validatedJsonResponse(
        versionsResponseSchema,
        { versions: await listVersions(env.DB, assignmentId) },
      );
    }
    if (request.method === 'POST') {
      return reviseHandler(request, env, session, assignmentId);
    }
    return validatedJsonResponse(
      errorResponseSchema,
      { error: 'method_not_allowed' },
      405,
      { allow: 'GET, POST' },
    );
  }

  const versionMatch = /^\/api\/assignments\/([^/]+)\/versions\/([^/]+)$/.exec(path);
  if (versionMatch !== null && request.method === 'GET') {
    const assignmentId = versionMatch[1] as string;
    const versionId = versionMatch[2] as string;
    return versionResponse(await getVersion(env.DB, assignmentId, versionId));
  }

  const assignmentMatch = /^\/api\/assignments\/([^/]+)$/.exec(path);
  if (assignmentMatch !== null && request.method === 'GET') {
    const assignmentId = assignmentMatch[1] as string;
    return versionResponse(await getActiveVersion(env.DB, assignmentId));
  }

  if (
    versionMatch !== null ||
    assignmentMatch !== null
  ) {
    return validatedJsonResponse(
      errorResponseSchema,
      { error: 'method_not_allowed' },
      405,
      { allow: 'GET' },
    );
  }

  return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
}

async function createHandler(
  request: Request,
  env: Env,
  session: SessionUser,
): Promise<Response> {
  const writeError = checkWriteRequest(request, session);
  if (writeError !== null) {
    return writeError;
  }

  const body = await readJsonObject(request);
  const config = Object.hasOwn(body, 'config')
    ? parseRequest(wrappedCreateRequestSchema, body).config
    : parseRequest(configRequestSchema, body);
  const validation = validateConfig(config);
  if (!validation.ok) {
    return invalidConfigResponse(validation.errors);
  }

  const version = await createAssignment(env.DB, validation.config, session.id);
  return versionResponse(version, true);
}

async function reviseHandler(
  request: Request,
  env: Env,
  session: SessionUser,
  assignmentId: string,
): Promise<Response> {
  const writeError = checkWriteRequest(request, session);
  if (writeError !== null) {
    return writeError;
  }

  const { baseVersionId, config } = parseRequest(reviseRequestSchema, await readJsonObject(request));

  const validation = validateConfig(config);
  if (!validation.ok) {
    return invalidConfigResponse(validation.errors);
  }

  try {
    const result = await reviseAssignment(
      env.DB,
      assignmentId,
      baseVersionId,
      validation.config,
      session.id,
    );
    return versionResponse(result.version, result.changed);
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return validatedJsonResponse(
        errorResponseSchema,
        { error: 'stale_version', currentVersionId: error.currentVersionId },
        409,
      );
    }
    throw error;
  }
}

function parseRequest<S extends z.ZodType>(schema: S, body: Record<string, unknown>): z.output<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  const scriptFields: Record<number, Record<string, string>> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path[0] === 'config' ? issue.path.slice(1) : issue.path;
    const [group, row, field] = path;
    if (group === 'tests' && typeof row === 'number' &&
      (field === 'stdin' || field === 'expectedStdout')) {
      const label = field === 'stdin' ? 'Standard input' : 'Expected stdout';
      (scriptFields[row] ??= {})[field] = `${label} must be a string. Send an empty string when blank.`;
    }
  }
  if (Object.keys(scriptFields).length > 0) {
    throw new InvalidConfigError({ tests: { rows: scriptFields } });
  }
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.join('.') : 'body';
  throw new InvalidRequestError(`${path}: ${issue?.message ?? 'Invalid request body.'}`);
}

function invalidConfigResponse(errors: ConfigErrors): Response {
  return validatedJsonResponse(
    validationErrorResponseSchema,
    { error: 'validation_failed', errors },
    400,
  );
}

function checkWriteRequest(request: Request, session: SessionUser): Response | null {
  const error = authenticatedPostError(request, session, request.headers.get('x-csrf-token'));
  return error === null ? null : validatedJsonResponse(errorResponseSchema, { error }, 403);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidRequestError('Request body must be valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function versionResponse(version: AssignmentVersionDetail, changed?: boolean): Response {
  const { criteria, tests, ...metadata } = version;
  const suiteTests = tests.map((test) => test.comparisonRule === COMPARISON_RULE
    ? {
        id: test.id,
        argumentsJson: test.argumentsJson,
        expectedReturnJson: test.expectedReturnJson,
        comparisonRule: test.comparisonRule,
      }
    : {
        id: test.id,
        stdin: test.stdin,
        expectedStdout: test.expectedStdout,
        comparisonRule: test.comparisonRule,
      });
  const body = {
    ...(changed === undefined ? {} : { changed }),
    version: {
      ...metadata,
      rubric: {
        versionId: version.rubricVersionId,
        criteria,
      },
      testSuite: {
        versionId: version.testSuiteVersionId,
        comparisonRule: version.format === 'script'
          ? SCRIPT_COMPARISON_RULE
          : COMPARISON_RULE,
        tests: suiteTests,
      },
    },
  };
  return validatedJsonResponse(versionResponseSchema, body, changed ? 201 : 200);
}
