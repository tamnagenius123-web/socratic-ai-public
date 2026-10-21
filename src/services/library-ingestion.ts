export const LIBRARY_CHUNK_SIZE = 600;
export const LIBRARY_CHUNK_OVERLAP_RATIO = 0.2;
export const LIBRARY_CHUNKING_VERSION = 'sentence-600-overlap-20-v1';
export const LIBRARY_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

export function libraryVectorId(bookId: string, chunkIndex: number): string {
  return `${bookId}_chunk_${chunkIndex}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
