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
  scriptConfig,
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
  it('preserves numeric kinds through revisions, exact reads, and no-op saves', async () => {
    const researcher = await signIn(await seedUser());
    const rest = '-0.0, 1e20, 9007199254740992, 1000000000000000128';
    const config = assignmentConfig({
      tests: [{
        id: 'numbers',
        arguments: `[1, ${rest}]`,
        expectedReturn: '{"2":3,"10":[2,1],"x":5}',
      }],
    });
    const { version: first } = await createAssignment(researcher, config);
    const collection = `/api/assignments/${first.assignmentId}/versions`;
    const second = await saveRevisionRaw(researcher, first.assignmentId, first, {
      ...config,
      tests: [{
        id: 'numbers',
        arguments: `[1.0, ${rest}]`,
        expectedReturn: '{"2":3,"10":[2,1],"x":5.0}',
      }],
    });
    expect(second.versionNumber).toBe(2);
    expect(second.testSuiteVersionId).not.toBe(first.testSuiteVersionId);
    expect(second.rubricVersionId).toBe(first.rubricVersionId);

    const exact = await apiFetch(`${collection}/${second.id}`, { session: researcher });
    expect(exact.status).toBe(200);
    const wire = await exact.text();
    const args = '[1.0,-0.0,100000000000000000000.0,9007199254740992,1000000000000000128]';
    const expected = '{"10":[2,1],"2":3,"x":5.0}';
    expect(wire).not.toContain('"arguments":');
    expect(wire).not.toContain('"expectedReturn":');
    const reopened = JSON.parse(wire).version as SerializedVersion;
    expect(reopened.testSuite.tests[0]?.argumentsJson).toBe(args);
    expect(reopened.testSuite.tests[0]?.expectedReturnJson).toBe(expected);
    const original = await apiJson(`${collection}/${first.id}`, { session: researcher });
    expect(original.body.version.testSuite.tests[0].expectedReturnJson).toBe('{"10":[2,1],"2":3,"x":5}');
    expect(original.body.version.testSuite.tests[0].argumentsJson).toBe(
      '[1,-0.0,100000000000000000000.0,9007199254740992,1000000000000000128]',
    );

    const noOp = await postJson(collection, {
      baseVersionId: second.id,
      config: {
        ...config,
        tests: [{
          id: 'numbers',
          arguments: '[1e0, -0e0, 1e20, 9007199254740992, 1000000000000000128]',
          expectedReturn: '{ "x":5e0, "2":3, "10":[2,1] }',
        }],
      },
    }, researcher);
    expect(noOp.response.status).toBe(200);
    expect(noOp.body.changed).toBe(false);
    expect(noOp.body.version.id).toBe(second.id);

    const fromRead = await postJson(collection, {
      baseVersionId: second.id,
      config: {
        ...config,
        tests: reopened.testSuite.tests.map((test) => ({
          ...test,
          arguments: [999],
          expectedReturn: 999,
        })),
      },
    }, researcher);
    expect(fromRead.response.status).toBe(200);
    expect(fromRead.body.changed).toBe(false);
    expect(fromRead.body.version.id).toBe(second.id);
  });

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
    expect(first).not.toHaveProperty('arguments');
    expect(first).not.toHaveProperty('expectedReturn');
    expect(first.argumentsJson).toBe('[[4,-1]]');
    expect(first.expectedReturnJson).toBe('4');
    expect(first.comparisonRule).toBe('function-value-v1');

    const second = version.testSuite.tests[1]!;
    expect(second.argumentsJson).toBe('[[]]');
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
    expect(active.body.version.testSuite.tests[0].argumentsJson).toBe('[[4,-1]]');
    expect(active.body.version.testSuite.tests[1].expectedReturnJson).toBe('null');

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
    const unknownHistory = await apiJson(`/api/assignments/${crypto.randomUUID()}/versions`, {
      session: researcher,
    });
    expect(unknownHistory.response.status).toBe(404);
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
  it('saves a long Unicode Python name under its canonical spelling', async () => {
    const researcher = await signIn(await seedUser());
    const suffix = '_λ'.repeat(130);
    const created = await createAssignment(researcher, assignmentConfig({
      entryPoint: `cafe\u0301${suffix}`,
    }));
    expect(created.status).toBe(201);
    const exact = await apiJson(
      `/api/assignments/${created.version.assignmentId}/versions/${created.version.id}`,
      { session: researcher },
    );
    expect(exact.body.version.entryPoint).toBe(`café${suffix}`);

    for (const entryPoint of ['Ⓐ', 'ͺname', 'ｃｌａｓｓ', 'a\u200Cb']) {
      const invalid = await createAssignment(researcher, assignmentConfig({ entryPoint }));
      expect(invalid.status).toBe(400);
      expect(invalid.body.errors.entryPoint).toMatch(/identifier|keyword/i);
    }
  });

  it('rejects excessively nested JSON as an actionable row error', async () => {
    const researcher = await signIn(await seedUser());
    const nesting = (depth: number) => '['.repeat(depth) + '0' + ']'.repeat(depth);
    const valid = await createAssignment(researcher, assignmentConfig({
      tests: [{ id: 'nested', arguments: '[]', expectedReturn: nesting(64) }],
    }));
    expect(valid.status).toBe(201);
    expect(valid.version.testSuite.tests[0]?.expectedReturnJson).toBe(nesting(64));
    const result = await createAssignment(researcher, assignmentConfig({
      tests: [{
        id: 'nested',
        arguments: '[]',
        expectedReturn: nesting(65),
      }],
    }));
    expect(result.status).toBe(400);
    expect(result.body.errors.tests.rows[0].expectedReturn).toMatch(/at most 64.*nest/i);
  });

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
    expect(all.map((version) => version.isActive)).toEqual([true, false, false, false, false]);
    expect(all[0].id).toBe(current.id);

    // Historical configurations are unchanged, including child IDs and content.
    const original = await apiJson(`/api/assignments/${assignmentId}/versions/${created.version.id}`, {
      session: researcher,
    });
    expect(original.response.status).toBe(200);
    expect(original.body.version).toEqual(created.version);
    expect(original.body.version.title).toBe('First positive value');
    expect(original.body.version.rubricVersionId).toBe(created.version.rubricVersionId);
    expect(original.body.version.testSuite.tests[0].argumentsJson).toBe('[[4,-1]]');
    expect(original.body.version.testSuite.tests[1].expectedReturnJson).toBe('null');
  });

  it('allows the same ID in each list and treats a criterion ID rename as a new item', async () => {
    const researcher = await signIn(await seedUser());
    const config = assignmentConfig({
      criteria: [
        {
          id: 'list-argument',
          description: 'Iteration order',
          expectedBehavior: 'Checks each item in order.',
        },
        { id: 'r2', description: 'No positive value', expectedBehavior: 'Returns None.' },
      ],
    });
    const created = await createAssignment(researcher, config);
    const assignmentId = created.version.assignmentId;

    expect(created.version.rubric.criteria.map((criterion) => criterion.id)).toEqual([
      'list-argument',
      'r2',
    ]);
    expect(created.version.testSuite.tests.map((test) => test.id)).toContain('list-argument');

    const renamed = versionToRawConfig(created.version);
    renamed.criteria = renamed.criteria.map((criterion) =>
      criterion.id === 'list-argument'
        ? { ...criterion, id: 'list-argument-v2' }
        : criterion,
    );
    const next = await saveRevisionRaw(researcher, assignmentId, created.version, renamed);

    expect(next.versionNumber).toBe(2);
    expect(next.rubricVersionId).not.toBe(created.version.rubricVersionId);
    expect(next.rubric.criteria.map((criterion) => criterion.id)).toEqual([
      'list-argument-v2',
      'r2',
    ]);

    const original = await apiJson(
      `/api/assignments/${assignmentId}/versions/${created.version.id}`,
      { session: researcher },
    );
    expect(original.body.version.rubric.criteria.map((criterion: { id: string }) => criterion.id)).toEqual([
      'list-argument',
      'r2',
    ]);
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

    const [a, b, historyInFlight] = await Promise.all([
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
      versions(researcher, assignmentId),
    ]);
    expect(historyInFlight.map((version) => version.isActive)).toEqual(
      historyInFlight.length === 1 ? [true] : [true, false],
    );

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
    expect((await versions(researcher, assignmentId)).map(({ id, isActive }) => ({ id, isActive }))).toEqual([
      { id: active.body.version.id, isActive: true },
      { id: created.version.id, isActive: false },
    ]);
    const loser = a.response.status === 409 ? a : b;
    expect(loser.body.error).toBe('stale_version');
    expect(loser.body.currentVersionId).toBe(active.body.version.id);
  });
});

describe('script configuration through the JSON API', () => {
  it('creates a script assignment with exact text and no entry point', async () => {
    const researcher = await signIn(await seedUser());
    const stdin = '\r\n  keep  \r\n\r\n';
    const expectedStdout = '  answer  \r\n\r\n';
    const { response, body } = await postJson('/api/assignments', {
      config: scriptConfig({
        tests: [
          { id: 'exact', stdin, expectedStdout },
          { id: 'empty', stdin: '', expectedStdout: '' },
        ],
      }),
    }, researcher);

    expect(response.status).toBe(201);
    const version = body.version as SerializedVersion;
    expect(version.format).toBe('script');
    expect(version.entryPoint).toBeUndefined();
    expect(version.testSuite.comparisonRule).toBe('script-stdout-v1');
    expect(version.testSuite.tests[0]).toEqual({
      id: 'exact',
      stdin,
      expectedStdout,
      comparisonRule: 'script-stdout-v1',
    });
    expect(version.testSuite.tests[1]).toEqual({
      id: 'empty',
      stdin: '',
      expectedStdout: '',
      comparisonRule: 'script-stdout-v1',
    });
    expect(version.testSuite.tests[0]).not.toHaveProperty('argumentsJson');
    expect(version.testSuite.tests[0]).not.toHaveProperty('expectedReturnJson');
  });

  it('rejects missing script fields, mixed fields, duplicates, and oversized text without writing', async () => {
    const researcher = await signIn(await seedUser());
    const missing = await postJson('/api/assignments', {
      config: scriptConfig({ tests: [{ id: 'missing', stdin: '' }] }),
    }, researcher);
    expect(missing.response.status).toBe(400);
    expect(missing.body.errors.tests.rows['0'].expectedStdout).toMatch(/expected stdout/i);
    expect(await countRows('assignments')).toBe(0);

    const mixedFunction = await postJson('/api/assignments', {
      config: assignmentConfig({
        tests: [{ id: 'mixed', arguments: '[]', expectedReturn: '1', stdin: 'x' }],
      }),
    }, researcher);
    expect(mixedFunction.response.status).toBe(400);
    expect(mixedFunction.body.errors.tests.rows['0'].stdin).toMatch(/Script assignment/i);

    const mixedScript = await postJson('/api/assignments', {
      config: scriptConfig({
        entryPoint: 'main',
        tests: [{ id: 'mixed', stdin: '', expectedStdout: '', arguments: '[]' }],
      }),
    }, researcher);
    expect(mixedScript.response.status).toBe(400);
    expect(mixedScript.body.errors.entryPoint).toMatch(/entry point/i);
    expect(mixedScript.body.errors.tests.rows['0'].arguments).toMatch(/Function assignment/i);

    const duplicate = await postJson('/api/assignments', {
      config: scriptConfig({
        tests: [
          { id: 'same', stdin: '', expectedStdout: '' },
          { id: 'same', stdin: '', expectedStdout: '' },
        ],
      }),
    }, researcher);
    expect(duplicate.response.status).toBe(400);
    expect(duplicate.body.errors.tests.rows['1'].id).toMatch(/already used/i);

    const overLimit = await postJson('/api/assignments', {
      config: scriptConfig({
        tests: [{ id: 'large', stdin: 'é'.repeat(8 * 1024 + 1), expectedStdout: '' }],
      }),
    }, researcher);
    expect(overLimit.response.status).toBe(400);
    expect(overLimit.body.errors.tests.rows['0'].stdin).toMatch(/16 KiB/);
    expect(await countRows('assignments')).toBe(0);
  });

  it('treats a format switch as a new version and suite and keeps old function evidence', async () => {
    const researcher = await signIn(await seedUser());
    const created = await createAssignment(researcher);
    const assignmentId = created.version.assignmentId;
    const switchConfig = scriptConfig({ criteria: created.version.rubric.criteria });

    const switched = await postJson(`/api/assignments/${assignmentId}/versions`, {
      baseVersionId: created.version.id,
      config: switchConfig,
    }, researcher);
    expect(switched.response.status).toBe(201);
    expect(switched.body.changed).toBe(true);
    const scriptVersion = switched.body.version as SerializedVersion;
    expect(scriptVersion.format).toBe('script');
    expect(scriptVersion.testSuiteVersionId).not.toBe(created.version.testSuiteVersionId);
    expect(scriptVersion.rubricVersionId).toBe(created.version.rubricVersionId);

    const unchanged = await postJson(`/api/assignments/${assignmentId}/versions`, {
      baseVersionId: scriptVersion.id,
      config: switchConfig,
    }, researcher);
    expect(unchanged.response.status).toBe(200);
    expect(unchanged.body.changed).toBe(false);
    expect(unchanged.body.version.id).toBe(scriptVersion.id);

    const original = await apiJson(
      `/api/assignments/${assignmentId}/versions/${created.version.id}`,
      { session: researcher },
    );
    expect(original.body.version.format).toBe('function');
    expect(original.body.version.entryPoint).toBe('first_positive');
    expect(original.body.version.testSuite.tests[0].argumentsJson).toBe('[[4,-1]]');
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
