import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDatasetRevision } from '../src/dataset-repository';
import {
  apiJson,
  countRows,
  postForm,
  postMultipart,
  seedUser,
  signIn,
  type SignedIn,
} from './helpers';
import { validPackageBundle, type PackageBundle } from './dataset-fixtures';
import {
  recordProtocolLock,
  runEverySubmission,
  signEveryCase,
  STUDY_PROTOCOL,
} from './dataset-helpers';

const BASE_URL = 'https://feedback-lab.test';

function importForm(
  session: SignedIn,
  bundle: PackageBundle,
  options: { includeCsrf?: boolean } = {},
): FormData {
  const form = new FormData();
  if (options.includeCsrf !== false) form.set('_csrf', session.csrfToken);
  for (const name of ['manifest', 'scoring', 'verification'] as const) {
    form.set(
      name,
      new File([JSON.stringify(bundle[name])], `${name}.json`, { type: 'application/json' }),
    );
  }
  return form;
}

async function importViaUi(session: SignedIn, bundle: PackageBundle): Promise<string> {
  const response = await postMultipart('/datasets/import', importForm(session, bundle), session);
  expect(response.status).toBe(303);
  const location = response.headers.get('location') ?? '';
  const match = /^\/datasets\/([^/?]+)/.exec(location);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('dataset pages and study API', () => {
  it('imports a package through the researcher UI and shows the verification workspace', async () => {
    const researcher = await signIn(await seedUser());
    const library = await SELF.fetch(`${BASE_URL}/datasets`, {
      headers: { cookie: researcher.cookie },
    });
    expect(library.status).toBe(200);
    expect(await library.text()).toContain('Import a package');

    const bundle = validPackageBundle();
    const sources = bundle.manifest.submissions;
    delete bundle.manifest.submissions;
    const form = importForm(researcher, bundle);
    for (const datasetCase of bundle.manifest.cases) {
      for (const submission of datasetCase.submissions) {
        const path = `${datasetCase.id}-${submission.version}.py`;
        form.append('sources', new File([sources[submission.path].text], path));
        for (const error of bundle.scoring.cases[datasetCase.id].submissions[submission.version].errors) {
          for (const evidence of error.evidence) if (evidence.kind === 'source') evidence.path = path;
        }
        submission.path = path;
      }
    }
    form.set('manifest', new File([JSON.stringify(bundle.manifest)], 'manifest.json'));
    form.set('scoring', new File([JSON.stringify(bundle.scoring)], 'scoring-key.json'));
    const imported = await postMultipart('/datasets/import', form, researcher);
    expect(imported.status, await imported.text()).toBe(303);
    const revisionId = imported.headers.get('location')?.split(/[/?]/)[2];
    expect(await countRows('datasets')).toBe(1);
    expect(await countRows('dataset_cases')).toBe(12);

    const detail = await SELF.fetch(`${BASE_URL}/datasets/${revisionId}`, {
      headers: { cookie: researcher.cookie },
    });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('dev-fn-partial');
    expect(html).toContain('held-io-partial');
    expect(html).toContain('Sign off case');
    expect(html).toContain('Record study run');
    expect(html).toContain('Freeze revision');
    expect(html).toContain('Source lines 1–2');
    expect(html).toContain('The supplied study suite distinguishes');
  });

  it('rejects malformed packages with case-level errors and creates nothing', async () => {
    const researcher = await signIn(await seedUser());
    const bundle = validPackageBundle();
    const held = bundle.manifest.cases.find((value: any) => value.id === 'held-fn-clean');
    held.familyId = 'family-range-count';

    const response = await postMultipart(
      '/datasets/import',
      importForm(researcher, bundle),
      researcher,
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('case.held-fn-clean.family');
    expect(await countRows('datasets')).toBe(0);
    expect(await countRows('assignment_versions')).toBe(0);
  });

  it('requires researcher access and CSRF for imports and sign-offs', async () => {
    const member = await signIn(await seedUser('member'));
    const memberPage = await SELF.fetch(`${BASE_URL}/datasets`, {
      headers: { cookie: member.cookie },
    });
    expect(memberPage.status).toBe(403);

    const signedOut = await SELF.fetch(`${BASE_URL}/datasets`, { redirect: 'manual' });
    expect(signedOut.status).toBe(303);

    const researcher = await signIn(await seedUser());
    const noCsrf = await postMultipart(
      '/datasets/import',
      importForm(researcher, validPackageBundle(), { includeCsrf: false }),
      researcher,
    );
    expect(noCsrf.status).toBe(403);

    const revisionId = await importViaUi(researcher, validPackageBundle());
    const badSignoff = await postForm(
      `/datasets/${revisionId}/sign-off`,
      { caseKey: 'dev-fn-clean' },
      researcher,
      { includeCsrf: false },
    );
    expect(badSignoff.status).toBe(403);
  });

  it('records a sign-off and blocks freeze until runs exist', async () => {
    const researcher = await signIn(await seedUser());
    const revisionId = await importViaUi(researcher, validPackageBundle());

    const signoff = await postForm(
      `/datasets/${revisionId}/sign-off`,
      {
        caseKey: 'dev-fn-clean',
        evidenceNote: 'Checked the rubric, source lines, and supplied tests.',
      },
      researcher,
    );
    expect(signoff.status).toBe(303);

    const blankNote = await postForm(
      `/datasets/${revisionId}/sign-off`,
      { caseKey: 'dev-fn-fix', evidenceNote: '  ' },
      researcher,
    );
    expect(blankNote.status).toBe(409);

    const blocked = await postForm(`/datasets/${revisionId}/freeze`, {}, researcher);
    expect(blocked.status).toBe(409);
    const html = await blocked.text();
    expect(html).toContain('Freeze is blocked');
    expect(html).toContain('record a study run');

    const detail = await SELF.fetch(`${BASE_URL}/datasets/${revisionId}`, {
      headers: { cookie: researcher.cookie },
    });
    expect(await detail.text()).toContain('Signed off');
  });

  it('launches a study run from the dataset page and opens its pinned run', async () => {
    const researcher = await signIn(await seedUser());
    const revisionId = await importViaUi(researcher, validPackageBundle());
    const detail = await getDatasetRevision(env.DB, revisionId);
    const submission = detail.cases[0]!.submissions[0]!;

    const response = await postForm(
      `/datasets/${revisionId}/runs`,
      { submissionId: submission.id },
      researcher,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
    const duplicate = await postForm(
      `/datasets/${revisionId}/runs`, { submissionId: submission.id }, researcher,
    );
    expect(duplicate.status).toBe(409);
    expect(await countRows('dataset_attempts')).toBe(1);
  });

  it('freezes through the UI, releases held-out cases, and keeps study reads separated', async () => {
    const researcher = await signIn(await seedUser());
    const revisionId = await importViaUi(researcher, validPackageBundle());
    await signEveryCase(revisionId, researcher.user.id);
    await runEverySubmission(revisionId, researcher.user.id);

    const frozen = await postForm(`/datasets/${revisionId}/freeze`, {}, researcher);
    expect(frozen.status).toBe(303);

    const before = await apiJson(`/api/datasets/${revisionId}/study/cases?use=main`, {
      session: researcher,
    });
    expect(before.response.status).toBe(404);

    const pilot = await apiJson(`/api/datasets/${revisionId}/study/cases?use=pilot`, {
      session: researcher,
    });
    expect(pilot.response.status).toBe(200);
    expect(pilot.body.cases.map((studyCase: any) => studyCase.caseKey)).toEqual([
      'dev-fn-clean',
      'dev-fn-fix',
      'dev-fn-partial',
      'dev-io-clean',
      'dev-io-fix',
      'dev-io-partial',
    ]);

    const releaseHeldOut = (studyProtocolRef: string) =>
      postForm(`/datasets/${revisionId}/release`, { studyProtocolRef }, researcher);
    expect((await releaseHeldOut(STUDY_PROTOCOL)).status).toBe(409);
    await recordProtocolLock(revisionId, researcher.user.id);
    expect((await releaseHeldOut('other-study')).status).toBe(409);
    const release = await releaseHeldOut(STUDY_PROTOCOL);
    expect(release.status).toBe(303);

    const main = await apiJson(`/api/datasets/${revisionId}/study/cases?use=main`, {
      session: researcher,
    });
    expect(main.response.status).toBe(200);
    expect(main.body.cases.length).toBe(6);
    const heldCase = main.body.cases.find((studyCase: any) => studyCase.caseKey === 'held-fn-fix');
    const evidence = await apiJson(
      `/api/datasets/${revisionId}/study/evidence/${heldCase.submissionIds[0]}?use=main`,
      { session: researcher },
    );
    expect(evidence.response.status).toBe(200);
    expect(JSON.stringify(evidence.body)).not.toContain('targeted');
    expect(evidence.body.evidence.submission.source).toContain('def first_name_containing');

    const pilotDenied = await apiJson(
      `/api/datasets/${revisionId}/study/evidence/${heldCase.submissionIds[0]}?use=pilot`,
      { session: researcher },
    );
    expect(pilotDenied.response.status).toBe(404);

    const memberList = await apiJson(`/api/datasets/${revisionId}/study/cases?use=pilot`, {
      session: await signIn(await seedUser('member')),
    });
    expect(memberList.response.status).toBe(403);

    const detail = await SELF.fetch(`${BASE_URL}/datasets/${revisionId}`, {
      headers: { cookie: researcher.cookie },
    });
    expect(await detail.text()).toContain('Held-out cases released');
  });
});
