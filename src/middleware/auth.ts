import type { Context, MiddlewareHandler } from 'hono';
import { verifyAccessToken } from '../services/auth';

export type AuthUser = {
  userId: string;
  role: string;
};

function parseBearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * Resolves the existing bearer-token identity without choosing an HTTP response.
 * Route slices with stricter public error contracts may reuse it while preserving
 * the legacy requireAuth response unchanged.
 */
export async function resolveAuthUser(c: Context): Promise<AuthUser | null> {
  const token = parseBearerToken(c.req.header('Authorization'));
  if (!token) return null;

  const secret = c.env.JWT_SECRET;
  if (!secret) return null;
  const payload = await verifyAccessToken(token, secret);
  if (!payload) return null;

  return {
    userId: payload.sub,
    role: payload.role || 'student',
  };
}

export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const authUser = await resolveAuthUser(c);
  c.set('authUser', authUser);
  await next();
};

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authUser = await resolveAuthUser(c);
  if (!authUser) {
    return c.json({ error: '인증이 필요합니다.' }, 401);
  }

  c.set('authUser', authUser);
  await next();
};

export function getAuthUser(c: Context): AuthUser | null {
  return c.get('authUser') || null;
}

export function canAccessOwnerResource(
  ownerUserId: string | null | undefined,
  requesterUserId: string | null,
): boolean {
  return Boolean(ownerUserId && requesterUserId && ownerUserId === requesterUserId);
}

export function requireRole(...allowed: string[]): MiddlewareHandler {
  return async (c, next) => {
    const authUser = getAuthUser(c);
    if (!authUser) {
      return c.json({ error: '인증이 필요합니다.' }, 401);
    }

    if (!allowed.includes(authUser.role)) {
      return c.json({ error: '권한이 없습니다.' }, 403);
    }

    await next();
  };
}
