import {
  AuthorityJsonError,
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from './canonical-json';

export interface ContentIdentity {
  byte_length: number;
  sha256: string;
}

const encoder = new TextEncoder();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (!subtle) throw new AuthorityJsonError('AUTHORITY_JSON_CRYPTO_UNAVAILABLE');
  const digest = new Uint8Array(await subtle.digest('SHA-256', copy));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function contentIdentity(bytes: Uint8Array): Promise<ContentIdentity> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { byte_length: copy.byteLength, sha256: await sha256Hex(copy) };
}

export async function canonicalAuthorityContentIdentity(
  bytes: Uint8Array,
): Promise<ContentIdentity> {
  const parsed = parseAuthorityJson(bytes);
  const canonical = canonicalDocument(parsed);
  if (!equalBytes(canonical, bytes)) {
    throw new AuthorityJsonError('AUTHORITY_JSON_NOT_CANONICAL');
  }
  return contentIdentity(bytes);
}

async function domainSeparatedSha256(
  prefix: string,
  value: CanonicalJsonValue,
): Promise<string> {
  const canonical = canonicalDocument(value);
  const withoutTerminalLf = canonical.subarray(0, canonical.byteLength - 1);
  const prefixBytes = encoder.encode(prefix);
  const framed = new Uint8Array(prefixBytes.byteLength + withoutTerminalLf.byteLength);
  framed.set(prefixBytes);
  framed.set(withoutTerminalLf, prefixBytes.byteLength);
  return sha256Hex(framed);
}

export function payloadSha256(payload: CanonicalJsonValue): Promise<string> {
  return domainSeparatedSha256('SOCRATIC_ADMISSION_PAYLOAD_V1\0', payload);
}

export function recordSha256(recordBody: CanonicalJsonValue): Promise<string> {
  return domainSeparatedSha256('SOCRATIC_ADMISSION_RECORD_V1\0', recordBody);
}
