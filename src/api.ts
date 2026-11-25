import {
  csrfTokenIsValid,
  requestOriginIsAllowed,
  type SessionUser,
} from './auth';
import {
  COMPARISON_RULE,
  validateConfig,
  type RawConfig,
  type RawCriterion,
  type RawTest,
} from './config';
import { requireResearcher } from './guard';
import { jsonResponse } from './http';
import { parseJsonValue } from './json';
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

export async function handleAssignmentsApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const guarded = await requireResearcher(request, env, 'api');
  if (!guarded.ok) {
    return guarded.response;
  }
  const session = guarded.session;

  if (path === '/api/assignments') {
    if (request.method === 'GET') {
      return jsonResponse({ assignments: await listAssignments(env.DB) });
    }
    if (request.method === 'POST') {
      return createHandler(request, env, session);
    }
    return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  }

  const versionsMatch = /^\/api\/assignments\/([^/]+)\/versions$/.exec(path);
  if (versionsMatch !== null) {
    const assignmentId = versionsMatch[1] as string;
    if (request.method === 'GET') {
      return wrapNotFound(async () =>
        jsonResponse({ versions: await listVersions(env.DB, assignmentId) }),
      );
    }
    if (request.method === 'POST') {
      return reviseHandler(request, env, session, assignmentId);
    }
    return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  }

  const versionMatch = /^\/api\/assignments\/([^/]+)\/versions\/([^/]+)$/.exec(path);
  if (versionMatch !== null && request.method === 'GET') {
    const assignmentId = versionMatch[1] as string;
    const versionId = versionMatch[2] as string;
    return wrapNotFound(async () =>
      jsonResponse({ version: serializeVersion(await getVersion(env.DB, assignmentId, versionId)) }),
    );
  }

  const assignmentMatch = /^\/api\/assignments\/([^/]+)$/.exec(path);
  if (assignmentMatch !== null && request.method === 'GET') {
    const assignmentId = assignmentMatch[1] as string;
    return wrapNotFound(async () =>
      jsonResponse({
        version: serializeVersion(await getActiveVersion(env.DB, assignmentId)),
      }),
    );
  }

  if (
    versionsMatch !== null ||
    versionMatch !== null ||
    assignmentMatch !== null
  ) {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  }

  return jsonResponse({ error: 'not_found' }, 404);
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

  let config: RawConfig;
  try {
    config = await readConfigBody(request);
  } catch (error) {
    return invalidRequest(error);
  }

  const validation = validateConfig(config);
  if (!validation.ok) {
    return jsonResponse({ error: 'validation_failed', errors: validation.errors }, 400);
  }

  const version = await createAssignment(env.DB, validation.config, session.id);
  return jsonResponse({ changed: true, version: serializeVersion(version) }, 201);
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

  let body: Record<string, unknown>;
  let config: RawConfig;
  let baseVersionId: string;
  try {
    body = await readJsonObject(request);
    const base = body.baseVersionId;
    if (typeof base !== 'string' || base.trim() === '') {
      throw new InvalidRequestError('baseVersionId is required.');
    }
    baseVersionId = base;
    config = readConfig(configValue(body));
  } catch (error) {
    return invalidRequest(error);
  }

  const validation = validateConfig(config);
  if (!validation.ok) {
    return jsonResponse({ error: 'validation_failed', errors: validation.errors }, 400);
  }

  try {
    const result = await reviseAssignment(
      env.DB,
      assignmentId,
      baseVersionId,
      validation.config,
      session.id,
    );
    return jsonResponse(
      { changed: result.changed, version: serializeVersion(result.version) },
      result.changed ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return jsonResponse(
        { error: 'stale_version', currentVersionId: error.currentVersionId },
        409,
      );
    }
    if (error instanceof AssignmentNotFoundError) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    throw error;
  }
}

function checkWriteRequest(request: Request, session: SessionUser): Response | null {
  if (!requestOriginIsAllowed(request)) {
    return jsonResponse({ error: 'invalid_origin' }, 403);
  }
  if (!csrfTokenIsValid(session, request.headers.get('x-csrf-token'))) {
    return jsonResponse({ error: 'invalid_csrf' }, 403);
  }
  return null;
}

async function readConfigBody(request: Request): Promise<RawConfig> {
  const body = await readJsonObject(request);
  return readConfig(configValue(body));
}

function configValue(body: Record<string, unknown>): unknown {
  return Object.hasOwn(body, 'config') ? body.config : body;
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

function readConfig(value: unknown): RawConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError('config must be a JSON object.');
  }
  const input = value as Record<string, unknown>;

  const criteriaValue = input.criteria ?? [];
  const testsValue = input.tests ?? [];
  if (!Array.isArray(criteriaValue)) {
    throw new InvalidRequestError('config.criteria must be an array.');
  }
  if (!Array.isArray(testsValue)) {
    throw new InvalidRequestError('config.tests must be an array.');
  }

  return {
    title: readString(input.title, 'config.title'),
    description: readString(input.description, 'config.description'),
    entryPoint: readString(input.entryPoint, 'config.entryPoint'),
    criteria: criteriaValue.map((row, index) => readCriterion(row, index)),
    tests: testsValue.map((row, index) => readTest(row, index)),
  };
}

function readCriterion(value: unknown, index: number): RawCriterion {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`config.criteria[${index}] must be an object.`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: readString(row.id, `config.criteria[${index}].id`),
    description: readString(row.description, `config.criteria[${index}].description`),
    expectedBehavior: readString(
      row.expectedBehavior,
      `config.criteria[${index}].expectedBehavior`,
    ),
  };
}

function readTest(value: unknown, index: number): RawTest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`config.tests[${index}] must be an object.`);
  }
  const row = value as Record<string, unknown>;
  return {
    id: readString(row.id, `config.tests[${index}].id`),
    arguments: readString(row.arguments, `config.tests[${index}].arguments`),
    expectedReturn: readString(
      row.expectedReturn,
      `config.tests[${index}].expectedReturn`,
    ),
  };
}

function readString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new InvalidRequestError(`${field} must be a string.`);
  }
  return value;
}

function invalidRequest(error: unknown): Response {
  if (error instanceof InvalidRequestError) {
    return jsonResponse({ error: 'invalid_request', message: error.message }, 400);
  }
  throw error;
}

async function wrapNotFound(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    throw error;
  }
}

export function serializeVersion(version: AssignmentVersionDetail): Record<string, unknown> {
  return {
    id: version.id,
    assignmentId: version.assignmentId,
    versionNumber: version.versionNumber,
    title: version.title,
    description: version.description,
    format: version.format,
    entryPoint: version.entryPoint,
    rubricVersionId: version.rubricVersionId,
    testSuiteVersionId: version.testSuiteVersionId,
    rubric: {
      versionId: version.rubricVersionId,
      criteria: version.criteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        expectedBehavior: criterion.expectedBehavior,
      })),
    },
    testSuite: {
      versionId: version.testSuiteVersionId,
      comparisonRule: COMPARISON_RULE,
      tests: version.tests.map((test) => ({
        id: test.id,
        arguments: parseJsonValue(test.argumentsJson),
        argumentsJson: test.argumentsJson,
        expectedReturn: parseJsonValue(test.expectedReturnJson),
        expectedReturnJson: test.expectedReturnJson,
        comparisonRule: test.comparisonRule,
      })),
    },
    createdAt: version.createdAt,
    createdBy: version.createdBy,
  };
}
