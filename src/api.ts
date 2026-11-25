import {
  authenticatedPostError,
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
import { jsonResponse, jsonTextResponse } from './http';
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
  try {
    return await routeAssignmentsApi(request, env, path, guarded.session);
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) return jsonResponse({ error: 'not_found' }, 404);
    if (error instanceof InvalidRequestError) {
      return jsonResponse({ error: 'invalid_request', message: error.message }, 400);
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
      return jsonResponse({ versions: await listVersions(env.DB, assignmentId) });
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

  const config = readConfig(configValue(await readJsonObject(request)));
  const validation = validateConfig(config);
  if (!validation.ok) {
    return jsonResponse({ error: 'validation_failed', errors: validation.errors }, 400);
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

  const body = await readJsonObject(request);
  const baseVersionId = body.baseVersionId;
  if (typeof baseVersionId !== 'string' || baseVersionId.trim() === '') {
    throw new InvalidRequestError('baseVersionId is required.');
  }

  const validation = validateConfig(readConfig(configValue(body)));
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
    return versionResponse(result.version, result.changed);
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return jsonResponse(
        { error: 'stale_version', currentVersionId: error.currentVersionId },
        409,
      );
    }
    throw error;
  }
}

function checkWriteRequest(request: Request, session: SessionUser): Response | null {
  const error = authenticatedPostError(request, session, request.headers.get('x-csrf-token'));
  return error === null ? null : jsonResponse({ error }, 403);
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
  const prefix = `config.tests[${index}]`;
  const text = (key: 'arguments' | 'expectedReturn') => {
    const canonical = `${key}Json`;
    return Object.hasOwn(row, canonical)
      ? readString(row[canonical], `${prefix}.${canonical}`)
      : readString(row[key], `${prefix}.${key}`);
  };
  return {
    id: readString(row.id, `${prefix}.id`),
    arguments: text('arguments'),
    expectedReturn: text('expectedReturn'),
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

function versionResponse(version: AssignmentVersionDetail, changed?: boolean): Response {
  const { criteria, tests, ...metadata } = version;
  const head = JSON.stringify({
    ...metadata,
    rubric: {
      versionId: version.rubricVersionId,
      criteria,
    },
  }).slice(0, -1);
  const suite = JSON.stringify({
    versionId: version.testSuiteVersionId,
    comparisonRule: COMPARISON_RULE,
  }).slice(0, -1);
  // Only the validated, stored JSON values go on the wire verbatim. Parsing
  // them as JS numbers before serializing would erase Python's numeric kinds.
  const rows = tests.map((test) =>
    `${JSON.stringify(test).slice(0, -1)},"arguments":${test.argumentsJson},"expectedReturn":${test.expectedReturnJson}}`,
  ).join(',');
  const writeResult = changed === undefined ? '' : `"changed":${changed},`;
  return jsonTextResponse(
    `{${writeResult}"version":${head},"testSuite":${suite},"tests":[${rows}]}}}`,
    changed ? 201 : 200,
  );
}
