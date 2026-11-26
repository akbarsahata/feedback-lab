import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/coordinator';
import {
  DatasetFreezeError,
  DatasetNotFoundError,
  DatasetRevisionConflictError,
  DatasetStateError,
  freezeDataset,
  getDatasetRevision,
  getScoringRead,
  getStudyEvidence,
  importDatasetPackage,
  launchDatasetRun,
  listStudyCases,
  releaseDataset,
} from '../src/dataset-repository';
import { parseDatasetPackage, type ParsedDatasetPackage } from '../src/dataset-package';
import { markRunIncomplete } from '../src/runs';
import { countRows, seedUser, type TestUser } from './helpers';
import { validPackageBundle, type PackageBundle } from './dataset-fixtures';
import {
  DATASET_NOW as NOW,
  passingRunner,
  runEverySubmission,
  signEveryCase,
} from './dataset-helpers';

async function imported(
  bundle: PackageBundle,
  user: TestUser,
): Promise<{ parsed: ParsedDatasetPackage; revisionId: string; created: boolean }> {
  const result = parseDatasetPackage(bundle);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const imported = await importDatasetPackage(env.DB, result.package, bundle, user.id, NOW);
  return { parsed: result.package, ...imported };
}

describe('dataset repository', () => {
  it('imports a draft once and rejects changed contents under the same revision label', async () => {
    const researcher = await seedUser();
    const bundle = validPackageBundle();
    const first = await imported(bundle, researcher);
    expect(first.created).toBe(true);
    expect(await countRows('dataset_cases')).toBe(12);
    expect(await countRows('dataset_submissions')).toBe(20);
    expect(await countRows('assignment_versions')).toBe(4);

    const again = await imported(bundle, researcher);
    expect(again.created).toBe(false);
    expect(again.revisionId).toBe(first.revisionId);
    expect(await countRows('dataset_cases')).toBe(12);

    const changed = validPackageBundle();
    changed.manifest.submissions['cases/dev-fn-clean/single.py'] = { text: 'print(2)\n' };
    await expect(imported(changed, researcher)).rejects.toBeInstanceOf(DatasetRevisionConflictError);
  });

  it('refuses to freeze until every case is signed off and every submission has a usable run', async () => {
    const researcher = await seedUser();
    const { revisionId } = await imported(validPackageBundle(), researcher);

    await expect(freezeDataset(env.DB, revisionId, researcher.id, NOW))
      .rejects.toBeInstanceOf(DatasetFreezeError);

    await signEveryCase(revisionId, researcher.id);
    const withoutRuns = await freezeDataset(env.DB, revisionId, researcher.id, NOW).catch(
      (error: unknown) => error,
    );
    expect(withoutRuns).toBeInstanceOf(DatasetFreezeError);
    expect((withoutRuns as DatasetFreezeError).issues.join('\n')).toContain('record a study run');

    await runEverySubmission(revisionId, researcher.id);
    const frozen = await freezeDataset(env.DB, revisionId, researcher.id, NOW);
    expect(frozen.status).toBe('frozen');
    expect(frozen.cases[0]!.signoff?.evidenceNote).toContain('Checked the rubric');
    expect(frozen.cases.flatMap((datasetCase) => datasetCase.submissions)
      .every((submission) => submission.frozenRunId !== null)).toBe(true);

    await expect(
      launchDatasetRun(env.DB, revisionId, frozen.cases[0]!.submissions[0]!.id, researcher.id, NOW),
    ).rejects.toBeInstanceOf(DatasetStateError);
  });

  it('invalidates a sign-off when scored contents change before freeze', async () => {
    const researcher = await seedUser();
    const { revisionId } = await imported(validPackageBundle(), researcher);
    await signEveryCase(revisionId, researcher.id);
    await runEverySubmission(revisionId, researcher.id);

    const detail = await getDatasetRevision(env.DB, revisionId);
    const submission = detail.cases.find((datasetCase) => datasetCase.caseKey === 'dev-fn-fix')!
      .submissions.find((value) => value.version === 'original')!;
    await env.DB
      .prepare('UPDATE dataset_submissions SET scoring_json = ? WHERE id = ?')
      .bind(JSON.stringify({ clean: true, errors: [] }), submission.id)
      .run();

    const error = await freezeDataset(env.DB, revisionId, researcher.id, NOW).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(DatasetFreezeError);
    expect((error as DatasetFreezeError).issues.join('\n')).toContain('changed after sign-off');
  });

  it('blocks freeze when a clean submission does not pass every supplied test', async () => {
    const researcher = await seedUser();
    const { revisionId } = await imported(validPackageBundle(), researcher);
    await signEveryCase(revisionId, researcher.id);
    await runEverySubmission(revisionId, researcher.id);

    const detail = await getDatasetRevision(env.DB, revisionId);
    const runId = detail.cases.find((datasetCase) => datasetCase.caseKey === 'dev-fn-clean')!
      .submissions[0]!.attempts[0]!.runId;
    await env.DB
      .prepare(
        `UPDATE test_results SET status = 'mismatch'
         WHERE run_id = ?
           AND test_id = (SELECT test_id FROM tests
                          WHERE test_suite_version_id =
                            (SELECT test_suite_version_id FROM test_runs WHERE id = ?)
                          ORDER BY position LIMIT 1)`,
      )
      .bind(runId, runId)
      .run();

    const error = await freezeDataset(env.DB, revisionId, researcher.id, NOW).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(DatasetFreezeError);
    expect((error as DatasetFreezeError).issues.join('\n')).toContain(
      'clean submission must pass every supplied study test',
    );
  });

  it('keeps failed attempts and pins the successful retry', async () => {
    const researcher = await seedUser();
    const { revisionId } = await imported(validPackageBundle({ minimal: true }), researcher);
    const detail = await getDatasetRevision(env.DB, revisionId);
    const submission = detail.cases[0]!.submissions[0]!;

    const first = await launchDatasetRun(env.DB, revisionId, submission.id, researcher.id, NOW);
    await markRunIncomplete(
      env.DB,
      first.runId,
      'The runner became unavailable.',
      '2026-11-27T09:01:00.000Z',
    );

    const second = await launchDatasetRun(env.DB, revisionId, submission.id, researcher.id, NOW);
    await executeRun({ DB: env.DB }, second.runId, { runner: passingRunner() });

    const after = await getDatasetRevision(env.DB, revisionId);
    const attempts = after.cases[0]!.submissions[0]!.attempts;
    expect(attempts.map((attempt) => attempt.runStatus)).toEqual(['incomplete', 'complete']);
    expect(await countRows('dataset_attempts')).toBe(2);
  });

  it('enforces pilot and held-out access and keeps evidence free of keys and pair links', async () => {
    const researcher = await seedUser();
    const { revisionId } = await imported(validPackageBundle(), researcher);
    await signEveryCase(revisionId, researcher.id);
    await runEverySubmission(revisionId, researcher.id);
    await freezeDataset(env.DB, revisionId, researcher.id, NOW);

    const pilot = await listStudyCases(env.DB, revisionId, 'pilot');
    expect(pilot.map((studyCase) => studyCase.caseKey)).toEqual([
      'dev-fn-clean',
      'dev-fn-fix',
      'dev-fn-partial',
      'dev-io-clean',
      'dev-io-fix',
      'dev-io-partial',
    ]);

    const detail = await getDatasetRevision(env.DB, revisionId);
    const heldSubmission = detail.cases.find((datasetCase) => datasetCase.split === 'held_out')!
      .submissions[0]!;
    await expect(
      getStudyEvidence(env.DB, revisionId, 'pilot', heldSubmission.id),
    ).rejects.toBeInstanceOf(DatasetNotFoundError);
    await expect(listStudyCases(env.DB, revisionId, 'main')).rejects.toBeInstanceOf(
      DatasetNotFoundError,
    );

    await releaseDataset(env.DB, revisionId, researcher.id, 'study-protocol/2026-11-30', NOW);
    const main = await listStudyCases(env.DB, revisionId, 'main');
    expect(main.length).toBe(6);

    const mainCase = main.find((studyCase) => studyCase.caseKey === 'held-fn-partial')!;
    const evidence = await getStudyEvidence(
      env.DB,
      revisionId,
      'main',
      mainCase.submissionIds[0]!,
    );
    expect(Object.keys(evidence).sort()).toEqual(
      ['assignment', 'format', 'submission'].sort(),
    );
    expect(Object.keys(evidence.submission).sort()).toEqual(['source', 'tests']);
    expect(JSON.stringify(evidence)).not.toContain('targeted');
    expect(JSON.stringify(evidence)).not.toContain('original');
    expect(JSON.stringify(evidence)).not.toContain('corrected');
    expect(JSON.stringify(evidence)).not.toContain('held-fn-partial');

    const scoring = await getScoringRead(env.DB, revisionId, 'main', 'held-fn-partial');
    expect(scoring.targetedErrorIds).toEqual(['case-sensitive']);
    expect(scoring.submissions.map((submission) => submission.version)).toEqual([
      'corrected',
      'original',
    ]);

    await expect(
      getStudyEvidence(env.DB, revisionId, 'pilot', mainCase.submissionIds[0]!),
    ).rejects.toBeInstanceOf(DatasetNotFoundError);

    const next = validPackageBundle();
    next.manifest.revision = '2026-11-28.1';
    next.scoring.revision = '2026-11-28.1';
    next.verification.revision = '2026-11-28.1';
    const moved = next.manifest.cases.find((value: any) => value.id === 'held-fn-clean');
    moved.split = 'development';
    moved.familyId = 'family-first-match-copy';
    await expect(imported(next, researcher)).rejects.toBeInstanceOf(DatasetStateError);
  });
});
