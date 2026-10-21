import { describe, expect, it } from 'vitest';
import {
  canonicalLine,
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from '../../src/services/admission/canonical-json';
import {
  canonicalAuthorityContentIdentity,
  contentIdentity,
  payloadSha256,
  recordSha256,
  sha256Hex,
} from '../../src/services/admission/identity';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('canonical authority JSON', () => {
  it('sorts ASCII keys and emits exactly one terminal LF', () => {
    expect(new TextDecoder().decode(canonicalDocument({ z: 1, a: true })))
      .toBe('{"a":true,"z":1}\n');
  });

  it.each([
    '{"a":1,"a":2}',
    '{"float":1.5}',
    '{"exponent":1e0}',
    '{"exponent":1E0}',
    '{"leading":01}',
    '{"negative_leading":-01}',
    '{"negative_zero":-0}',
    '{"bad_key_é":1}',
    '{"decomposed":"e\\u0301"}',
    '{"surrogate":"\\ud800"}',
    '\ufeff{"a":1}',
  ])('rejects non-authority input %s', (source) => {
    expect(() => parseAuthorityJson(bytes(source))).toThrow();
  });

  it('emits the same single-LF framing for canonical lines', () => {
    expect(new TextDecoder().decode(canonicalLine({ a: 1 }))).toBe('{"a":1}\n');
  });

  it('uses independent domain-separated payload and record frames', async () => {
    await expect(payloadSha256({ b: 2, a: 1 }))
      .resolves.toBe('de605772177ccd9de7915abe624982844ff03cd5f4f4d79737aaf1e840a39e64');
    await expect(recordSha256({ a: 1 }))
      .resolves.toBe('e1bbac1cd0c7f80ab59d8197c862d91c7b5ca6bb2bf9b221595ef8c3f649c3b3');
    await expect(recordSha256({ a: 1 })).resolves.not.toBe(await payloadSha256({ a: 1 }));
  });

  it('hashes exact arbitrary bytes and binds byte length', async () => {
    const source = bytes('abc');
    const identityPromise = contentIdentity(source);
    source[0] = 0;
    await expect(identityPromise).resolves.toEqual({
      byte_length: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    await expect(sha256Hex(bytes('abc')))
      .resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts only byte-exact canonical authority documents', async () => {
    const canonical = bytes('{"a":1}\n');
    await expect(canonicalAuthorityContentIdentity(canonical)).resolves.toEqual({
      byte_length: 8,
      sha256: 'e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c',
    });
    await expect(canonicalAuthorityContentIdentity(bytes('{"a":1}'))).rejects.toThrow();
    await expect(canonicalAuthorityContentIdentity(bytes('{ "a":1}\n'))).rejects.toThrow();
  });

  it('uses shortest JSON escapes while preserving array order and NFC bytes', () => {
    const value: CanonicalJsonValue = {
      z: '\b\t\n\f\r\u0000',
      a: 'é',
      m: ['quote"', 'slash\\', 0, -2, null, false],
    };
    expect(new TextDecoder().decode(canonicalDocument(value))).toBe(
      '{"a":"é","m":["quote\\\"","slash\\\\",0,-2,null,false],"z":"\\b\\t\\n\\f\\r\\u0000"}\n',
    );
  });

  it('parses valid authority values through the recursive parser', () => {
    const parsed = parseAuthorityJson(bytes('{"n":-9007199254740991,"unicode":"é","nested":[true,null]}')) as {
      n: number;
      unicode: string;
      nested: CanonicalJsonValue[];
    };
    expect(parsed).toEqual({ n: -9007199254740991, unicode: 'é', nested: [true, null] });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it.each([
    ' {"a":1}',
    '{"a": 1}',
    '{\n"a":1}',
    '{"a":1}\n\n',
    '{"a":1}\r\n',
    '{"a":1} ',
    '{"a":1}x',
    '[1, ]',
    '{"a":}',
  ])('rejects authority-insignificant whitespace or malformed framing %s', (source) => {
    expect(() => parseAuthorityJson(bytes(source))).toThrow();
  });

  it('rejects malformed UTF-8 before parsing text', () => {
    expect(() => parseAuthorityJson(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]))).toThrow();
  });

  it('keeps __proto__ data inert while retaining its authority key', () => {
    const parsed = parseAuthorityJson(bytes('{"__proto__":1}')) as Record<string, CanonicalJsonValue>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed['__proto__']).toBe(1);
    expect(new TextDecoder().decode(canonicalDocument(parsed))).toBe('{"__proto__":1}\n');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects invalid programmatic authority values before serialization', () => {
    const cyclic: Record<string, CanonicalJsonValue> = {};
    cyclic.self = cyclic;
    const sparse: CanonicalJsonValue[] = [];
    sparse.length = 1;
    const withSymbol = {} as Record<string, CanonicalJsonValue>;
    Object.defineProperty(withSymbol, Symbol('hidden'), { value: 1, enumerable: true });
    const withGetter = {} as Record<string, CanonicalJsonValue>;
    Object.defineProperty(withGetter, 'a', { get: () => 1, enumerable: true });

    expect(() => canonicalDocument(1.5 as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument(Number.NaN as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument(Number.POSITIVE_INFINITY as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument(9007199254740992 as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument(-0 as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument('\u0065\u0301' as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument('\ud800' as unknown as CanonicalJsonValue)).toThrow();
    expect(() => canonicalDocument(cyclic)).toThrow();
    expect(() => canonicalDocument(sparse)).toThrow();
    expect(() => canonicalDocument(withSymbol)).toThrow();
    expect(() => canonicalDocument(withGetter)).toThrow();
    expect(() => canonicalDocument(new Date() as unknown as CanonicalJsonValue)).toThrow();
  });

  it('rejects noncanonical escaped aliases even when their parsed value is equal', async () => {
    await expect(canonicalAuthorityContentIdentity(bytes('{"\\u0061":1}\n'))).rejects.toThrow();
    await expect(canonicalAuthorityContentIdentity(bytes('{"a":"\\u00e9"}\n'))).rejects.toThrow();
    await expect(canonicalAuthorityContentIdentity(bytes('{"a":"e\\u0301"}\n'))).rejects.toThrow();
  });
});
