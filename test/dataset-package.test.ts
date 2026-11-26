import { describe, expect, it } from 'vitest';
import { parseDatasetPackage, type DatasetPackageFiles } from '../src/dataset-package';
import { validPackageBundle } from './dataset-fixtures';

function edit<T>(value: T, change: (copy: any) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

function files(packageBundle = validPackageBundle({ minimal: true })): DatasetPackageFiles {
  return {
    manifest: packageBundle.manifest,
    scoring: packageBundle.scoring,
    verification: packageBundle.verification,
  };
}

function errorKeys(result: ReturnType<typeof parseDatasetPackage>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.key);
}

describe('dataset package validation', () => {
  it('accepts a paired corpus and keeps submissions, keys, and authoring checks separate', () => {
    const result = parseDatasetPackage(files());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.revision).toBe('2026-11-27.1');
    expect(result.package.cases.map((datasetCase) => datasetCase.id)).toEqual([
      'dev-fn-clean',
      'dev-fn-fix',
      'dev-fn-partial',
      'dev-io-clean',
      'held-fn-clean',
      'held-io-clean',
    ]);
    const partial = result.package.cases.find((datasetCase) => datasetCase.id === 'dev-fn-partial');
    expect(partial?.pair?.targetedErrorIds).toEqual(['inverted-test']);
    expect(partial?.submissions.map((submission) => submission.version)).toEqual([
      'original',
      'corrected',
    ]);
    expect(partial?.submissions[0]?.source).toContain('def count_in_range');
    expect(partial?.submissions[0]?.path).toBe('cases/dev-fn-partial/original.py');
    expect(result.package.coverage).toEqual({
      development: {
        function: { clean: 1, fixed: 1, partial: 1 },
        script: { clean: 1, fixed: 0, partial: 0 },
      },
      held_out: {
        function: { clean: 1, fixed: 0, partial: 0 },
        script: { clean: 1, fixed: 0, partial: 0 },
      },
    });
  });

  it('reports a case-level error when a pair crosses splits or families', () => {
    const split = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      const source = bundle.manifest.cases.find((value: any) => value.id === 'dev-fn-clean').submissions[0];
      const held = bundle.manifest.cases.find((value: any) => value.id === 'held-fn-clean');
      held.submissions[0].path = source.path;
    })));
    expect(errorKeys(split)).toContain('case.held-fn-clean.split');

    const family = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      const datasetCase = bundle.manifest.cases.find((value: any) => value.id === 'held-fn-clean');
      datasetCase.familyId = 'family-range-count';
    })));
    expect(errorKeys(family)).toContain('case.held-fn-clean.family');
  });

  it('rejects a pair whose versions use different assignment revisions', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      const datasetCase = bundle.manifest.cases.find((value: any) => value.id === 'dev-fn-fix');
      datasetCase.submissions[1].assignmentRevision = '2';
    })));

    expect(errorKeys(result)).toContain('case.dev-fn-fix.assignmentRevision');
  });

  it('rejects a targeted key that does not exist in the original or survives the correction', () => {
    const missing = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.scoring.cases['dev-fn-fix'].submissions.original.errors[0].id = 'other';
    })));
    expect(errorKeys(missing)).toContain('scoring.dev-fn-fix.targetedErrorIds');

    const surviving = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.scoring.cases['dev-fn-fix'].submissions.corrected.errors.push({
        id: 'off-by-one',
        requirement: 'inclusive-bounds',
        evidence: [{ kind: 'source', path: 'cases/dev-fn-fix/corrected.py', startLine: 2, endLine: 2 }],
        note: 'The corrected submission should not keep the targeted error.',
      });
    })));
    expect(errorKeys(surviving)).toContain('scoring.dev-fn-fix.corrected.targeted');
  });

  it('rejects key evidence that does not resolve against its submission or assignment', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.scoring.cases['dev-fn-clean'].submissions.single.errors = [{
        id: 'bad-range',
        requirement: 'missing-criterion',
        evidence: [{ kind: 'source', path: 'cases/dev-fn-clean/single.py', startLine: 40, endLine: 41 }],
        note: 'Out of range.',
      }];
    })));

    expect(errorKeys(result)).toContain('scoring.dev-fn-clean.single.errors.0.requirement');
    expect(errorKeys(result)).toContain('scoring.dev-fn-clean.single.errors.0.evidence.0');
  });

  it('rejects duplicate or missing scoring entries', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      delete bundle.scoring.cases['dev-io-clean'];
    })));

    expect(errorKeys(result)).toContain('scoring.dev-io-clean');
  });

  it('rejects malformed sources and unsupported revision labels', () => {
    const invalidUtf8 = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.manifest.submissions['cases/dev-fn-clean/single.py'] = {
        text: '//4=',
        encoding: 'base64',
      };
    })));
    expect(errorKeys(invalidUtf8)).toContain('submission.cases/dev-fn-clean/single.py');

    const revision = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.manifest.revision = 'v1';
    })));
    expect(errorKeys(revision)).toContain('revision');
  });

  it('accepts a buggy single submission scored as not clean', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.scoring.cases['dev-fn-clean'].submissions.single = {
        clean: false,
        errors: [{
          id: 'empty-range',
          requirement: 'inclusive-bounds',
          evidence: [{ kind: 'source', path: 'cases/dev-fn-clean/single.py', startLine: 2, endLine: 2 }],
          note: 'Does not handle an empty range.',
        }],
      };
    })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.cases.find((datasetCase) => datasetCase.id === 'dev-fn-clean')?.submissions[0]?.key.clean).toBe(false);
    expect(result.package.coverage.development.function.clean).toBe(0);
  });

  it('rejects a pair that reuses one source file', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      const datasetCase = bundle.manifest.cases.find((value: any) => value.id === 'dev-fn-fix');
      datasetCase.submissions[1].path = datasetCase.submissions[0].path;
    })));
    expect(errorKeys(result)).toContain('case.dev-fn-fix.submissions');
  });

  it('reports malformed test rows instead of dropping them', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.manifest.assignments['range-count'].tests.push('not-a-test');
    })));
    expect(errorKeys(result)).toContain('assignment.range-count.tests.2');
  });

  it('rejects verification entries for unknown cases', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.verification.cases['unknown-case'] = { authoringChecks: [] };
    })));
    expect(errorKeys(result)).toContain('verification.unknown-case');
  });

  it('preserves a UTF-8 BOM in the stored source bytes', () => {
    const source = '\ufeffdef count_in_range(values, low, high):\n    return 0\n';
    const bytes = new TextEncoder().encode(source);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      bundle.manifest.submissions['cases/dev-fn-clean/single.py'] = {
        text: btoa(binary),
        encoding: 'base64',
      };
    })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const submission = result.package.cases.find((datasetCase) => datasetCase.id === 'dev-fn-clean')!
      .submissions[0]!;
    expect([...submission.sourceBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(submission.source.startsWith('\ufeff')).toBe(true);
  });

  it('reports the required coverage so a freeze can refuse an incomplete corpus', () => {
    const result = parseDatasetPackage(files(edit(validPackageBundle({ minimal: true }), (bundle) => {
      for (const id of ['dev-fn-clean', 'dev-fn-fix', 'dev-fn-partial']) {
        bundle.manifest.cases = bundle.manifest.cases.filter((value: any) => value.id !== id);
        delete bundle.scoring.cases[id];
        delete bundle.verification.cases[id];
      }
    })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.coverage.development.function).toEqual({ clean: 0, fixed: 0, partial: 0 });
  });
});
