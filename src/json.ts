export type JsonValue =
  | null
  | boolean
  | JsonNumber
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// A canonical number token, not a JS number: its syntax retains its kind.
class JsonNumber {
  constructor(readonly text: string) {}
}

export const MAX_JSON_DEPTH = 64;

export class JsonParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`Invalid JSON: ${message} at character ${position + 1}`);
    this.name = 'JsonParseError';
    this.position = position;
  }
}

/**
 * Parses JSON without losing information that `JSON.parse` silently discards:
 * duplicate object keys, non-finite numbers, and integers outside the range
 * JavaScript can store exactly.
 */
export function parseJsonValue(source: string): JsonValue {
  const parser = new Parser(source);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw new JsonParseError('unexpected trailing content', parser.position);
  }
  return value;
}

export function canonicalizeJson(value: JsonValue): string {
  return serializeJson(value, '');
}

/**
 * Readable rendering for forms and detail tables. The stored form remains
 * canonical; this only adds spaces after separators.
 */
export function formatJsonForDisplay(value: JsonValue): string {
  return serializeJson(value, ' ');
}

function serializeJson(value: JsonValue, space: string): string {
  if (value instanceof JsonNumber) {
    return value.text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJson(item, space)).join(`,${space}`)}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${space}${serializeJson(value[key]!, space)}`,
      );
    return `{${entries.join(`,${space}`)}}`;
  }
  return JSON.stringify(value);
}

class Parser {
  readonly source: string;
  readonly numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  readonly unescapedString = /[^"\\\x00-\x1f]+/y;
  position = 0;

  constructor(source: string) {
    this.source = source;
  }

  atEnd(): boolean {
    return this.position >= this.source.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const char = this.source[this.position];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
        return;
      }
      this.position += 1;
    }
  }

  parseValue(depth = 0): JsonValue {
    this.skipWhitespace();
    if (this.atEnd()) {
      throw new JsonParseError('expected a value', this.position);
    }

    const char = this.source[this.position];
    if ((char === '{' || char === '[') && depth >= MAX_JSON_DEPTH) {
      throw new JsonParseError(`use at most ${MAX_JSON_DEPTH} nested arrays or objects`, this.position);
    }
    if (char === '{') {
      return this.parseObject(depth + 1);
    }
    if (char === '[') {
      return this.parseArray(depth + 1);
    }
    if (char === '"') {
      return this.parseString();
    }
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) {
      return this.parseNumber();
    }
    if (this.source.startsWith('true', this.position)) {
      this.position += 4;
      return true;
    }
    if (this.source.startsWith('false', this.position)) {
      this.position += 5;
      return false;
    }
    if (this.source.startsWith('null', this.position)) {
      this.position += 4;
      return null;
    }
    throw new JsonParseError('expected a value', this.position);
  }

  parseObject(depth: number): { [key: string]: JsonValue } {
    this.position += 1;
    const result: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.position] === '}') {
      this.position += 1;
      return result;
    }

    while (true) {
      this.skipWhitespace();
      if (this.source[this.position] !== '"') {
        throw new JsonParseError('expected a quoted object key', this.position);
      }
      const keyPosition = this.position;
      const key = this.parseString();
      if (keys.has(key)) {
        throw new JsonParseError(`duplicate object key "${key}"`, keyPosition);
      }
      keys.add(key);

      this.skipWhitespace();
      if (this.source[this.position] !== ':') {
        throw new JsonParseError('expected ":" after an object key', this.position);
      }
      this.position += 1;
      const value = this.parseValue(depth);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });

      this.skipWhitespace();
      const next = this.source[this.position];
      if (next === '}') {
        this.position += 1;
        return result;
      }
      if (next !== ',') {
        throw new JsonParseError('expected "," or "}" in an object', this.position);
      }
      this.position += 1;
    }
  }

  parseArray(depth: number): JsonValue[] {
    this.position += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.position] === ']') {
      this.position += 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const next = this.source[this.position];
      if (next === ']') {
        this.position += 1;
        return result;
      }
      if (next !== ',') {
        throw new JsonParseError('expected "," or "]" in an array', this.position);
      }
      this.position += 1;
    }
  }

  parseString(): string {
    const start = this.position;
    this.position += 1;
    let result = '';

    while (!this.atEnd()) {
      this.unescapedString.lastIndex = this.position;
      const plain = this.unescapedString.exec(this.source);
      if (plain !== null) {
        result += plain[0];
        this.position = this.unescapedString.lastIndex;
        continue;
      }
      const char = this.source[this.position];
      this.position += 1;

      if (char === '"') {
        return result;
      }
      if (char === '\\') {
        result += this.parseEscape();
        continue;
      }
      throw new JsonParseError('control characters must be escaped', this.position - 1);
    }

    throw new JsonParseError('unterminated string', start);
  }

  parseEscape(): string {
    if (this.atEnd()) {
      throw new JsonParseError('unterminated escape sequence', this.position);
    }
    const escape = this.source[this.position];
    this.position += 1;
    switch (escape) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JsonParseError('expected four hexadecimal digits', this.position);
        }
        this.position += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new JsonParseError('unsupported escape sequence', this.position - 1);
    }
  }

  parseNumber(): JsonNumber {
    const start = this.position;
    this.numberPattern.lastIndex = start;
    const match = this.numberPattern.exec(this.source);
    if (match === null) {
      throw new JsonParseError('malformed number', start);
    }

    const raw = match[0];
    this.position += raw.length;
    const isFloat = /[.eE]/.test(raw);
    const value = Number(raw);
    if (!isFloat) {
      // Compare exact decimal values, not Number#toString's rounded spelling.
      if (!Number.isFinite(value) || (!Number.isSafeInteger(value) && BigInt(value) !== BigInt(raw))) {
        throw new JsonParseError('integer cannot be stored exactly; use an exactly representable integer', start);
      }
      return new JsonNumber(value === 0 ? '0' : raw);
    }
    if (!Number.isFinite(value)) {
      throw new JsonParseError('number must be finite', start);
    }
    if (Object.is(value, -0)) return new JsonNumber('-0.0');
    const text = String(value);
    return new JsonNumber(/[.e]/.test(text) ? text : `${text}.0`);
  }
}
