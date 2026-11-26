import { describe, expect, it } from 'vitest';
import { parseDatasetPackage } from '../src/dataset-package';
import manifest from '../examples/dataset-package/manifest.json';
import scoring from '../examples/dataset-package/scoring.json';
import verification from '../examples/dataset-package/verification.json';

describe('disposable example package', () => {
  it('stays valid under the current package format', () => {
    const result = parseDatasetPackage({ manifest, scoring, verification });
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.package.datasetId).toBe('example-intro-python');
    expect(result.package.cases).toHaveLength(2);
  });
});
