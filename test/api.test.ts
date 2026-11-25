import { describe, expect, it } from 'vitest';
import {
  apiFetch,
  apiJson,
  countRows,
  postJson,
  seedUser,
  signIn,
} from './helpers';
import {
  assignmentConfig,
  versionToRawConfig,
  type SerializedVersion,
} from './fixtures';

async function createAssignment(
  session: Awaited<ReturnType<typeof signIn>>,
  config = assignmentConfig(),
): Promise<{ status: number; version: SerializedVersion; body: any }> {
  const { response, body } = await postJson('/api/assignments', { config }, session);
  return { status: response.status, version: body.version as SerializedVersion, body };
}

async function versions(
  session: Awaited<ReturnType<typeof signIn>>,
  assignmentId: string,
): Promise<any[]> {
  const { response, body } = await apiJson(`/api/assignments/${assignmentId}/versions`, {
    session,
  });
  expect(response.status).toBe(200);
  return body.versions;
}

describe('API access boundary', () => {
  it('denies signed-out callers without exposing assignment data', async () => {
    const response = await apiFetch('/api/assignments');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
  });

  it('denies signed-in members without exposing assignment data', async () => {
    const member = await signIn(await seedUser('member'));
    const { response, body } = await apiJson('/api/assignments', { session: member });

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'forbidden' });
    expect(JSON.stringify(body)).not.toContain('First positive');
  });

  it('denies signed-out and member writes', async () => {
    const signedOut = await apiFetch('/api/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: assignmentConfig() }),
    });
    expect(signedOut.status).toBe(401);

    const member = await signIn(await seedUser('member'));
    const memberWrite = await postJson('/api/assignments', { config: assignmentConfig() }, member);
    expect(memberWrite.response.status).toBe(403);
    expect(await countRows('assignments')).toBe(0);
  });

  it('denies signed-out and member callers on every assignment API route', async () => {
    const researcher = await signIn(await seedUser());
    const { version } = await createAssignment(researcher);
    const base = `/api/assignments/${version.assignmentId}`;
    const reads = [
      '/api/assignments',
      base,
      `${base}/versions`,
      `${base}/versions/${version.id}`,
    ];
    const member = await signIn(await seedUser('member'));

    for (const path of reads) {
      const signedOut = await apiFetch(path);
      expect(signedOut.status).toBe(401);
      expect((await signedOut.text()).includes(version.title)).toBe(false);

      const memberRead = await apiJson(path, { session: member });
      expect(memberRead.response.status).toBe(403);
      expect(JSON.stringify(memberRead.body)).not.toContain(version.title);
    }

    const signedOutCreate = await apiFetch('/api/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: assignmentConfig() }),
    });
    expect(signedOutCreate.status).toBe(401);

    const memberCreate = await postJson('/api/assignments', { config: assignmentConfig() }, member);
    expect(memberCreate.response.status).toBe(403);

    const payload = {
      baseVersionId: version.id,
      config: assignmentConfig({ title: 'Denied edit' }),
    };
    const signedOutRevise = await apiFetch(`${base}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(signedOutRevise.status).toBe(401);

    const memberRevise = await postJson(`${base}/versions`, payload, member);
    expect(memberRevise.response.status).toBe(403);

    expect(await countRows('assignments')).toBe(1);
    expect(await countRows('assignment_versions')).toBe(1);
  });
});

describe('API CSRF protection', () => {
  it('requires a matching CSRF header and same origin for authenticated writes', async () => {
    const researcher = await signIn(await seedUser());
    const config = assignmentConfig();

    const missing = await apiFetch('/api/assignments', {
      method: 'POST',
      session: researcher,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    expect(missing.status).toBe(403);

    const wrong = await apiFetch('/api/assignments', {
      method: 'POST',
      session: researcher,
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'wrong' },
      body: JSON.stringify({ config }),
    });
    expect(wrong.status).toBe(403);

    const foreignOrigin = await apiFetch('/api/assignments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': researcher.csrfToken,
        origin: 'https://evil.example',
        cookie: researcher.cookie,
      },
      body: JSON.stringify({ config }),
    });
    expect(foreignOrigin.status).toBe(403);

    expect(await countRows('assignments')).toBe(0);
    expect(await countRows('assignment_versions')).toBe(0);
    expect(await countRows('rubric_versions')).toBe(0);
    expect(await countRows('test_suite_versions')).toBe(0);
  });
});

describe('create and reopen a function assignment', () => {
  it('creates immutable snapshots and returns typed tests', async () => {
    const researcher = await signIn(await seedUser());
    const { response, body } = await postJson(
      '/api/assignments',
      { config: assignmentConfig() },
      researcher,
    );

    expect(response.status).toBe(201);
    const version = body.version as SerializedVersion;
    expect(version.versionNumber).toBe(1);
    expect(version.format).toBe('function');
    expect(version.entryPoint).toBe('first_positive');
    expect(version.rubricVersionId).toBeTruthy();
    expect(version.testSuiteVersionId).toBeTruthy();
    expect(version.createdBy.email).toBe(researcher.user.email);
    expect(version.rubric.criteria.map((criterion) => criterion.id)).toEqual(['r1', 'r2']);
    expect(version.testSuite.tests.map((test) => test.id)).toEqual([
      'list-argument',
      'empty-list',
    ]);

    const first = version.testSuite.tests[0]!;
    expect(first.arguments).toEqual([[4, -1]]);
    expect(Array.isArray(first.arguments)).toBe(true);
    expect(first.argumentsJson).toBe('[[4,-1]]');
    expect(first.expectedReturn).toBe(4);
    expect(first.expectedReturnJson).toBe('4');
    expect(first.comparisonRule).toBe('function-value-v1');

    const second = version.testSuite.tests[1]!;
    expect(second.arguments).toEqual([[]]);
    expect(second.expectedReturn).toBeNull();
    expect(second.expectedReturnJson).toBe('null');
  });

  it('lists assignments with active title and rubric/test counts', async () => {
    const researcher = await signIn(await seedUser());
    const { version } = await createAssignment(researcher);

    const { response, body } = await apiJson('/api/assignments', { session: researcher });
    expect(response.status).toBe(200);
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      id: version.assignmentId,
      activeVersionId: version.id,
      versionNumber: 1,
      title: 'First positive value',
      criteriaCount: 2,
      testsCount: 2,
    });
  });

  it('reopens the active version and the exact version without falling back', async () => {
    const researcher = await signIn(await seedUser());
    const { version } = await createAssignment(researcher);
    const base = `/api/assignments/${version.assignmentId}`;

    const active = await apiJson(base, { session: researcher });
    expect(active.response.status).toBe(200);
    expect(active.body.version.id).toBe(version.id);
    expect(active.body.version.testSuite.tests[0].arguments).toEqual([[4, -1]]);
    expect(active.body.version.testSuite.tests[1].expectedReturn).toBeNull();

    const exact = await apiJson(`${base}/versions/${version.id}`, { session: researcher });
    expect(exact.response.status).toBe(200);
    expect(exact.body.version).toEqual(version);

    const missing = await apiJson(`${base}/versions/${crypto.randomUUID()}`, {
      session: researcher,
    });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });

    const unknownAssignment = await apiJson(`/api/assignments/${crypto.randomUUID()}`, {
      session: researcher,
    });
    expect(unknownAssignment.response.status).toBe(404);
  });

  it('does not return a version that belongs to another assignment', async () => {
    const researcher = await signIn(await seedUser());
    const first = await createAssignment(researcher);
    const second = await createAssignment(
      researcher,
      assignmentConfig({ title: 'Second assignment' }),
    );

    const foreign = await apiJson(
      `/api/assignments/${second.version.assignmentId}/versions/${first.version.id}`,
      { session: researcher },
    );
    expect(foreign.response.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('First positive value');
  });
});

describe('validation through the API', () => {
  it('rejects invalid configuration and writes nothing', async () => {
    const researcher = await signIn(await seedUser());
    const { response, body } = await postJson(
      '/api/assignments',
      {
        config: assignmentConfig({
          title: ' ',
          entryPoint: 'class',
          tests: [
            { id: 't1', arguments: '[1,]', expectedReturn: '' },
            { id: 't1', arguments: '{"a": 1, "a": 2}', expectedReturn: '1e999' },
          ],
        }),
      },
      researcher,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(body.errors.title).toMatch(/title/i);
    expect(body.errors.entryPoint).toMatch(/keyword/i);
    expect(body.errors.tests.rows['0'].arguments).toMatch(/Invalid JSON/i);
    expect(body.errors.tests.rows['0'].expectedReturn).toMatch(/expected return/i);
    expect(body.errors.tests.rows['1'].id).toMatch(/already used/i);
    expect(body.errors.tests.rows['1'].arguments).toMatch(/duplicate/i);
    expect(body.errors.tests.rows['1'].expectedReturn).toMatch(/finite/i);

    expect(await countRows('assignments')).toBe(0);
    expect(await countRows('assignment_versions')).toBe(0);
    expect(await countRows('rubric_versions')).toBe(0);
    expect(await countRows('test_suite_versions')).toBe(0);
  });

  it('rejects a malformed request body', async () => {
    const researcher = await signIn(await seedUser());
    const { response, body } = await postJson('/api/assignments', { config: 'nope' }, researcher);
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});

describe('versioning table', () => {
  it('creates the expected versions, reuses child snapshots, and skips no-op saves', async () => {
    const researcher = await signIn(await seedUser());
    const created = await createAssignment(researcher);
    const assignmentId = created.version.assignmentId;
    let current = created.version;

    expect(current.versionNumber).toBe(1);
    expect(await versions(researcher, assignmentId)).toHaveLength(1);

    // Metadata only: assignment version and unchanged child versions.
    current = await saveRevision(researcher, assignmentId, current, {
      title: 'First positive value (renamed)',
    });
    expect(current.versionNumber).toBe(2);
    expect(current.rubricVersionId).toBe(created.version.rubricVersionId);
    expect(current.testSuiteVersionId).toBe(created.version.testSuiteVersionId);

    // Rubric only.
    const rubricChanged = versionToRawConfig(current);
    rubricChanged.criteria = rubricChanged.criteria.map((criterion) =>
      criterion.id === 'r1'
        ? { ...criterion, description: 'Iteration order (clarified)' }
        : criterion,
    );
    const withRubric = await saveRevisionRaw(researcher, assignmentId, current, rubricChanged);
    expect(withRubric.versionNumber).toBe(3);
    expect(withRubric.rubricVersionId).not.toBe(current.rubricVersionId);
    expect(withRubric.testSuiteVersionId).toBe(current.testSuiteVersionId);
    current = withRubric;

    // Tests only.
    const testsChanged = versionToRawConfig(current);
    testsChanged.tests = testsChanged.tests.map((test) =>
      test.id === 'list-argument' ? { ...test, expectedReturn: '5' } : test,
    );
    const withTests = await saveRevisionRaw(researcher, assignmentId, current, testsChanged);
    expect(withTests.versionNumber).toBe(4);
    expect(withTests.rubricVersionId).toBe(current.rubricVersionId);
    expect(withTests.testSuiteVersionId).not.toBe(current.testSuiteVersionId);
    current = withTests;

    // Both children.
    const bothChanged = versionToRawConfig(current);
    bothChanged.criteria = [
      ...bothChanged.criteria,
      { id: 'r3', description: 'Third', expectedBehavior: 'Also behaves.' },
    ];
    bothChanged.tests = bothChanged.tests.map((test) =>
      test.id === 'empty-list' ? { ...test, expectedReturn: '0' } : test,
    );
    const withBoth = await saveRevisionRaw(researcher, assignmentId, current, bothChanged);
    expect(withBoth.versionNumber).toBe(5);
    expect(withBoth.rubricVersionId).not.toBe(current.rubricVersionId);
    expect(withBoth.testSuiteVersionId).not.toBe(current.testSuiteVersionId);
    current = withBoth;

    // No-op, including reformatted JSON that normalizes to the same values.
    const noOpConfig = versionToRawConfig(current);
    noOpConfig.title = ` ${noOpConfig.title} `;
    noOpConfig.tests = noOpConfig.tests.map((test) =>
      test.id === 'list-argument'
        ? { ...test, arguments: ' [[4, -1]] ' }
        : test,
    );
    const noOpResponse = await postJson(
      `/api/assignments/${assignmentId}/versions`,
      { baseVersionId: current.id, config: noOpConfig },
      researcher,
    );
    expect(noOpResponse.response.status).toBe(200);
    expect(noOpResponse.body.changed).toBe(false);
    expect(noOpResponse.body.version.id).toBe(current.id);
    expect(noOpResponse.body.version.versionNumber).toBe(5);

    const all = await versions(researcher, assignmentId);
    expect(all.map((version) => version.versionNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(all.filter((version) => version.isActive)).toHaveLength(1);
    expect(all[0].id).toBe(current.id);

    // Historical configurations are unchanged, including child IDs and content.
    const original = await apiJson(`/api/assignments/${assignmentId}/versions/${created.version.id}`, {
      session: researcher,
    });
    expect(original.response.status).toBe(200);
    expect(original.body.version).toEqual(created.version);
    expect(original.body.version.title).toBe('First positive value');
    expect(original.body.version.rubricVersionId).toBe(created.version.rubricVersionId);
    expect(original.body.version.testSuite.tests[0].arguments).toEqual([[4, -1]]);
    expect(original.body.version.testSuite.tests[1].expectedReturn).toBeNull();
  });

  it('does not advance the active version when validation fails', async () => {
    const researcher = await signIn(await seedUser());
    const created = await createAssignment(researcher);
    const assignmentId = created.version.assignmentId;

    const { response, body } = await postJson(
      `/api/assignments/${assignmentId}/versions`,
      {
        baseVersionId: created.version.id,
        config: assignmentConfig({ entryPoint: 'def nope():' }),
      },
      researcher,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe('validation_failed');
    const all = await versions(researcher, assignmentId);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.version.id);
    expect(await countRows('rubric_versions')).toBe(1);
    expect(await countRows('test_suite_versions')).toBe(1);
  });
});

describe('stale saves and races', () => {
  it('rejects a stale save without changing the active version', async () => {
    const researcher = await signIn(await seedUser());
    const created = await createAssignment(researcher);
    const assignmentId = created.version.assignmentId;

    const first = await saveRevision(researcher, assignmentId, created.version, {
      title: 'Newer title',
    });
    expect(first.versionNumber).toBe(2);

    const staleConfig = assignmentConfig({ title: 'Stale title' });
    const stale = await postJson(
      `/api/assignments/${assignmentId}/versions`,
      { baseVersionId: created.version.id, config: staleConfig },
      researcher,
    );

    expect(stale.response.status).toBe(409);
    expect(stale.body.error).toBe('stale_version');
    expect(stale.body.currentVersionId).toBe(first.id);

    const all = await versions(researcher, assignmentId);
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(first.id);
  });

  it('allows exactly one of two concurrent revisions and leaves no orphan snapshots', async () => {
    const researcher = await signIn(await seedUser());
    const created = await createAssignment(researcher);
    const assignmentId = created.version.assignmentId;
    const baseConfig = versionToRawConfig(created.version);

    const configA: typeof baseConfig = {
      ...baseConfig,
      title: 'Winner A',
      criteria: baseConfig.criteria.map((criterion) =>
        criterion.id === 'r1' ? { ...criterion, description: 'A' } : criterion,
      ),
      tests: baseConfig.tests.map((test) =>
        test.id === 'list-argument' ? { ...test, expectedReturn: '8' } : test,
      ),
    };
    const configB: typeof baseConfig = {
      ...baseConfig,
      title: 'Winner B',
      criteria: baseConfig.criteria.map((criterion) =>
        criterion.id === 'r1' ? { ...criterion, description: 'B' } : criterion,
      ),
      tests: baseConfig.tests.map((test) =>
        test.id === 'list-argument' ? { ...test, expectedReturn: '9' } : test,
      ),
    };

    const [a, b] = await Promise.all([
      postJson(
        `/api/assignments/${assignmentId}/versions`,
        { baseVersionId: created.version.id, config: configA },
        researcher,
      ),
      postJson(
        `/api/assignments/${assignmentId}/versions`,
        { baseVersionId: created.version.id, config: configB },
        researcher,
      ),
    ]);

    const statuses = [a.response.status, b.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await countRows('assignment_versions')).toBe(2);
    expect(await countRows('rubric_versions')).toBe(2);
    expect(await countRows('test_suite_versions')).toBe(2);

    const rubricCriteria = await countRows('rubric_criteria');
    const tests = await countRows('tests');
    expect(rubricCriteria).toBe(4);
    expect(tests).toBe(4);

    const active = await apiJson(`/api/assignments/${assignmentId}`, { session: researcher });
    expect(active.body.version.versionNumber).toBe(2);
    const loser = a.response.status === 409 ? a : b;
    expect(loser.body.error).toBe('stale_version');
    expect(loser.body.currentVersionId).toBe(active.body.version.id);
  });
});

async function saveRevision(
  session: Awaited<ReturnType<typeof signIn>>,
  assignmentId: string,
  base: SerializedVersion,
  overrides: Partial<ReturnType<typeof assignmentConfig>>,
): Promise<SerializedVersion> {
  return saveRevisionRaw(session, assignmentId, base, {
    ...versionToRawConfig(base),
    ...overrides,
  });
}

async function saveRevisionRaw(
  session: Awaited<ReturnType<typeof signIn>>,
  assignmentId: string,
  base: SerializedVersion,
  config: ReturnType<typeof assignmentConfig>,
): Promise<SerializedVersion> {
  const { response, body } = await postJson(
    `/api/assignments/${assignmentId}/versions`,
    { baseVersionId: base.id, config },
    session,
  );
  if (response.status !== 201) {
    throw new Error(`Revision failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  expect(body.changed).toBe(true);
  return body.version as SerializedVersion;
}
