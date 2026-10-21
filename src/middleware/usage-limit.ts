// v14.0: Usage Limit Middleware — 유저별 일일 토큰 한도
// student: 500,000 tokens/day, instructor: 2,000,000 tokens/day, admin: unlimited

import type { Context, Next } from 'hono';
import type { Bindings } from '../types';
import { getAuthUser } from './auth';

interface UsageLimits {
  dailyTokenLimit: number;
  dailyCreditLimit: number;
}

const ROLE_LIMITS: Record<string, UsageLimits> = {
  student:    { dailyTokenLimit: 500000,  dailyCreditLimit: 50 },
  instructor: { dailyTokenLimit: 2000000, dailyCreditLimit: 200 },
  admin:      { dailyTokenLimit: Infinity, dailyCreditLimit: Infinity },
};

/**
 * Middleware: Check if the authenticated user has exceeded their daily token limit.
 * Returns 429 if exceeded.
 */
export async function checkUsageLimit(c: Context, next: Next) {
  const user = getAuthUser(c);
  if (!user) return next(); // 비인증 사용자 (게스트) → 통과 (별도 제한 필요 시 추가)

  const limits = ROLE_LIMITS[user.role] || ROLE_LIMITS.student;
  if (limits.dailyTokenLimit === Infinity) return next(); // admin은 무제한

  const today = new Date().toISOString().split('T')[0];
  const db = (c.env as Bindings).DB;
  if (!db) return next(); // DB 없으면 제한 불가

  try {
    const usage = await db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens,
             COALESCE(SUM(total_estimated_credits), 0) as credits
      FROM token_usage_daily
      WHERE user_id = ?1 AND date = ?2
    `).bind(user.userId, today).first<{ tokens: number; credits: number }>();

    if (usage && usage.tokens >= limits.dailyTokenLimit) {
      return c.json({
        error: '일일 토큰 한도 초과',
        code: 'DAILY_LIMIT_EXCEEDED',
        dailyLimit: limits.dailyTokenLimit,
        currentUsage: usage.tokens,
        role: user.role,
        resetAt: '자정(KST) 또는 내일 00:00 UTC+9',
      }, 429);
    }
  } catch (e) {
    // 토큰 추적 테이블이 없으면 통과 (migration 미적용 등)
    console.warn('[USAGE_LIMIT] Check failed (non-blocking):', e);
  }

  return next();
}
