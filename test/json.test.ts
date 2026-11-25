import { describe, expect, it } from 'vitest';
import { canonicalizeJson, formatJsonForDisplay, parseJsonValue } from '../src/json';

function canonical(source: string): string {
  return canonicalizeJson(parseJsonValue(source));
}

describe('parseJsonValue', () => {
  it('parses the examples from the ticket', () => {
    expect(parseJsonValue('[]')).toEqual([]);
    expect(canonical('[4, -1]')).toBe('[4,-1]');
    expect(canonical('[[4, -1]]')).toBe('[[4,-1]]');
    expect(parseJsonValue('[[]]')).toEqual([[]]);
    expect(parseJsonValue('null')).toBeNull();
  });

  it('parses nested supported values', () => {
    const value = canonical(
      '{"name": "Ada", "scores": [1, 2.5, true, false, null, [], {}], "meta": {"ok": true}}',
    );

    expect(value).toBe('{"meta":{"ok":true},"name":"Ada","scores":[1,2.5,true,false,null,[],{}]}');
  });

  it('parses strings with JSON escapes', () => {
    expect(parseJsonValue('"a\\nb\\u2764"')).toBe('a\nb\u2764');
  });

  it('rejects blank input', () => {
    expect(() => parseJsonValue('   ')).toThrow(/JSON/);
  });

  it('rejects duplicate object keys', () => {
    expect(() => parseJsonValue('{"a": 1, "a": 2}')).toThrow(/duplicate.*"a"/i);
    expect(() => parseJsonValue('{"outer": {"b": 1, "b": 1}}')).toThrow(/duplicate.*"b"/i);
  });

  it('rejects integers that cannot be stored exactly', () => {
    expect(() => parseJsonValue('9007199254740993')).toThrow(/integer/i);
    expect(() => parseJsonValue('[-9007199254740993]')).toThrow(/integer/i);
  });

  it('accepts the largest safe integers', () => {
    expect(canonical('9007199254740991')).toBe('9007199254740991');
    expect(canonical('-9007199254740991')).toBe('-9007199254740991');
  });

  it('rejects non-finite numbers', () => {
    expect(() => parseJsonValue('1e999')).toThrow(/finite/i);
  });

  it('rejects trailing garbage', () => {
    expect(() => parseJsonValue('[1] x')).toThrow(/JSON/);
    expect(() => parseJsonValue('1 2')).toThrow(/JSON/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseJsonValue('[1,]')).toThrow(/JSON/);
    expect(() => parseJsonValue("{'a': 1}")).toThrow(/JSON/);
    expect(() => parseJsonValue('{"a": }')).toThrow(/JSON/);
    expect(() => parseJsonValue('nul')).toThrow(/JSON/);
  });
});

describe('formatJsonForDisplay', () => {
  it('adds readable spacing without changing values', () => {
    expect(formatJsonForDisplay(parseJsonValue('[[4,-1]]'))).toBe('[[4, -1]]');
    expect(formatJsonForDisplay(parseJsonValue('[[]]'))).toBe('[[]]');
    expect(formatJsonForDisplay(parseJsonValue('[]'))).toBe('[]');
    expect(formatJsonForDisplay(parseJsonValue('null'))).toBe('null');
    expect(formatJsonForDisplay(parseJsonValue('{"b":1,"a":{"d":2,"c":3}}'))).toBe(
      '{"a": {"c": 3, "d": 2}, "b": 1}',
    );
  });
});

describe('canonicalizeJson', () => {
  it('sorts object keys without changing array order', () => {
    expect(
      canonical('{"b":1,"a":{"d":[3,1,2],"c":2}}'),
    ).toBe('{"a":{"c":2,"d":[3,1,2]},"b":1}');
  });

  it('ignores object key order and whitespace in equality terms', () => {
    expect(canonicalizeJson(parseJsonValue('{"b": 1, "a": 2}'))).toBe(
      canonicalizeJson(parseJsonValue('{"a":2,"b":1}')),
    );
  });
});
