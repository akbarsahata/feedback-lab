import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/coordinator';
import type { Runner } from '../src/runner';
import { getTestRun, MAX_SOURCE_BYTES } from '../src/runs';
import {
  countRows,
  postJson,
  postMultipart,
  seedUser,
  signIn,
  type SignedIn,
} from './helpers';
import { assignmentConfig, type SerializedVersion } from './fixtures';

const BASE_URL = 'https://feedback-lab.test';
const SOURCE = 'def first_positive(values):\n    return next((v for v in values if v > 0), None)\n';

async function createAssignment(session: SignedIn): Promise<SerializedVersion> {
  const { response, body } = await postJson('/api/assignments', {
    config: assignmentConfig(),
  }, session);
  expect(response.status).toBe(201);
  return body.version as SerializedVersion;
}

function uploadForm(
  session: SignedIn,
  versionId: string,
  file: File | null,
): FormData {
  const form = new FormData();
  form.set('_csrf', session.csrfToken);
  form.set('versionId', versionId);
  if (file !== null) form.set('source', file);
  return form;
}

async function launch(
  session: SignedIn,
  version: SerializedVersion,
  source = SOURCE,
): Promise<string> {
  const response = await postMultipart(
    `/assignments/${version.assignmentId}/runs`,
    uploadForm(session, version.id, new File([source], 'submission.py', { type: 'text/x-python' })),
    session,
  );
  expect(response.status).toBe(303);
  const location = response.headers.get('location') ?? '';
  expect(location).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
  return location.slice('/runs/'.length);
}

describe('run launch', () => {
  it('accepts one UTF-8 Python file and opens a version-pinned run', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const source = 'def first_positive(values):\r\n    return 4\r\n';
    const runId = await launch(researcher, version, source);

    const run = await getTestRun(env.DB, runId);
    expect(run.status).toBe('queued');
    expect(new TextDecoder().decode(run.source)).toBe(source);
    expect(run.assignmentVersionId).toBe(version.id);
    expect(run.tests.map((test) => test.status)).toEqual(['pending', 'pending']);
  });

  it('rejects missing files, non-Python files, invalid UTF-8, and oversized files', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const path = `/assignments/${version.assignmentId}/runs`;

    const missing = await postMultipart(path, uploadForm(researcher, version.id, null), researcher);
    expect(missing.status).toBe(422);

    const wrongType = await postMultipart(
      path,
      uploadForm(researcher, version.id, new File(['print(1)'], 'submission.txt')),
      researcher,
    );
    expect(wrongType.status).toBe(422);

    const invalidUtf8 = await postMultipart(
      path,
      uploadForm(researcher, version.id, new File([new Uint8Array([0xff, 0xfe])], 'submission.py')),
      researcher,
    );
    expect(invalidUtf8.status).toBe(422);

    const oversized = await postMultipart(
      path,
      uploadForm(
        researcher,
        version.id,
        new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], 'submission.py'),
      ),
      researcher,
    );
    expect(oversized.status).toBe(413);
    expect(await countRows('test_runs')).toBe(0);
  });

  it('rejects a stale version without creating a run', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    await postJson(`/api/assignments/${version.assignmentId}/versions`, {
      baseVersionId: version.id,
      config: assignmentConfig({ title: 'Newer active version' }),
    }, researcher);

    const response = await postMultipart(
      `/assignments/${version.assignmentId}/runs`,
      uploadForm(researcher, version.id, new File([SOURCE], 'submission.py')),
      researcher,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('newer assignment version');
    expect(await countRows('test_runs')).toBe(0);
    expect(await countRows('submission_versions')).toBe(0);
  });

  it('requires researcher access and a valid CSRF token', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const path = `/assignments/${version.assignmentId}/runs`;

    const signedOut = await SELF.fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      body: uploadForm(researcher, version.id, new File([SOURCE], 'submission.py')),
      redirect: 'manual',
    });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toContain('/sign-in');

    const member = await signIn(await seedUser('member'));
    const memberUpload = await postMultipart(
      path,
      uploadForm(member, version.id, new File([SOURCE], 'submission.py')),
      member,
    );
    expect(memberUpload.status).toBe(403);

    const form = uploadForm(researcher, version.id, new File([SOURCE], 'submission.py'));
    form.set('_csrf', 'wrong-token');
    const blocked = await postMultipart(path, form, researcher);
    expect(blocked.status).toBe(403);
    expect(await countRows('test_runs')).toBe(0);
  });
});

describe('run results', () => {
  it('shows line-numbered source and per-test evidence with escaped values', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const source = 'def first_positive(values):\n    return "<script>alert(1)</script>"\n';
    const runId = await launch(researcher, version, source);
    const runner: Runner = {
      async runTest(job) {
        return {
          outcome: 'completed',
          actual: job.testId === 'list-argument'
            ? { kind: 'int', value: '4' }
            : { kind: 'none' },
          stdout: 'printed output',
          stderr: '',
          outputTruncated: false,
          diagnostic: null,
          executionMs: 11,
          startupMs: 50,
          warm: true,
        };
      },
    };
    await executeRun(env, runId, { runner });

    const page = await SELF.fetch(`${BASE_URL}/runs/${runId}`, {
      headers: { cookie: researcher.cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Complete');
    expect(html).toContain('Submitted source');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('2 / 2');
    expect(html).toContain('Pass');

    const evidence = await SELF.fetch(
      `${BASE_URL}/runs/${runId}/tests/list-argument`,
      { headers: { cookie: researcher.cookie } },
    );
    expect(evidence.status).toBe(200);
    const evidenceHtml = await evidence.text();
    expect(evidenceHtml).toContain('Actual return');
    expect(evidenceHtml).toContain('4');
    expect(evidenceHtml).toContain('printed output');
    expect(evidenceHtml).toContain('execution 11 ms');
    expect(evidenceHtml).toContain('startup 50 ms (warm reuse)');
  });

  it('denies signed-out and member reads without exposing source', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);
    const member = await signIn(await seedUser('member'));

    const signedOut = await SELF.fetch(`${BASE_URL}/runs/${runId}`, { redirect: 'manual' });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toContain('/sign-in');

    for (const path of [`/runs/${runId}`, `/runs/${runId}/tests/list-argument`]) {
      const response = await SELF.fetch(`${BASE_URL}${path}`, {
        headers: { cookie: member.cookie },
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('first_positive');
    }
  });

  it('shows pending work while a run has not started', async () => {
    const researcher = await signIn(await seedUser());
    const version = await createAssignment(researcher);
    const runId = await launch(researcher, version);

    const page = await SELF.fetch(`${BASE_URL}/runs/${runId}`, {
      headers: { cookie: researcher.cookie },
    });
    const html = await page.text();
    expect(html).toContain('Queued');
    expect(html).toContain('Waiting for the runner');
    expect(html).toContain('Pending');
  });
});
