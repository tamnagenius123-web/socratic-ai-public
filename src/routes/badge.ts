// ============================================================
// v23: ZKP Cognitive Credentialing Routes
// v23 Changes:
//   - Hardcoded HMAC secret removed → c.env.ZKP_HMAC_SECRET
//   - HMAC fallback now returns verified: false
//   - ZKP Provider response typed (no more `as any`)
//   - Error catch typed properly
//   - D1 row types applied
// ============================================================

import { Hono } from 'hono';
import type { ProcessEvaluationRow, BadgeWithProofRow, ZKPProviderResponse } from '../types/d1-rows';
import { requireAuth, getAuthUser } from '../middleware/auth';

interface BadgeBindings {
  DB: D1Database;
  JWT_SECRET: string;
  ZKP_HMAC_SECRET?: string;      // v23: Environment variable (Cloudflare Secret)
  ZKP_PROVIDER_URL?: string;     // v23: ZKP Provider Worker URL
}

const badgeRoute = new Hono<{ Bindings: BadgeBindings }>();

badgeRoute.use('/api/badges/issue', requireAuth);
badgeRoute.use('/api/badges/user/*', requireAuth);

/**
 * POST /api/badges/issue — 인지 배지 발급
 * processScore가 threshold 이상이면 ZKP proof를 생성하고 배지 발급
 */
badgeRoute.post('/api/badges/issue', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const body = await c.req.json<{
    sessionId: string;
    badgeType?: string;
  }>();
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);

  if (!body.sessionId) {
    return c.json({ error: 'sessionId is required' }, 400);
  }

  try {
    // 세션의 process evaluation 조회
    const evalRow = await db.prepare(
      `SELECT process_score, snapshot_json FROM session_process_evaluations
       WHERE session_id = ?1 AND user_id = ?2`
    ).bind(body.sessionId, auth.userId).first<ProcessEvaluationRow>();

    if (!evalRow) {
      return c.json({ error: 'No process evaluation found for this session' }, 404);
    }

    const processScore = evalRow.process_score;
    const minScoreThreshold = 60; // 최소 60점 이상이어야 배지 발급

    if (processScore < minScoreThreshold) {
      return c.json({
        error: 'Process score below threshold',
        processScore,
        threshold: minScoreThreshold,
      }, 400);
    }

    // Trajectory hash 생성
    const trajectoryHash = await computeTrajectoryHash(evalRow.snapshot_json || '[]');

    // ZKP proof 생성 (외부 provider 또는 HMAC fallback)
    const proof = await generateZKProof({
      processScore,
      trajectoryHash,
      minScoreThreshold,
      proofProviderUrl: c.env.ZKP_PROVIDER_URL,
      hmacSecret: c.env.ZKP_HMAC_SECRET,
    });
    if (!proof.verified) {
      return c.json({ error: '검증 가능한 자격 증명 발급기가 구성되지 않았습니다.' }, 503);
    }

    // ZKP proof 저장
    const proofId = `zkp_${body.sessionId}_${Date.now()}`;
    await db.prepare(
      `INSERT INTO zkp_proofs (id, user_id, session_id, proof_system, public_input_json, proof_json, verifier_status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      proofId, auth.userId, body.sessionId,
      proof.proofSystem,
      JSON.stringify(proof.publicInput),
      JSON.stringify(proof.proofData),
      proof.verified ? 'verified' : 'pending',
      Date.now(),
    ).run();

    // 배지 발급
    const badgeId = `badge_${auth.userId}_${body.sessionId}_${Date.now()}`;
    const badgeType = body.badgeType || (processScore >= 90 ? 'gold_critical_thinker' : processScore >= 75 ? 'silver_critical_thinker' : 'bronze_critical_thinker');

    await db.prepare(
      `INSERT INTO cognitive_badges (id, user_id, session_id, proof_id, badge_type, process_score, trajectory_hash, issued_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      badgeId, auth.userId, body.sessionId,
      proofId, badgeType, processScore, trajectoryHash,
      Date.now(),
    ).run();

    return c.json({
      ok: true,
      badge: {
        id: badgeId,
        type: badgeType,
        processScore,
        trajectoryHash,
        proofId,
        verified: proof.verified,
        proofSystem: proof.proofSystem,
      },
    });
  } catch (error: unknown) {
    console.error('[BADGE_ISSUE]', error);
    return c.json({ error: '자격 증명 발급에 실패했습니다.' }, 500);
  }
});

/**
 * GET /api/badges/user/:userId — 사용자 배지 조회
 */
badgeRoute.get('/api/badges/user/:userId', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const userId = c.req.param('userId');
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);
  if (userId !== auth.userId && !['admin', 'instructor'].includes(auth.role)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const badges = await db.prepare(
    `SELECT b.*, p.verifier_status, p.proof_system
     FROM cognitive_badges b
     LEFT JOIN zkp_proofs p ON b.proof_id = p.id
     WHERE b.user_id = ?1 AND b.revoked_at IS NULL
     ORDER BY b.issued_at DESC`
  ).bind(userId).all();

  return c.json({ userId, badges: badges.results || [] });
});

/**
 * GET /api/badges/verify/:badgeId — 배지 검증
 */
badgeRoute.get('/api/badges/verify/:badgeId', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const badgeId = c.req.param('badgeId');

  const badge = await db.prepare(
    `SELECT b.*, p.proof_json, p.public_input_json, p.verifier_status, p.proof_system
     FROM cognitive_badges b
     LEFT JOIN zkp_proofs p ON b.proof_id = p.id
     WHERE b.id = ?1`
  ).bind(badgeId).first<BadgeWithProofRow>();

  if (!badge) return c.json({ error: 'Badge not found' }, 404);

  return c.json({
    valid: badge.revoked_at === null && badge.verifier_status === 'verified',
    badge: {
      id: badge.id,
      type: badge.badge_type,
      processScore: badge.process_score,
      trajectoryHash: badge.trajectory_hash,
      issuedAt: badge.issued_at,
      revokedAt: badge.revoked_at,
      proofSystem: badge.proof_system,
      verifierStatus: badge.verifier_status,
    },
  });
});

// =============================================
// Helpers
// =============================================

async function computeTrajectoryHash(snapshotJson: string): Promise<string> {
  const data = new TextEncoder().encode(snapshotJson);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * v23 Architecture: External ZKP Proof Provider + Secure HMAC Fallback
 * 
 * 1. External Provider (Poseidon-Merkle or Groth16) for production-grade ZKP
 * 2. HMAC-Commitment (Legacy) for development fallback — returns verified: false
 * 
 * CRITICAL v23 Changes:
 * - HMAC secret moved from hardcoded → env variable
 * - HMAC fallback returns verified: false (not a real ZKP)
 * - ZKP Provider response properly typed (ZKPProviderResponse)
 */
interface ZKProofInput {
  processScore: number;
  trajectoryHash: string;
  minScoreThreshold: number;
  proofProviderUrl?: string;
  hmacSecret?: string;
}

interface ZKProofOutput {
  proofSystem: string;
  publicInput: Record<string, unknown>;
  proofData: Record<string, unknown>;
  verified: boolean;
}

async function generateZKProof(input: ZKProofInput): Promise<ZKProofOutput> {
  const publicInput = {
    minScoreThreshold: input.minScoreThreshold,
    processScoreAboveThreshold: input.processScore >= input.minScoreThreshold,
    trajectoryHashCommitment: input.trajectoryHash.substring(0, 16),
  };

  // Option A: External ZKP Provider Worker (Poseidon-Merkle or Groth16)
  const providerUrl = input.proofProviderUrl;
  
  if (providerUrl) {
    try {
      const res = await fetch(providerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuit: 'critical_thinker_v1',
          publicInput,
          privateInput: {
            processScore: input.processScore,
            trajectoryHash: input.trajectoryHash,
          },
        }),
      });

      if (res.ok) {
        const proof: ZKPProviderResponse = await res.json();
        return {
          proofSystem: proof.proofSystem || 'poseidon-merkle-v1',
          publicInput,
          proofData: proof.proof || {},
          verified: proof.verified,
        };
      }
    } catch (e) {
      console.warn('[ZKP_PROVIDER] External provider unavailable, falling back to HMAC commitment.');
    }
  }

  // Legacy Fallback: HMAC-based commitment scheme
  // v23 SECURITY: Secret from environment variable, NOT hardcoded
  // v23 INTEGRITY: verified = false — HMAC is NOT zero-knowledge proof
  const hmacSecret = input.hmacSecret;
  if (!hmacSecret) {
    return {
      proofSystem: 'unavailable',
      publicInput,
      proofData: { status: 'provider_required' },
      verified: false,
    };
  }
  
  const commitmentData = new TextEncoder().encode(
    `${input.processScore}:${input.trajectoryHash}:${input.minScoreThreshold}`
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, commitmentData);
  const proofHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    proofSystem: 'hmac-commitment-legacy-v1',
    publicInput,
    proofData: {
      commitment: proofHex,
      scheme: 'HMAC-SHA256',
      status: 'legacy-fallback',
      note: 'HMAC-based commitment is NOT zero-knowledge. Deploy ZKP Provider Worker for production.',
    },
    verified: false, // v23: HMAC commitment is NOT a real ZKP — cannot verify without revealing score
  };
}

export { badgeRoute };
