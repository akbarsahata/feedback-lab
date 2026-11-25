import { describe, expect, it } from 'vitest';
import {
  COMPARISON_RULE,
  compareConfigs,
  validateConfig,
  type RawConfig,
} from '../src/config';

function validRaw(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    title: 'First positive value',
    description: 'Return the first positive integer, or None.',
    entryPoint: 'first_positive',
    criteria: [
      {
        id: 'r1',
        description: 'Iterates in order',
        expectedBehavior: 'Checks each item from index 0.',
      },
    ],
    tests: [
      { id: 't1', arguments: '[[4, -1]]', expectedReturn: '4' },
      { id: 't2', arguments: '[[]]', expectedReturn: 'null' },
    ],
    ...overrides,
  };
}

function expectValid(raw: RawConfig) {
  const result = validateConfig(raw);
  if (!result.ok) {
    throw new Error(`Expected valid config, got ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

describe('validateConfig', () => {
  it('round-trips the ticket examples and canonicalizes JSON', () => {
    const config = expectValid(
      validRaw({
        title: '  First positive value  ',
        tests: [
          { id: ' t1 ', arguments: '[[4, -1]]', expectedReturn: '4' },
          { id: 't2', arguments: '[[]]', expectedReturn: 'null' },
          { id: 't3', arguments: ' [4, -1] ', expectedReturn: '{"b": 1, "a": 2}' },
          { id: 't4', arguments: '[]', expectedReturn: '"text"' },
        ],
      }),
    );

    expect(config.title).toBe('First positive value');
    expect(config.tests.map((test) => test.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(config.tests[0]?.argumentsJson).toBe('[[4,-1]]');
    expect(config.tests[0]?.expectedReturnJson).toBe('4');
    expect(config.tests[1]?.expectedReturnJson).toBe('null');
    expect(config.tests[2]?.argumentsJson).toBe('[4,-1]');
    expect(config.tests[2]?.expectedReturnJson).toBe('{"a":2,"b":1}');
    expect(config.tests.every((test) => test.comparisonRule === COMPARISON_RULE)).toBe(true);
  });

  it('drops completely blank rows but keeps the entered rows in order', () => {
    const config = expectValid(
      validRaw({
        criteria: [
          { id: '', description: '', expectedBehavior: '' },
          { id: 'r2', description: 'Second', expectedBehavior: 'Behaves' },
          { id: 'r1', description: 'First', expectedBehavior: 'Behaves' },
        ],
        tests: [
          { id: '', arguments: '', expectedReturn: '' },
          { id: 't1', arguments: '[]', expectedReturn: 'true' },
        ],
      }),
    );

    expect(config.criteria.map((criterion) => criterion.id)).toEqual(['r2', 'r1']);
    expect(config.tests.map((test) => test.id)).toEqual(['t1']);
  });

  it('requires a title, description, and entry point', () => {
    const result = validateConfig(
      validRaw({ title: '   ', description: '', entryPoint: '' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toMatch(/title/i);
    expect(result.errors.description).toMatch(/description/i);
    expect(result.errors.entryPoint).toMatch(/function name|entry point/i);
  });

  it.each(['1abc', 'first-positive', 'first positive', 'def first_positive():'])(
    'rejects invalid entry point %s',
    (entryPoint) => {
      const result = validateConfig(validRaw({ entryPoint }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.entryPoint).toMatch(/identifier/i);
    },
  );

  it('rejects Python keywords but allows soft keywords', () => {
    const keyword = validateConfig(validRaw({ entryPoint: 'class' }));
    expect(keyword.ok).toBe(false);
    if (!keyword.ok) {
      expect(keyword.errors.entryPoint).toMatch(/keyword/i);
    }

    expect(expectValid(validRaw({ entryPoint: 'match' })).entryPoint).toBe('match');
    expect(expectValid(validRaw({ entryPoint: 'case' })).entryPoint).toBe('case');
    expect(expectValid(validRaw({ entryPoint: '_private1' })).entryPoint).toBe('_private1');
  });

  it('requires at least one criterion and one test', () => {
    const result = validateConfig(validRaw({ criteria: [], tests: [] }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.criteria?.message).toMatch(/at least one/i);
    expect(result.errors.tests?.message).toMatch(/at least one/i);
  });

  it('enforces criterion and test ID syntax', () => {
    const result = validateConfig(
      validRaw({
        criteria: [{ id: 'R1', description: 'x', expectedBehavior: 'y' }],
        tests: [{ id: 't 1', arguments: '[]', expectedReturn: '1' }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.criteria?.rows[0]?.id).toMatch(/lowercase letters, digits/i);
    expect(result.errors.tests?.rows[0]?.id).toMatch(/lowercase letters, digits/i);
  });

  it('reports duplicate IDs on the later row within each list only', () => {
    const result = validateConfig(
      validRaw({
        criteria: [
          { id: 'r1', description: 'First', expectedBehavior: 'x' },
          { id: 'r1', description: 'Second', expectedBehavior: 'y' },
        ],
        tests: [
          { id: 'r1', arguments: '[]', expectedReturn: '1' },
          { id: 't2', arguments: '[]', expectedReturn: '2' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.criteria?.rows[0]?.id).toBeUndefined();
    expect(result.errors.criteria?.rows[1]?.id).toMatch(/already used/i);
    expect(result.errors.tests).toBeUndefined();
  });

  it('reports incomplete rows on the affected fields', () => {
    const result = validateConfig(
      validRaw({
        criteria: [
          { id: 'r1', description: ' ', expectedBehavior: '' },
          { id: '', description: 'second', expectedBehavior: 'y' },
        ],
        tests: [{ id: 't1', arguments: '[]', expectedReturn: '  ' }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.criteria?.rows[0]?.description).toMatch(/description/i);
    expect(result.errors.criteria?.rows[0]?.expectedBehavior).toMatch(/expected behavior/i);
    expect(result.errors.criteria?.rows[1]?.id).toMatch(/ID/i);
    expect(result.errors.tests?.rows[0]?.expectedReturn).toMatch(/expected return/i);
  });

  it('distinguishes null from a blank expected return', () => {
    expect(expectValid(validRaw()).tests[1]?.expectedReturnJson).toBe('null');

    const blank = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '[]', expectedReturn: '' }] }),
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.errors.tests?.rows[0]?.expectedReturn).toMatch(/null/i);
    }
  });

  it('treats a JSON string "null" as a string, not Python None', () => {
    const config = expectValid(
      validRaw({ tests: [{ id: 't1', arguments: '[]', expectedReturn: '"null"' }] }),
    );
    expect(config.tests[0]?.expectedReturnJson).toBe('"null"');
  });

  it('rejects malformed JSON and non-array arguments', () => {
    const malformed = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '[1,]', expectedReturn: '1' }] }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors.tests?.rows[0]?.arguments).toMatch(/Invalid JSON/i);
    }

    const notArray = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '{"a": 1}', expectedReturn: '1' }] }),
    );
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) {
      expect(notArray.errors.tests?.rows[0]?.arguments).toMatch(/JSON array/i);
    }
  });

  it('rejects duplicate keys, non-finite numbers, and unsafe integers', () => {
    const duplicate = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '[{"a": 1, "a": 2}]', expectedReturn: '1' }] }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.errors.tests?.rows[0]?.arguments).toMatch(/duplicate/i);
    }

    const nonFinite = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '[]', expectedReturn: '1e999' }] }),
    );
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok) {
      expect(nonFinite.errors.tests?.rows[0]?.expectedReturn).toMatch(/finite/i);
    }

    const unsafe = validateConfig(
      validRaw({ tests: [{ id: 't1', arguments: '[]', expectedReturn: '9007199254740993' }] }),
    );
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.errors.tests?.rows[0]?.expectedReturn).toMatch(/integer/i);
    }
  });

  it('enforces the maximum number of nonblank rows', () => {
    const tooMany = validateConfig(
      validRaw({
        criteria: Array.from({ length: 101 }, (_, index) => ({
          id: `r${index}`,
          description: 'd',
          expectedBehavior: 'b',
        })),
      }),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.errors.criteria?.message).toMatch(/100/);
    }
  });
});

describe('compareConfigs', () => {
  const base = expectValid(validRaw());

  it('treats whitespace and object key order as no change', () => {
    const reformatted = expectValid(
      validRaw({
        title: ' First positive value ',
        tests: [
          { id: 't1', arguments: ' [[4, -1]] ', expectedReturn: '4' },
          { id: 't2', arguments: '[[]]', expectedReturn: 'null' },
        ],
      }),
    );

    expect(compareConfigs(base, reformatted)).toEqual({
      metadata: false,
      rubric: false,
      tests: false,
    });
  });

  it('classifies metadata, rubric, tests, and combined changes', () => {
    expect(
      compareConfigs(base, { ...base, title: 'Renamed' }),
    ).toEqual({ metadata: true, rubric: false, tests: false });

    expect(
      compareConfigs(base, {
        ...base,
        criteria: [{ ...base.criteria[0]!, description: 'Changed' }],
      }),
    ).toEqual({ metadata: false, rubric: true, tests: false });

    expect(
      compareConfigs(base, {
        ...base,
        tests: [{ ...base.tests[0]!, expectedReturnJson: '5' }, base.tests[1]!],
      }),
    ).toEqual({ metadata: false, rubric: false, tests: true });

    expect(
      compareConfigs(base, {
        ...base,
        title: 'Renamed',
        criteria: [{ ...base.criteria[0]!, description: 'Changed' }],
        tests: [{ ...base.tests[0]!, expectedReturnJson: '5' }, base.tests[1]!],
      }),
    ).toEqual({ metadata: true, rubric: true, tests: true });
  });

  it('treats reordered items as a change', () => {
    expect(
      compareConfigs(base, { ...base, tests: [base.tests[1]!, base.tests[0]!] }),
    ).toEqual({ metadata: false, rubric: false, tests: true });
  });
});
