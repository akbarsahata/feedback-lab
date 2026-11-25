import { JsonNumber, MAX_JSON_DEPTH, type JsonValue } from './json';

export type ActualValue =
  | { kind: 'none' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'str'; value: string }
  | { kind: 'list'; items: ActualValue[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: ActualValue }> };

export class FunctionValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionValueError';
  }
}

export type FunctionValueComparison = { matches: boolean };

/**
 * Compares a saved JSON expectation with the tagged value returned by the
 * trusted runner. Tagged values preserve Python's numeric kinds, so an integer
 * never passes through JavaScript's Number.
 */
export function compareFunctionValue(
  expected: JsonValue,
  actual: ActualValue,
): FunctionValueComparison {
  return compare(expected, validateActual(actual, 0));
}

function compare(expected: JsonValue, actual: ActualValue): FunctionValueComparison {
  switch (actual.kind) {
    case 'none':
      return { matches: expected === null };
    case 'bool':
      return { matches: expected === actual.value };
    case 'int':
    case 'float': {
      const expectedNumber = expectedNumberText(expected);
      if (expectedNumber === null) return { matches: false };
      return { matches: numericValuesEqual(expectedNumber, actual.value, actual.kind) };
    }
    case 'str':
      return { matches: typeof expected === 'string' && expected === actual.value };
    case 'list': {
      if (!Array.isArray(expected) || expected.length !== actual.items.length) {
        return { matches: false };
      }
      return {
        matches: actual.items.every((item, index) => compare(expected[index]!, item).matches),
      };
    }
    case 'dict': {
      if (
        expected === null ||
        Array.isArray(expected) ||
        typeof expected !== 'object' ||
        expected instanceof JsonNumber
      ) {
        return { matches: false };
      }
      const expectedKeys = Object.keys(expected);
      if (expectedKeys.length !== actual.entries.length) return { matches: false };
      const actualByKey = new Map(actual.entries.map((entry) => [entry.key, entry.value]));
      if (actualByKey.size !== actual.entries.length) return { matches: false };
      for (const key of expectedKeys) {
        const item = actualByKey.get(key);
        if (item === undefined || !compare(expected[key]!, item).matches) {
          return { matches: false };
        }
      }
      return { matches: true };
    }
  }
}

function expectedNumberText(value: JsonValue): string | null {
  // JsonNumber is the parser's exact decimal token. Its kind is the only number
  // representation the configuration stores.
  return value instanceof JsonNumber ? value.text : null;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Python compares an integer and a float exactly. For floats, the runner's
 * repr is the shortest round-trip decimal, not the exact binary64 value, so
 * rematerialize the double before comparing. The saved expected token is an
 * exact decimal integer unless it contains a decimal point or exponent.
 */
function numericValuesEqual(
  expectedText: string,
  actualText: string,
  actualKind: 'int' | 'float',
): boolean {
  if (!DECIMAL_PATTERN.test(expectedText) || !DECIMAL_PATTERN.test(actualText)) {
    throw new FunctionValueError('The runner returned a malformed number.');
  }
  const actualNumber = Number(actualText);
  if (!Number.isFinite(actualNumber)) {
    throw new FunctionValueError('The runner returned a non-finite number.');
  }
  const expectedLooksFloat = /[.eE]/.test(expectedText);
  const expectedNumber = Number(expectedText);
  if (!Number.isFinite(expectedNumber)) {
    throw new FunctionValueError('The expected number is outside the supported range.');
  }

  if (actualKind === 'float') {
    if (expectedLooksFloat) return expectedNumber === actualNumber;
    if (!Number.isInteger(actualNumber)) return false;
    return BigInt(actualNumber) === BigInt(expectedText);
  }

  const actualInteger = BigInt(actualText);
  if (!expectedLooksFloat) return actualInteger === BigInt(expectedText);
  return Number.isInteger(expectedNumber) && actualInteger === BigInt(expectedNumber);
}

function validateActual(value: unknown, depth: number): ActualValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FunctionValueError('The runner returned a malformed actual value.');
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'none':
      return { kind: 'none' };
    case 'bool':
      if (typeof record.value !== 'boolean') {
        throw new FunctionValueError('The runner returned a malformed boolean.');
      }
      return { kind: 'bool', value: record.value };
    case 'int':
    case 'float':
      if (typeof record.value !== 'string' || !DECIMAL_PATTERN.test(record.value)) {
        throw new FunctionValueError('The runner returned a malformed number.');
      }
      return { kind: record.kind, value: record.value };
    case 'str':
      if (typeof record.value !== 'string') {
        throw new FunctionValueError('The runner returned a malformed string.');
      }
      return { kind: 'str', value: record.value };
    case 'list': {
      if (depth >= MAX_JSON_DEPTH || !Array.isArray(record.items)) {
        throw new FunctionValueError(
          `The runner returned a value beyond the ${MAX_JSON_DEPTH}-level depth limit.`,
        );
      }
      return {
        kind: 'list',
        items: record.items.map((item) => validateActual(item, depth + 1)),
      };
    }
    case 'dict': {
      if (depth >= MAX_JSON_DEPTH || !Array.isArray(record.entries)) {
        throw new FunctionValueError(
          `The runner returned a value beyond the ${MAX_JSON_DEPTH}-level depth limit.`,
        );
      }
      const seen = new Set<string>();
      const entries = record.entries.map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new FunctionValueError('The runner returned a malformed dictionary entry.');
        }
        const row = entry as Record<string, unknown>;
        if (typeof row.key !== 'string' || seen.has(row.key)) {
          throw new FunctionValueError('The runner returned a dictionary with invalid keys.');
        }
        seen.add(row.key);
        return { key: row.key, value: validateActual(row.value, depth + 1) };
      });
      return { kind: 'dict', entries };
    }
    default:
      throw new FunctionValueError(`The runner returned an unsupported value (${String(record.kind)}).`);
  }
}
