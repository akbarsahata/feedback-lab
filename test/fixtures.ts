import type { AssignmentVersionPayload } from '../src/api-schemas';
import type { RawConfig } from '../src/config';

export type SerializedVersion = AssignmentVersionPayload;

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

export function scriptConfig(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    title: 'Add two numbers',
    description:
      'Read one integer per line from standard input and print their total.',
    format: 'script',
    criteria: [
      {
        id: 'r1',
        description: 'Reads to EOF',
        expectedBehavior: 'Reads every line instead of only the first.',
      },
    ],
    tests: [
      { id: 'two-values', stdin: '1\n2\n', expectedStdout: '3\n' },
      { id: 'empty', stdin: '', expectedStdout: '' },
    ],
    ...overrides,
  };
}

export function versionToRawConfig(version: AssignmentVersionPayload): RawConfig {
  return {
    title: version.title,
    description: version.description,
    format: version.format,
    entryPoint: version.format === 'function' ? version.entryPoint : undefined,
    criteria: version.rubric.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      expectedBehavior: criterion.expectedBehavior,
    })),
    tests: version.format === 'function'
      ? version.testSuite.tests.map((test) => ({
          id: test.id,
          arguments: test.argumentsJson,
          expectedReturn: test.expectedReturnJson,
        }))
      : version.testSuite.tests.map((test) => ({
          id: test.id,
          stdin: test.stdin,
          expectedStdout: test.expectedStdout,
        })),
  };
}
