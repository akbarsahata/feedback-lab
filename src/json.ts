export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(sorted, key, {
        value: sortObjectKeys(value[key] as JsonValue),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sorted;
  }
  return value;
}

class Parser {
  readonly source: string;
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

  parseValue(): JsonValue {
    this.skipWhitespace();
    if (this.atEnd()) {
      throw new JsonParseError('expected a value', this.position);
    }

    const char = this.source[this.position];
    if (char === '{') {
      return this.parseObject();
    }
    if (char === '[') {
      return this.parseArray();
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

  parseObject(): { [key: string]: JsonValue } {
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
      const value = this.parseValue();
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

  parseArray(): JsonValue[] {
    this.position += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.position] === ']') {
      this.position += 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue());
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
      const char = this.source[this.position];
      this.position += 1;

      if (char === '"') {
        return result;
      }
      if (char === '\\') {
        result += this.parseEscape();
        continue;
      }
      if (char !== undefined && char.charCodeAt(0) < 0x20) {
        throw new JsonParseError('control characters must be escaped', this.position - 1);
      }
      result += char;
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

  parseNumber(): number {
    const start = this.position;
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.position),
    );
    if (match === null) {
      throw new JsonParseError('malformed number', start);
    }

    const raw = match[0];
    this.position += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new JsonParseError('number must be finite', start);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new JsonParseError(
        `integer ${raw} cannot be stored exactly; use an integer between ` +
          `${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}`,
        start,
      );
    }
    return value;
  }
}
