import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countRows, postForm, postJson, seedUser, signIn, type SignedIn } from './helpers';
import { assignmentConfig, scriptConfig, type SerializedVersion } from './fixtures';
import type { RawConfig } from '../src/config';

const BASE_URL = 'https://feedback-lab.test';

function formFields(
  config: RawConfig,
  baseVersionId?: string,
): Record<string, string> {
  const format = config.format ?? 'function';
  const fields: Record<string, string> = {
    title: config.title,
    description: config.description,
    format,
    entryPoint: config.entryPoint ?? '',
  };
  if (baseVersionId !== undefined) {
    fields.baseVersionId = baseVersionId;
  }
  config.criteria.forEach((criterion, index) => {
    fields[`criteria[${index}][id]`] = criterion.id;
    fields[`criteria[${index}][description]`] = criterion.description;
    fields[`criteria[${index}][expectedBehavior]`] = criterion.expectedBehavior;
  });
  config.tests.forEach((test, index) => {
    fields[`tests[${index}][id]`] = test.id;
    if (format === 'script') {
      fields[`tests[${index}][stdin]`] = test.stdin ?? '';
      fields[`tests[${index}][expectedStdout]`] = test.expectedStdout ?? '';
    } else {
      fields[`tests[${index}][arguments]`] = test.arguments ?? '';
      fields[`tests[${index}][expectedReturn]`] = test.expectedReturn ?? '';
    }
  });
  return fields;
}

async function get(path: string, session?: SignedIn): Promise<Response> {
  return SELF.fetch(`${BASE_URL}${path}`, {
    headers: session === undefined ? {} : { cookie: session.cookie },
    redirect: 'manual',
  });
}

async function createViaApi(
  session: SignedIn,
  config = assignmentConfig(),
): Promise<SerializedVersion> {
  const { response, body } = await postJson('/api/assignments', { config }, session);
  expect(response.status).toBe(201);
  return body.version as SerializedVersion;
}

async function createViaHtml(
  session: SignedIn,
  config = assignmentConfig(),
): Promise<string> {
  const response = await postForm('/assignments', formFields(config), session);
  expect(response.status).toBe(303);
  const location = response.headers.get('location') ?? '';
  expect(location).toMatch(/^\/assignments\/[0-9a-f-]{36}$/);
  return location.slice('/assignments/'.length);
}

describe('HTML access boundary', () => {
  it('redirects signed-out users before they can read any assignment page', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    for (const path of [
      '/assignments',
      '/assignments/new',
      base,
      `${base}/edit`,
      `${base}/history`,
      `${base}/versions/${version.id}`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('/sign-in?next=');
      const body = await response.text();
      expect(body).not.toContain(version.title);
    }
  });

  it('denies signed-in members without exposing assignment data', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const member = await signIn(await seedUser('member'));
    const base = `/assignments/${version.assignmentId}`;

    for (const path of [
      '/assignments',
      '/assignments/new',
      base,
      `${base}/edit`,
      `${base}/history`,
      `${base}/versions/${version.id}`,
    ]) {
      const response = await get(path, member);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain('Researcher access required');
      expect(body).not.toContain(version.title);
    }

    const write = await postForm('/assignments', formFields(assignmentConfig()), member);
    expect(write.status).toBe(403);
    const edit = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Member edit' }), version.id),
      member,
    );
    expect(edit.status).toBe(403);
    expect(await countRows('assignments')).toBe(1);
    expect(await countRows('assignment_versions')).toBe(1);
  });

  it('denies signed-out and member form writes', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    const signedOut = await SELF.fetch(`${BASE_URL}/assignments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
      },
      body: new URLSearchParams(formFields(assignmentConfig())).toString(),
      redirect: 'manual',
    });
    expect(signedOut.status).toBe(303);

    const member = await signIn(await seedUser('member'));
    const memberWrite = await postForm(
      `${base}`,
      formFields(assignmentConfig({ title: 'Member edit' }), version.id),
      member,
    );
    expect(memberWrite.status).toBe(403);
    expect(await countRows('assignment_versions')).toBe(1);
  });

  it('rejects form writes without a valid CSRF token', async () => {
    const researcher = await signIn(await seedUser());
    const response = await postForm('/assignments', formFields(assignmentConfig()), researcher, {
      includeCsrf: false,
    });
    expect(response.status).toBe(403);
    expect(await countRows('assignments')).toBe(0);

    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;
    const edit = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Unsaved' }), version.id),
      researcher,
      { includeCsrf: false },
    );
    expect(edit.status).toBe(403);
    expect(await countRows('assignment_versions')).toBe(1);
  });
});

describe('library', () => {
  it('redirects the site root to the library', async () => {
    const response = await get('/');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/assignments');
  });

  it('shows a clear empty state with a create action', async () => {
    const researcher = await signIn(await seedUser());
    const response = await get('/assignments', researcher);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('No assignments yet');
    expect(html).toContain('href="/assignments/new"');
  });

  it('lists the active title with rubric and test counts', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);

    const response = await get('/assignments', researcher);
    const html = await response.text();
    expect(html).toContain(version.title);
    expect(html).toContain('2 criteria');
    expect(html).toContain('2 tests');
    expect(html).toContain(`/assignments/${version.assignmentId}`);
  });
});

describe('create with the HTML form', () => {
  it('saves sparse numeric row indices in numeric order without dropping high rows', async () => {
    const researcher = await signIn(await seedUser());
    const config = assignmentConfig();
    const renamed = new Map([
      ['criteria[0]', 'criteria[1200]'],
      ['criteria[1]', 'criteria[9]'],
      ['tests[0]', 'tests[900719925474099300000]'],
      ['tests[1]', 'tests[900719925474099300001]'],
    ]);
    const fields = Object.fromEntries(Object.entries(formFields(config)).map(([key, value]) => [
      key.replace(/^(criteria|tests)\[\d+\]/, (prefix) => renamed.get(prefix)!),
      value,
    ]));
    const response = await postForm('/assignments', fields, researcher);
    expect(response.status).toBe(303);
    const exact = await (await get(response.headers.get('location')!, researcher)).text();
    expect(exact.indexOf('No positive value')).toBeLessThan(exact.indexOf('Iteration order'));
    expect(exact).toContain('list-argument');
    expect(exact).toContain('empty-list');
    expect(exact.indexOf('list-argument')).toBeLessThan(exact.indexOf('empty-list'));
  });

  it('keeps pasted multiline JSON on error and resaves the reopened near-limit value', async () => {
    const researcher = await signIn(await seedUser());
    const payload = 'a'.repeat(1024 * 1024 - 512);
    const pasted = `\n[\n  "${payload}",\n  1.0,\n  -0.0\n]\n`;
    const config = assignmentConfig({
      title: '',
      tests: [{ id: 'large', arguments: pasted, expectedReturn: 'null' }],
    });
    const invalid = await postForm('/assignments', formFields(config), researcher);
    expect(invalid.status).toBe(422);
    const invalidMarkup = await invalid.text();
    expect(jsonTextarea(invalidMarkup, 'arguments')).toBe(pasted);

    config.title = 'Large example';
    const assignmentId = await createViaHtml(researcher, config);
    const base = `/assignments/${assignmentId}`;
    const active = await (await get(`${base}/edit`, researcher)).text();
    const baseVersionId = /name="baseVersionId" value="([^"]+)"/.exec(active)?.[1];
    expect(baseVersionId).toBeTruthy();
    const reopenedArgs = jsonTextarea(active, 'arguments');
    const reopenedExpected = jsonTextarea(active, 'expectedReturn');
    expect(reopenedArgs).toBe(`["${payload}", 1.0, -0.0]`);
    expect(reopenedExpected).toBe('null');
    const unchanged = await postForm(base, {
      ...formFields(config, baseVersionId),
      'tests[0][arguments]': reopenedArgs,
      'tests[0][expectedReturn]': reopenedExpected,
    }, researcher);
    expect(unchanged.status).toBe(303);
    expect(unchanged.headers.get('location')).toBe(`${base}?notice=unchanged`);

    const oversize = await postForm(base, {
      ...formFields(config, baseVersionId),
      'tests[0][arguments]': `["${payload}${'a'.repeat(512)}"]`,
    }, researcher);
    expect(oversize.status).toBe(422);
    expect(await oversize.text()).toContain('1 MiB');
  });

  it('renders the form with repeatable rows, CSRF, and the examples', async () => {
    const researcher = await signIn(await seedUser());
    const response = await get('/assignments/new', researcher);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('name="criteria[0][id]"');
    expect(html).toContain('name="tests[0][arguments]"');
    expect(html).toContain('[[4, -1]]');
    expect(html).toContain('data-add="criteria"');
    expect(html).toContain('data-add="tests"');
  });

  it('creates an assignment and reopens its saved values and order', async () => {
    const researcher = await signIn(await seedUser());
    const assignmentId = await createViaHtml(researcher);

    const response = await get(`/assignments/${assignmentId}`, researcher);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('First positive value');
    expect(html).toContain('first_positive');
    expect(html).toContain('Version 1');
    expect(html).toContain('r1');
    expect(html).toContain('r2');
    expect(html.indexOf('Iteration order')).toBeLessThan(html.indexOf('No positive value'));
    expect(html).toContain('list-argument');
    expect(html).toContain('empty-list');
    expect(html).toContain('[[4, -1]]');
    expect(html).toContain('null');
  });

  it('escapes researcher-entered HTML', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(
      researcher,
      assignmentConfig({
        title: '<script>alert("x")</script>',
        description: 'Use 1 < 2 & 3 > 2.',
      }),
    );

    const response = await get(`/assignments/${version.assignmentId}`, researcher);
    const html = await response.text();
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('Use 1 &lt; 2 &amp; 3 &gt; 2.');
  });
});

describe('validation errors in the HTML form', () => {
  it('reports an over-limit list without truncating the editor rows', async () => {
    const researcher = await signIn(await seedUser());
    const tooMany = assignmentConfig({
      tests: Array.from({ length: 101 }, (_, index) => ({
        id: `test-${index}`,
        arguments: '[]',
        expectedReturn: String(index),
      })),
    });
    const response = await postForm('/assignments', formFields(tooMany), researcher);
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('Use 100 tests or fewer');
    expect(html).toContain('name="tests[100][id]" value="test-100"');
    expect(jsonTextarea(html, 'expectedReturn', 100)).toBe('100');
    expect(await countRows('assignments')).toBe(0);
  });

  it('identifies fields and rows, preserves input, and writes nothing', async () => {
    const researcher = await signIn(await seedUser());
    const invalid = assignmentConfig({
      title: '',
      entryPoint: 'class',
      criteria: [
        { id: 'r1', description: 'Keep this description', expectedBehavior: 'Behaves' },
      ],
      tests: [
        { id: 't1', arguments: '[1,]', expectedReturn: '' },
        { id: 't1', arguments: '{"a": 1, "a": 2}', expectedReturn: '1e999' },
      ],
    });

    const response = await postForm('/assignments', formFields(invalid), researcher);
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('Fix the highlighted fields');
    expect(html).toContain('Enter a title.');
    expect(html).toContain('Python keyword');
    expect(html).toContain('Keep this description');
    expect(html).toContain('Enter arguments as a JSON array');
    expect(html).toContain('already used in this test suite');
    expect(html).toContain('Invalid JSON');
    expect(jsonTextarea(html, 'arguments')).toBe('[1,]');
    expect(jsonTextarea(html, 'expectedReturn', 1)).toBe('1e999');
    expect(await countRows('assignments')).toBe(0);
    expect(await countRows('assignment_versions')).toBe(0);
    expect(await countRows('rubric_versions')).toBe(0);
    expect(await countRows('test_suite_versions')).toBe(0);
  });

  it('does not advance the active version on an invalid revision', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);

    const response = await postForm(
      `/assignments/${version.assignmentId}`,
      formFields(
        assignmentConfig({ entryPoint: 'not a function' }),
        version.id,
      ),
      researcher,
    );
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('Python identifier');
    expect(await countRows('assignment_versions')).toBe(1);
    expect(await countRows('rubric_versions')).toBe(1);
    expect(await countRows('test_suite_versions')).toBe(1);
  });
});

describe('edit and history', () => {
  it('prefills the edit form with the active version and its base ID', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);

    const response = await get(`/assignments/${version.assignmentId}/edit`, researcher);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('First positive value</textarea>');
    expect(html).toContain('value="first_positive"');
    expect(html).toContain(`value="${version.id}"`);
    expect(jsonTextarea(html, 'arguments')).toBe('[[4, -1]]');
    expect(jsonTextarea(html, 'expectedReturn', 1)).toBe('null');
    expect(html).toContain('value="r1"');
  });

  it('saves metadata-only changes, reuses children, and shows history', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    const response = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Renamed assignment' }), version.id),
      researcher,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(base);

    const detail = await (await get(base, researcher)).text();
    expect(detail).toContain('Renamed assignment');
    expect(detail).toContain('Version 2');
    expect(detail).toContain(version.rubricVersionId);
    expect(detail).toContain(version.testSuiteVersionId);

    const history = await (await get(`${base}/history`, researcher)).text();
    expect(history).toContain('Version 2');
    expect(history).toContain('Version 1');
    expect(history.indexOf('Version 2')).toBeLessThan(history.indexOf('Version 1'));
    expect(history).toContain('Active');
  });

  it('reports a no-op save without creating a version', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    const response = await postForm(
      base,
      formFields(assignmentConfig(), version.id),
      researcher,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${base}?notice=unchanged`);

    const detail = await (await get(`${base}?notice=unchanged`, researcher)).text();
    expect(detail).toContain('No changes to save');
    expect(detail).toContain('Version 1');
    expect(await countRows('assignment_versions')).toBe(1);
  });

  it('opens an exact historical version read-only with its original values', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    await postForm(
      base,
      formFields(assignmentConfig({ title: 'Later title' }), version.id),
      researcher,
    );

    const response = await get(`${base}/versions/${version.id}`, researcher);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('First positive value');
    expect(html).toContain('not the active version');
    expect(html).toContain(version.rubricVersionId);
    expect(html).toContain(version.testSuiteVersionId);
    expect(html).toContain('[[4, -1]]');
    expect(html).not.toContain('action="/assignments/' + version.assignmentId + '"');
    expect(html).not.toContain('>Edit assignment<');
    expect(html).not.toContain('Later title');
  });

  it('shows the active version as active and offers an edit action', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    const html = await (await get(`${base}/versions/${version.id}`, researcher)).text();
    expect(html).toContain('This is the active version');
    expect(html).toContain(`href="${base}/edit?version=${version.id}"`);
  });

  it('does not allow historical configurations to be changed through their route', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;

    const response = await postForm(
      `${base}/versions/${version.id}`,
      formFields(assignmentConfig({ title: 'Rewrite history' }), version.id),
      researcher,
    );
    expect(response.status).toBe(405);
    expect(await countRows('assignment_versions')).toBe(1);

    const exact = await (await get(`${base}/versions/${version.id}`, researcher)).text();
    expect(exact).toContain('First positive value');
    expect(exact).not.toContain('Rewrite history');
  });

  it('lets a second researcher read and revise the same assignment', async () => {
    const researcherA = await signIn(await seedUser());
    const researcherB = await signIn(await seedUser());
    const version = await createViaApi(researcherA);
    const base = `/assignments/${version.assignmentId}`;

    const read = await get(base, researcherB);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('First positive value');

    const save = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Revised by the second researcher' }), version.id),
      researcherB,
    );
    expect(save.status).toBe(303);

    const detail = await (await get(base, researcherA)).text();
    expect(detail).toContain('Revised by the second researcher');
    expect(detail).toContain('Version 2');

    const history = await (await get(`${base}/history`, researcherA)).text();
    expect(history).toContain(researcherB.user.email);
  });

  it('returns 404 for missing assignments and versions', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);

    const missingAssignment = await get(`/assignments/${crypto.randomUUID()}`, researcher);
    expect(missingAssignment.status).toBe(404);

    const missingVersion = await get(
      `/assignments/${version.assignmentId}/versions/${crypto.randomUUID()}`,
      researcher,
    );
    expect(missingVersion.status).toBe(404);
  });
});

function jsonTextarea(html: string, field: 'arguments' | 'expectedReturn', index = 0): string {
  const markup = new RegExp(`<textarea name="tests\\[${index}\\]\\[${field}\\]"[^>]*>\\n([\\s\\S]*?)</textarea>`).exec(html);
  expect(markup).not.toBeNull();
  return markup![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

describe('stale HTML saves', () => {
  it('requires reopening the active version when an edit has no base ID', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;
    const draft = assignmentConfig({ title: 'My unbound draft' });
    for (const baseVersionId of [undefined, '  ']) {
      const response = await postForm(base, formFields(draft, baseVersionId), researcher);
      expect(response.status).toBe(422);
      const html = await response.text();
      expect(html).toContain('My unbound draft');
      expect(html).toContain(`href="${base}/edit"`);
      expect(html).toContain('Open the active version');
      expect(html).not.toContain('name="baseVersionId"');
    }
    const active = await (await get(base, researcher)).text();
    expect(active).toContain(version.title);
    expect(active).toContain('Version 1');
  });

  it('tells the researcher when the version linked by Edit is no longer active', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createViaApi(researcher);
    const base = `/assignments/${version.assignmentId}`;
    const detail = await (await get(base, researcher)).text();
    const editLink = /href="([^"]+)"[^>]*>Edit assignment</.exec(detail)?.[1];
    expect(editLink).toBe(`${base}/edit?version=${version.id}`);

    const saved = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Newer title' }), version.id),
      researcher,
    );
    expect(saved.status).toBe(303);

    const staleEdit = await get(editLink!, researcher);
    expect(staleEdit.status).toBe(409);
    const html = await staleEdit.text();
    expect(html).toContain('newer version');
    expect(html).toContain(`href="${base}/edit"`);
    expect(html).not.toContain('name="baseVersionId"');

    const activeEdit = await get(`${base}/edit`, researcher);
    expect(activeEdit.status).toBe(200);
    expect(await activeEdit.text()).toContain('Newer title</textarea>');
  });

  it('explains the conflict, keeps edits, and leaves the newer version active', async () => {
    const researcherA = await signIn(await seedUser());
    const researcherB = await signIn(await seedUser());
    const version = await createViaApi(researcherA);
    const base = `/assignments/${version.assignmentId}`;

    const first = await postForm(
      base,
      formFields(assignmentConfig({ title: 'Newer title' }), version.id),
      researcherA,
    );
    expect(first.status).toBe(303);

    const stale = await postForm(
      base,
      formFields(assignmentConfig({ title: 'My stale edit' }), version.id),
      researcherB,
    );
    const html = await stale.text();

    expect(stale.status).toBe(409);
    expect(html).toContain('newer version');
    expect(html).toContain('My stale edit');
    expect(html).toContain(`value="${version.id}"`);
    expect(html).toContain(`href="${base}"`);
    expect(html).toContain('Open the latest version');

    const versionsResponse = await get(`${base}/history`, researcherB);
    const history = await versionsResponse.text();
    expect(history).toContain('Newer title');
    expect(history).not.toContain('My stale edit');
    expect(await countRows('assignment_versions')).toBe(2);

    const active = await (await get(base, researcherB)).text();
    expect(active).toContain('Newer title');
    expect(active).toContain('Version 2');
  });
});

describe('script assignments in the HTML editor', () => {
  it('creates and reopens exact script input and expected stdout', async () => {
    const researcher = await signIn(await seedUser());
    const config = scriptConfig({
      tests: [
        { id: 'exact', stdin: '\r\n  leading  \r\n\r\n', expectedStdout: '  answer  \r\n\r\n' },
        { id: 'empty', stdin: '', expectedStdout: '' },
      ],
    });
    const assignmentId = await createViaHtml(researcher, config);
    const base = `/assignments/${assignmentId}`;

    const detail = await (await get(base, researcher)).text();
    expect(detail).toContain('Script assignment');
    expect(detail).toContain('Standard input');
    expect(detail).toContain('Expected stdout');
    expect(detail).toContain('script-stdout-v1');
    expect(detail).toContain('(empty string)');

    const edit = await (await get(`${base}/edit`, researcher)).text();
    expect(edit).toContain('value="script" selected');
    expect(scriptTextarea(edit, 'stdin')).toBe('\r\n  leading  \r\n\r\n');
    expect(scriptTextarea(edit, 'expectedStdout')).toBe('  answer  \r\n\r\n');
    expect(scriptTextarea(edit, 'stdin', 1)).toBe('');
    expect(scriptTextarea(edit, 'expectedStdout', 1)).toBe('');
  });

  it('warns about a format switch and preserving text on validation errors', async () => {
    const researcher = await signIn(await seedUser());
    const createPage = await (await get('/assignments/new', researcher)).text();
    expect(createPage).toContain('Switching format always creates a new assignment version');
    expect(createPage).toContain('Tests must be configured for the new format');
    expect(createPage).toContain('data-format-field="script"');
    expect(createPage).toContain('id="format-switch-warning"');

    const invalid = scriptConfig({
      tests: [
        { id: 'same', stdin: '  first\r\n', expectedStdout: '  output  \r\n' },
        { id: 'same', stdin: '', expectedStdout: '' },
      ],
    });
    const response = await postForm('/assignments', formFields(invalid), researcher);
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('already used in this test suite');
    expect(scriptTextarea(html, 'stdin')).toBe('  first\r\n');
    expect(scriptTextarea(html, 'expectedStdout')).toBe('  output  \r\n');
    expect(await countRows('assignments')).toBe(0);
  });

  it('creates a new version and suite on a format switch while old function evidence stays readable', async () => {
    const researcher = await signIn(await seedUser());
    const original = await createViaApi(researcher);
    const base = `/assignments/${original.assignmentId}`;

    const switched = await postForm(
      base,
      formFields(scriptConfig({ title: 'Add two numbers script' }), original.id),
      researcher,
    );
    expect(switched.status).toBe(303);
    expect(switched.headers.get('location')).toBe(base);

    const active = await (await get(base, researcher)).text();
    expect(active).toContain('Script assignment');
    expect(active).toContain('Version 2');
    expect(active).toContain('Add two numbers script');
    expect(active).toContain('Standard input');

    const history = await (await get(`${base}/history`, researcher)).text();
    expect(history).toContain('Version 2');
    expect(history).toContain('Version 1');
    expect(history.indexOf('Version 2')).toBeLessThan(history.indexOf('Version 1'));

    const old = await (await get(`${base}/versions/${original.id}`, researcher)).text();
    expect(old).toContain('Function assignment');
    expect(old).toContain('not the active version');
    expect(old).toContain('[[4, -1]]');
    expect(old).toContain('first_positive');
    expect(old).not.toContain('Add two numbers script');

    const noOp = await postForm(
      base,
      formFields(scriptConfig({ title: 'Add two numbers script' }), original.id),
      researcher,
    );
    // The function base is stale now; a no-op must reuse the script active version.
    expect(noOp.status).toBe(409);
  });

  it('saves unchanged script text as a no-op and keeps whitespace-distinct expectations as a change', async () => {
    const researcher = await signIn(await seedUser());
    const assignmentId = await createViaHtml(researcher, scriptConfig());
    const base = `/assignments/${assignmentId}`;
    const active = await (await get(`${base}/edit`, researcher)).text();
    const baseVersionId = /name="baseVersionId" value="([^"]+)"/.exec(active)?.[1];
    expect(baseVersionId).toBeTruthy();

    const fields = formFields(scriptConfig(), baseVersionId);
    delete fields['tests[0][stdin]'];
    delete fields['tests[0][expectedStdout]'];
    fields['tests[0][stdinText]'] = '"1\\n2\\n"';
    fields['tests[0][expectedStdoutText]'] = '"3\\n"';
    const unchanged = await postForm(base, fields, researcher);
    expect(unchanged.status).toBe(303);
    expect(unchanged.headers.get('location')).toBe(`${base}?notice=unchanged`);

    const distinct = scriptConfig({
      tests: [
        { id: 'two-values', stdin: '1\n2\n', expectedStdout: '3\n\n' },
        { id: 'empty', stdin: '', expectedStdout: '' },
      ],
    });
    const changed = await postForm(base, formFields(distinct, baseVersionId), researcher);
    expect(changed.status).toBe(303);
    expect(changed.headers.get('location')).toBe(base);
    expect(await countRows('assignment_versions')).toBe(2);

    const old = await (await get(`${base}/versions/${baseVersionId}`, researcher)).text();
    expect(old).toContain('Version 1');
  });
});

function scriptTextarea(
  html: string,
  field: 'stdin' | 'expectedStdout',
  index = 0,
): string {
  const markup = new RegExp(
    `<textarea name="tests\\[${index}\\]\\[${field}\\]"[^>]*>\\n([\\s\\S]*?)</textarea>`,
  ).exec(html);
  expect(markup).not.toBeNull();
  return markup![1]!
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
