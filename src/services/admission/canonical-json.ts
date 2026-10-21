export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export class AuthorityJsonError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'AuthorityJsonError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

function reject(code: string): never {
  throw new AuthorityJsonError(code);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isPrintableAsciiKey(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function assertWellFormedNfcString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        reject('AUTHORITY_JSON_UNPAIRED_SURROGATE');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject('AUTHORITY_JSON_UNPAIRED_SURROGATE');
    }
  }

  if (value.normalize('NFC') !== value) {
    reject('AUTHORITY_JSON_NON_NFC');
  }
}

function assertSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    reject('AUTHORITY_JSON_INTEGER_REQUIRED');
  }
}

function compareAsciiBytes(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function escapeString(value: string): string {
  assertWellFormedNfcString(value);
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x22:
        escaped += '\\"';
        break;
      case 0x5c:
        escaped += '\\\\';
        break;
      case 0x08:
        escaped += '\\b';
        break;
      case 0x09:
        escaped += '\\t';
        break;
      case 0x0a:
        escaped += '\\n';
        break;
      case 0x0c:
        escaped += '\\f';
        break;
      case 0x0d:
        escaped += '\\r';
        break;
      default:
        if (code < 0x20) {
          escaped += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          escaped += String.fromCharCode(code);
        }
    }
  }
  return `"${escaped}"`;
}

function assertDataProperty(value: object, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
    reject('AUTHORITY_JSON_OBJECT_PROPERTY_FORBIDDEN');
  }
  return descriptor;
}

function isCanonicalArrayIndex(key: string): boolean {
  if (key === '0') return true;
  if (key.length === 0 || key[0] === '0') return false;
  for (let index = 0; index < key.length; index += 1) {
    if (!isAsciiDigit(key.charCodeAt(index))) return false;
  }
  const numeric = Number(key);
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < 0xffffffff && String(numeric) === key;
}

function serializeArray(value: CanonicalJsonValue[], seen: WeakSet<object>): string {
  const objectValue = value as unknown as object;
  const ownSymbols = Object.getOwnPropertySymbols(objectValue);
  if (ownSymbols.length > 0) reject('AUTHORITY_JSON_SYMBOL_PROPERTY_FORBIDDEN');

  const ownNames = Object.getOwnPropertyNames(objectValue);
  for (const key of ownNames) {
    if (key === 'length') continue;
    if (!isCanonicalArrayIndex(key)) reject('AUTHORITY_JSON_ARRAY_PROPERTY_FORBIDDEN');
    assertDataProperty(objectValue, key);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
      reject('AUTHORITY_JSON_ARRAY_HOLE_FORBIDDEN');
    }
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = assertDataProperty(objectValue, String(index));
    items.push(serializeValue(descriptor.value as CanonicalJsonValue, seen));
  }
  return `[${items.join(',')}]`;
}

function serializeObject(value: { [key: string]: CanonicalJsonValue }, seen: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject('AUTHORITY_JSON_OBJECT_PROTOTYPE_FORBIDDEN');
  }

  const objectValue = value as object;
  const ownSymbols = Object.getOwnPropertySymbols(objectValue);
  if (ownSymbols.length > 0) reject('AUTHORITY_JSON_SYMBOL_PROPERTY_FORBIDDEN');

  const keys = Object.getOwnPropertyNames(objectValue);
  for (const key of keys) {
    if (!isPrintableAsciiKey(key)) reject('AUTHORITY_JSON_OBJECT_KEY_FORBIDDEN');
    assertDataProperty(objectValue, key);
  }
  keys.sort(compareAsciiBytes);

  const members: string[] = [];
  for (const key of keys) {
    const descriptor = assertDataProperty(objectValue, key);
    members.push(`${escapeString(key)}:${serializeValue(descriptor.value as CanonicalJsonValue, seen)}`);
  }
  return `{${members.join(',')}}`;
}

function serializeValue(value: CanonicalJsonValue, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return escapeString(value);
  if (typeof value === 'number') {
    assertSafeInteger(value);
    return String(value);
  }
  if (typeof value !== 'object') reject('AUTHORITY_JSON_VALUE_FORBIDDEN');

  if (seen.has(value)) reject('AUTHORITY_JSON_CYCLE_FORBIDDEN');
  seen.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, seen)
      : serializeObject(value as { [key: string]: CanonicalJsonValue }, seen);
  } finally {
    seen.delete(value);
  }
}

export function canonicalDocument(value: CanonicalJsonValue): Uint8Array {
  return encoder.encode(`${serializeValue(value, new WeakSet<object>())}\n`);
}

export function canonicalLine(value: CanonicalJsonValue): Uint8Array {
  const bytes = canonicalDocument(value);
  if (bytes.includes(0x0d)) reject('AUTHORITY_JSON_CR_FORBIDDEN');
  return bytes;
}

class AuthorityParser {
  private readonly source: string;
  private position = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(): CanonicalJsonValue {
    if (this.source.length === 0) reject('AUTHORITY_JSON_EMPTY');
    if (this.source.charCodeAt(0) === 0xfeff) reject('AUTHORITY_JSON_BOM_FORBIDDEN');
    if (this.source.includes('\r')) reject('AUTHORITY_JSON_CR_FORBIDDEN');

    const value = this.parseValue();
    if (this.position < this.source.length && this.source[this.position] === '\n') {
      this.position += 1;
    }
    if (this.position !== this.source.length) {
      if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
      reject('AUTHORITY_JSON_TRAILING_INPUT');
    }
    return value;
  }

  private parseValue(): CanonicalJsonValue {
    const character = this.source[this.position];
    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    if (character === '-' || isAsciiDigit(this.source.charCodeAt(this.position))) return this.parseNumber();
    if (this.isWhitespace(character)) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
    reject('AUTHORITY_JSON_VALUE_REQUIRED');
  }

  private parseObject(): CanonicalJsonValue {
    this.position += 1;
    const objectValue: { [key: string]: CanonicalJsonValue } = Object.create(null) as { [key: string]: CanonicalJsonValue };
    const seenKeys = new Set<string>();
    if (this.source[this.position] === '}') {
      this.position += 1;
      return objectValue;
    }

    while (true) {
      if (this.source[this.position] !== '"') {
        if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
        reject('AUTHORITY_JSON_OBJECT_KEY_REQUIRED');
      }
      const key = this.parseString();
      if (!isPrintableAsciiKey(key)) reject('AUTHORITY_JSON_OBJECT_KEY_FORBIDDEN');
      if (seenKeys.has(key)) reject('AUTHORITY_JSON_DUPLICATE_KEY');
      seenKeys.add(key);
      this.expect(':');
      objectValue[key] = this.parseValue();
      if (this.source[this.position] === '}') {
        this.position += 1;
        return objectValue;
      }
      this.expect(',');
      if (this.source[this.position] !== '"') {
        if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
        reject('AUTHORITY_JSON_OBJECT_KEY_REQUIRED');
      }
    }
  }

  private parseArray(): CanonicalJsonValue[] {
    this.position += 1;
    const arrayValue: CanonicalJsonValue[] = [];
    if (this.source[this.position] === ']') {
      this.position += 1;
      return arrayValue;
    }

    while (true) {
      if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
      arrayValue.push(this.parseValue());
      if (this.source[this.position] === ']') {
        this.position += 1;
        return arrayValue;
      }
      this.expect(',');
      if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
    }
  }

  private parseLiteral<T extends CanonicalJsonValue>(literal: string, value: T): T {
    if (this.source.slice(this.position, this.position + literal.length) !== literal) {
      reject('AUTHORITY_JSON_LITERAL_INVALID');
    }
    this.position += literal.length;
    return value;
  }

  private parseNumber(): number {
    const start = this.position;
    if (this.source[this.position] === '-') this.position += 1;
    const firstDigit = this.source.charCodeAt(this.position);
    if (firstDigit === 0x30) {
      this.position += 1;
      if (isAsciiDigit(this.source.charCodeAt(this.position))) reject('AUTHORITY_JSON_INTEGER_GRAMMAR');
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      while (isAsciiDigit(this.source.charCodeAt(this.position))) this.position += 1;
    } else {
      reject('AUTHORITY_JSON_INTEGER_GRAMMAR');
    }

    const next = this.source[this.position];
    if (next === '.' || next === 'e' || next === 'E') reject('AUTHORITY_JSON_INTEGER_GRAMMAR');
    const token = this.source.slice(start, this.position);
    const value = Number(token);
    assertSafeInteger(value);
    return value;
  }

  private parseString(): string {
    this.expect('"');
    let value = '';
    while (this.position < this.source.length) {
      const code = this.source.charCodeAt(this.position);
      this.position += 1;
      if (code === 0x22) {
        assertWellFormedNfcString(value);
        return value;
      }
      if (code === 0x5c) {
        value += this.parseEscape();
        continue;
      }
      if (code < 0x20) reject('AUTHORITY_JSON_STRING_CONTROL_FORBIDDEN');
      value += String.fromCharCode(code);
    }
    reject('AUTHORITY_JSON_STRING_UNTERMINATED');
  }

  private parseEscape(): string {
    const escape = this.source[this.position];
    this.position += 1;
    switch (escape) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': return this.parseUnicodeEscape();
      default: reject('AUTHORITY_JSON_ESCAPE_INVALID');
    }
  }

  private parseUnicodeEscape(): string {
    const codeUnit = this.parseHexQuad();
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (this.source[this.position] !== '\\' || this.source[this.position + 1] !== 'u') {
        reject('AUTHORITY_JSON_UNPAIRED_SURROGATE');
      }
      this.position += 2;
      const low = this.parseHexQuad();
      if (low < 0xdc00 || low > 0xdfff) reject('AUTHORITY_JSON_UNPAIRED_SURROGATE');
      return String.fromCharCode(codeUnit, low);
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) reject('AUTHORITY_JSON_UNPAIRED_SURROGATE');
    return String.fromCharCode(codeUnit);
  }

  private parseHexQuad(): number {
    if (this.position + 4 > this.source.length) reject('AUTHORITY_JSON_ESCAPE_INVALID');
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      const code = this.source.charCodeAt(this.position + index);
      const digit = code >= 0x30 && code <= 0x39
        ? code - 0x30
        : code >= 0x41 && code <= 0x46
          ? code - 0x41 + 10
          : code >= 0x61 && code <= 0x66
            ? code - 0x61 + 10
            : -1;
      if (digit < 0) reject('AUTHORITY_JSON_ESCAPE_INVALID');
      value = value * 16 + digit;
    }
    this.position += 4;
    return value;
  }

  private expect(character: string): void {
    if (this.source[this.position] !== character) {
      if (this.isWhitespace(this.source[this.position])) reject('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
      reject('AUTHORITY_JSON_SYNTAX');
    }
    this.position += 1;
  }

  private isWhitespace(character: string | undefined): boolean {
    return character === ' ' || character === '\t' || character === '\n' || character === '\r';
  }
}

export function parseAuthorityJson(bytes: Uint8Array): CanonicalJsonValue {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reject('AUTHORITY_JSON_UTF8_INVALID');
  }
  return new AuthorityParser(source).parse();
}
