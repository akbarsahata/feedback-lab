import type { RawConfig } from '../src/config';

export interface SerializedVersion {
  id: string;
  assignmentId: string;
  versionNumber: number;
  title: string;
  description: string;
  format: 'function';
  entryPoint: string;
  rubricVersionId: string;
  testSuiteVersionId: string;
  rubric: {
    versionId: string;
    criteria: Array<{ id: string; description: string; expectedBehavior: string }>;
  };
  testSuite: {
    versionId: string;
    comparisonRule: string;
    tests: Array<{
      id: string;
      arguments: unknown;
      argumentsJson: string;
      expectedReturn: unknown;
      expectedReturnJson: string;
      comparisonRule: string;
    }>;
  };
  createdAt: string;
  createdBy: { id: string; email: string };
}

export function assignmentConfig(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    title: 'First positive value',
    description:
      'Implement first_positive(values). Return the first positive integer, or None if no positive value exists.',
    entryPoint: 'first_positive',
    criteria: [
      {
        id: 'r1',
        description: 'Iteration order',
        expectedBehavior: 'Checks every item in order starting at index 0.',
      },
      {
        id: 'r2',
        description: 'No positive value',
        expectedBehavior: 'Returns None for an empty or non-positive list.',
      },
    ],
    tests: [
      { id: 'list-argument', arguments: '[[4, -1]]', expectedReturn: '4' },
      { id: 'empty-list', arguments: '[[]]', expectedReturn: 'null' },
    ],
    ...overrides,
  };
}

export function versionToRawConfig(version: SerializedVersion): RawConfig {
  return {
    title: version.title,
    description: version.description,
    entryPoint: version.entryPoint,
    criteria: version.rubric.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      expectedBehavior: criterion.expectedBehavior,
    })),
    tests: version.testSuite.tests.map((test) => ({
      id: test.id,
      arguments: test.argumentsJson,
      expectedReturn: test.expectedReturnJson,
    })),
  };
}
