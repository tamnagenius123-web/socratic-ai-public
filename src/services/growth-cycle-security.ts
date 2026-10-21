import type { GrowthCycleSecurity } from './growth-cycle-types';

const encoder = new TextEncoder();

/** Creates the only permitted Worker-secret HMAC seam for Growth Cycle. */
export function createGrowthCycleSecurity(secret: string | undefined): GrowthCycleSecurity {
  const material = secret?.trim();
  if (!material) throw new Error('GROWTH_CYCLE_SECURITY_SECRET_UNAVAILABLE');
  const keyBytes = encoder.encode(material);
  return {
    async hmacSha256(purpose: string, canonicalBytes: Uint8Array): Promise<string> {
      if (!purpose.trim()) throw new Error('GROWTH_CYCLE_SECURITY_PURPOSE_REQUIRED');
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const purposeBytes = encoder.encode(`${purpose.length}:${purpose}:`);
      const payload = new Uint8Array(purposeBytes.length + canonicalBytes.length);
      payload.set(purposeBytes); payload.set(canonicalBytes, purposeBytes.length);
      const signature = await crypto.subtle.sign('HMAC', key, payload);
      return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  };
}
