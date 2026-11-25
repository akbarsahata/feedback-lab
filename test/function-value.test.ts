import { describe, expect, it } from 'vitest';
import { compareFunctionValue, FunctionValueError, type ActualValue } from '../src/function-value';
import { parseJsonValue } from '../src/json';

function actual(value: string): ActualValue {
  return JSON.parse(value) as ActualValue;
}

describe('function-value-v1', () => {
  it('compares integers and finite floats by exact numerical equality', () => {
    expect(compareFunctionValue(parseJsonValue('7'), actual('{"kind":"int","value":"7"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('7.0'), actual('{"kind":"float","value":"7.0"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('7'), actual('{"kind":"float","value":"7.0"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('7.0'), actual('{"kind":"int","value":"7"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('7'), actual('{"kind":"float","value":"7.5"}'))).toEqual({
      matches: false,
    });
  });

  it('compares large integers against the exact binary64 value', () => {
    expect(
      compareFunctionValue(
        parseJsonValue('1152921504606846976'),
        actual('{"kind":"float","value":"1.152921504606847e+18"}'),
      ),
    ).toEqual({ matches: true });
    expect(
      compareFunctionValue(
        parseJsonValue('1e23'),
        actual('{"kind":"int","value":"100000000000000000000000"}'),
      ),
    ).toEqual({ matches: false });
  });

  it('does not treat booleans and numbers as equal', () => {
    expect(compareFunctionValue(parseJsonValue('true'), actual('{"kind":"bool","value":true}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('1'), actual('{"kind":"bool","value":true}'))).toEqual({
      matches: false,
    });
    expect(compareFunctionValue(parseJsonValue('true'), actual('{"kind":"int","value":"1"}'))).toEqual({
      matches: false,
    });
    expect(compareFunctionValue(parseJsonValue('false'), actual('{"kind":"int","value":"0"}'))).toEqual({
      matches: false,
    });
  });

  it('matches strings and None only exactly', () => {
    expect(compareFunctionValue(parseJsonValue('"Ada"'), actual('{"kind":"str","value":"Ada"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('"Ada"'), actual('{"kind":"str","value":"ada"}'))).toEqual({
      matches: false,
    });
    expect(compareFunctionValue(parseJsonValue('null'), actual('{"kind":"none"}'))).toEqual({
      matches: true,
    });
    expect(compareFunctionValue(parseJsonValue('null'), actual('{"kind":"str","value":""}'))).toEqual({
      matches: false,
    });
  });

  it('applies the rules recursively to lists in order', () => {
    expect(
      compareFunctionValue(
        parseJsonValue('[1, true, null, [2.0]]'),
        actual(
          '{"kind":"list","items":[{"kind":"float","value":"1.0"},{"kind":"bool","value":true},{"kind":"none"},{"kind":"list","items":[{"kind":"int","value":"2"}]}]}',
        ),
      ),
    ).toEqual({ matches: true });
    expect(
      compareFunctionValue(
        parseJsonValue('[1, 2]'),
        actual(
          '{"kind":"list","items":[{"kind":"int","value":"2"},{"kind":"int","value":"1"}]}',
        ),
      ),
    ).toEqual({ matches: false });
  });

  it('compares dictionaries by key without depending on entry order', () => {
    expect(
      compareFunctionValue(
        parseJsonValue('{"a": 1, "b": [true]}'),
        actual(
          '{"kind":"dict","entries":[{"key":"b","value":{"kind":"list","items":[{"kind":"bool","value":true}]}},{"key":"a","value":{"kind":"float","value":"1.0"}}]}',
        ),
      ),
    ).toEqual({ matches: true });
    expect(
      compareFunctionValue(
        parseJsonValue('{"a": 1}'),
        actual('{"kind":"dict","entries":[{"key":"a","value":{"kind":"int","value":"1"}},{"key":"b","value":{"kind":"int","value":"2"}}]}'),
      ),
    ).toEqual({ matches: false });
  });

  it('distinguishes a returned None from an unavailable value', () => {
    expect(() => compareFunctionValue(parseJsonValue('null'), actual('{"kind":"absent"}'))).toThrow(
      FunctionValueError,
    );
  });

  it('matches supported values nested through the full depth limit', () => {
    let expectedJson = 'null';
    let actualJson = '{"kind":"none"}';
    for (let index = 0; index < 64; index += 1) {
      expectedJson = `[${expectedJson}]`;
      actualJson = `{"kind":"list","items":[${actualJson}]}`;
    }
    expect(compareFunctionValue(parseJsonValue(expectedJson), actual(actualJson))).toEqual({
      matches: true,
    });
  });

  it('rejects unsupported returns and excessive nesting', () => {
    expect(() =>
      compareFunctionValue(parseJsonValue('null'), actual('{"kind":"set","items":[]}')),
    ).toThrow(/unsupported/i);

    let nested = '{"kind":"none"}';
    for (let index = 0; index < 65; index += 1) {
      nested = `{"kind":"list","items":[${nested}]}`;
    }
    expect(() => compareFunctionValue(parseJsonValue('null'), actual(nested))).toThrow(/depth/i);
  });
});
