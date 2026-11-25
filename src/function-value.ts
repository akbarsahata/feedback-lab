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
      return { matches: decimalValuesEqual(expectedNumber, actual.value, actual.kind) };
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

interface Decimal {
  negative: boolean;
  digits: bigint;
  exponent: number;
}

function decimalValuesEqual(left: string, right: string, kind: 'int' | 'float'): boolean {
  if (!DECIMAL_PATTERN.test(left) || !DECIMAL_PATTERN.test(right)) {
    throw new FunctionValueError('The runner returned a non-finite or malformed number.');
  }
  if (kind === 'float' && !/[.eE]/.test(right) && !Number.isFinite(Number(right))) {
    throw new FunctionValueError('The runner returned a non-finite number.');
  }
  return compareDecimals(parseDecimal(left), parseDecimal(right));
}

function parseDecimal(text: string): Decimal {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (match === null) throw new FunctionValueError('The runner returned a malformed number.');
  const fraction = match[3] ?? '';
  let digits = BigInt(`${match[2]}${fraction}`);
  let exponent = Number.parseInt(match[4] ?? '0', 10) - fraction.length;
  if (!Number.isSafeInteger(exponent)) {
    throw new FunctionValueError('The runner returned a number outside the supported range.');
  }
  while (digits !== 0n && digits % 10n === 0n) {
    digits /= 10n;
    exponent += 1;
  }
  return { negative: match[1] === '-' && digits !== 0n, digits, exponent };
}

function compareDecimals(left: Decimal, right: Decimal): boolean {
  if (left.digits === 0n || right.digits === 0n) return left.digits === right.digits;
  if (left.negative !== right.negative) return false;
  const leftMagnitude = left.exponent + decimalLength(left.digits);
  const rightMagnitude = right.exponent + decimalLength(right.digits);
  if (leftMagnitude !== rightMagnitude) return false;
  const alignment = right.exponent - left.exponent;
  const leftAligned = alignment >= 0 ? left.digits * 10n ** BigInt(alignment) : left.digits;
  const rightAligned = alignment < 0 ? right.digits * 10n ** BigInt(-alignment) : right.digits;
  return leftAligned === rightAligned;
}

function decimalLength(value: bigint): number {
  return value.toString().length;
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
