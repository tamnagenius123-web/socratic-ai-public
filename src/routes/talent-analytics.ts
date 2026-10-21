// =============================================
// v17 B2B Talent Analytics API
// =============================================
// DeepSkill식 조직 역량 정량화 + Hi-Po 식별
// 4축 마이크로 지표 기반 탤런트 스냅샷
// =============================================

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, requireRole, getAuthUser } from '../middleware/auth';
import type { TalentSnapshotRow } from '../types/d1-rows';

const talentRoute = new Hono<{ Bindings: Bindings }>();

talentRoute.use('/api/talent/*', requireAuth);

// =============================================
// GET /api/talent/org/:orgId/dashboard
// 조직 역량 대시보드 (manager+ only)
// =============================================
talentRoute.get('/api/talent/org/:orgId/dashboard', async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증 필요' }, 401);

    const db = c.env.DB;

    // Verify org membership
    const membership = await db.prepare(
      'SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2'
    ).bind(orgId, auth.userId).first<any>();

    if (!membership || !['owner', 'admin', 'manager'].includes(membership.role)) {
      return c.json({ error: '조직 관리 권한이 필요합니다.' }, 403);
    }

    // Get all members' latest snapshots
    const snapshots = await db.prepare(`
      SELECT ts.*, u.username, u.email, om.team_id
      FROM talent_snapshots ts
      JOIN users u ON ts.user_id = u.id
      JOIN org_memberships om ON ts.org_id = om.org_id AND ts.user_id = om.user_id
      WHERE ts.org_id = ?1
      AND ts.snapshot_date = (
        SELECT MAX(ts2.snapshot_date) FROM talent_snapshots ts2
        WHERE ts2.org_id = ts.org_id AND ts2.user_id = ts.user_id
      )
      ORDER BY ts.hipo_score DESC
    `).bind(orgId).all<TalentSnapshotRow>();

    // Aggregate org-level stats
    const members = snapshots.results || [];
    const avgLogical = members.reduce((s: number, m: TalentSnapshotRow) => s + (m.logical_structuring || 0), 0) / Math.max(1, members.length);
    const avgData = members.reduce((s: number, m: TalentSnapshotRow) => s + (m.data_literacy || 0), 0) / Math.max(1, members.length);
    const avgFlex = members.reduce((s: number, m: TalentSnapshotRow) => s + (m.cognitive_flexibility || 0), 0) / Math.max(1, members.length);
    const avgComm = members.reduce((s: number, m: TalentSnapshotRow) => s + (m.business_communication || 0), 0) / Math.max(1, members.length);

    // Hi-Po identification (top 20%)
    const hipoThreshold = members.length >= 5
      ? members[Math.floor(members.length * 0.2)]?.hipo_score || 70
      : 70;

    const hiPoMembers = members.filter(( m: TalentSnapshotRow) => m.hipo_score >= hipoThreshold);

    // Risk flags
    const riskMembers = members.filter(( m: TalentSnapshotRow) => {
      try {
        const flags = JSON.parse(m.risk_flags_json || '[]');
        return flags.length > 0;
      } catch (e) { console.error('[P1-004] false:', e); return false; }
    });

    return c.json({
      orgId,
      memberCount: members.length,
      orgAverage: {
        logicalStructuring: Math.round(avgLogical * 10) / 10,
        dataLiteracy: Math.round(avgData * 10) / 10,
        cognitiveFlexibility: Math.round(avgFlex * 10) / 10,
        businessCommunication: Math.round(avgComm * 10) / 10,
      },
      hiPo: {
        threshold: hipoThreshold,
        count: hiPoMembers.length,
        members: hiPoMembers.map(( m: TalentSnapshotRow) => ({
          userId: m.user_id,
          username: m.username,
          hipoScore: m.hipo_score,
          topAxis: getTopAxis(m),
        })),
      },
      risk: {
        count: riskMembers.length,
        members: riskMembers.slice(0, 5).map(( m: TalentSnapshotRow) => ({
          userId: m.user_id,
          username: m.username,
          flags: JSON.parse(m.risk_flags_json || '[]'),
        })),
      },
      allMembers: members.map(( m: TalentSnapshotRow) => ({
        userId: m.user_id,
        username: m.username,
        email: m.email,
        teamId: m.team_id,
        logical: m.logical_structuring,
        data: m.data_literacy,
        flexibility: m.cognitive_flexibility,
        communication: m.business_communication,
        hipoScore: m.hipo_score,
        sessionCount: m.session_count,
        totalTurns: m.total_turns,
        snapshotDate: m.snapshot_date,
      })),
    });
  } catch (error: unknown) {
    console.error('[TALENT] Dashboard error:', error);
    return c.json({ error: (error instanceof Error ? error.message : '') || 'Talent analytics 로딩 실패' }, 500);
  }
});

// =============================================
// GET /api/talent/org/:orgId/member/:userId
// 개인 역량 상세 (manager+ or self)
// =============================================
talentRoute.get('/api/talent/org/:orgId/member/:userId', async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const targetUserId = c.req.param('userId');
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증 필요' }, 401);

    const db = c.env.DB;

    // Permission check (self or manager+)
    if (auth.userId !== targetUserId) {
      const membership = await db.prepare(
        'SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2'
      ).bind(orgId, auth.userId).first<any>();
      if (!membership || !['owner', 'admin', 'manager'].includes(membership.role)) {
        return c.json({ error: '접근 권한이 없습니다.' }, 403);
      }
    }

    // Get snapshot history
    const history = await db.prepare(`
      SELECT * FROM talent_snapshots
      WHERE org_id = ?1 AND user_id = ?2
      ORDER BY snapshot_date DESC LIMIT 30
    `).bind(orgId, targetUserId).all();

    // Get micro scores from recent sessions
    const recentMicro = await db.prepare(`
      SELECT sms.indicator_id, AVG(sms.normalized_score) as avg_score, COUNT(*) as count
      FROM session_micro_scores sms
      JOIN sessions s ON sms.session_id = s.id
      WHERE s.user_id = ?1
      GROUP BY sms.indicator_id
      ORDER BY avg_score ASC
    `).bind(targetUserId).all();

    // Growth profile
    const growth = await db.prepare(
      'SELECT * FROM student_growth_profile WHERE user_id = ?1'
    ).bind(targetUserId).first<any>();

    return c.json({
      userId: targetUserId,
      orgId,
      snapshots: history.results || [],
      microIndicators: recentMicro.results || [],
      growthProfile: growth ? {
        totalSessions: growth.total_sessions,
        totalTurns: growth.total_turns,
        elo: {
          evidence: growth.elo_evidence,
          reasoning: growth.elo_reasoning,
          defense: growth.elo_defense,
          clarity: growth.elo_clarity,
          consistency: growth.elo_consistency,
        },
        chronicWeaknesses: JSON.parse(growth.chronic_weaknesses || '[]'),
      } : null,
    });
  } catch (error: unknown) {
    console.error('[TALENT] Member detail error:', error);
    return c.json({ error: (error instanceof Error ? error.message : '') || '멤버 상세 로딩 실패' }, 500);
  }
});

// =============================================
// POST /api/talent/org/:orgId/snapshot
// 탤런트 스냅샷 생성 (수동 트리거 or CRON)
// =============================================
talentRoute.post('/api/talent/org/:orgId/snapshot', requireRole('admin'), async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const db = c.env.DB;
    const today = new Date().toISOString().split('T')[0];

    // Get all org members
    const members = await db.prepare(
      'SELECT user_id FROM org_memberships WHERE org_id = ?1'
    ).bind(orgId).all();

    let created = 0;

    for (const member of (members.results || []) as Array<{ user_id: string }>) {
      const userId = member.user_id;

      // Get aggregated micro scores
      const microResult = await db.prepare(`
        SELECT 
          AVG(CASE WHEN sms.indicator_id LIKE 'ls_%' THEN sms.normalized_score END) as logical,
          AVG(CASE WHEN sms.indicator_id LIKE 'dl_%' THEN sms.normalized_score END) as data_lit,
          AVG(CASE WHEN sms.indicator_id LIKE 'cf_%' THEN sms.normalized_score END) as flexibility,
          AVG(CASE WHEN sms.indicator_id LIKE 'bc_%' THEN sms.normalized_score END) as communication,
          COUNT(DISTINCT sms.session_id) as session_count,
          SUM(CASE WHEN sms.turn_number IS NOT NULL THEN 1 ELSE 0 END) as total_turns
        FROM session_micro_scores sms
        JOIN sessions s ON sms.session_id = s.id
        WHERE s.user_id = ?1
      `).bind(userId).first<any>();

      const logical = (microResult?.logical || 0.5) * 100;
      const data = (microResult?.data_lit || 0.5) * 100;
      const flex = (microResult?.flexibility || 0.5) * 100;
      const comm = (microResult?.communication || 0.5) * 100;

      const hipoScore = logical * 0.30 + data * 0.25 + flex * 0.25 + comm * 0.20;
      const decisionRigor = (logical * 0.5 + data * 0.5);
      const revisionMaturity = (flex * 0.6 + comm * 0.4);
      const evidenceDiscipline = (data * 0.7 + logical * 0.3);

      // Risk detection
      const riskFlags: string[] = [];
      if (logical < 30) riskFlags.push('low_logical_structuring');
      if (data < 30) riskFlags.push('low_data_literacy');
      if (flex < 25) riskFlags.push('rigid_thinking');
      if ((microResult?.session_count || 0) < 3) riskFlags.push('insufficient_data');

      const snapshotId = `snap_${orgId}_${userId}_${today}`.replace(/[^a-zA-Z0-9_-]/g, '_');

      await db.prepare(`
        INSERT OR REPLACE INTO talent_snapshots
        (id, org_id, user_id, snapshot_date, logical_structuring, data_literacy,
         cognitive_flexibility, business_communication, hipo_score, decision_rigor_index,
         revision_maturity, evidence_discipline, session_count, total_turns, risk_flags_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
      `).bind(
        snapshotId, orgId, userId, today,
        Math.round(logical * 10) / 10,
        Math.round(data * 10) / 10,
        Math.round(flex * 10) / 10,
        Math.round(comm * 10) / 10,
        Math.round(hipoScore * 10) / 10,
        Math.round(decisionRigor * 10) / 10,
        Math.round(revisionMaturity * 10) / 10,
        Math.round(evidenceDiscipline * 10) / 10,
        microResult?.session_count || 0,
        microResult?.total_turns || 0,
        JSON.stringify(riskFlags),
        Date.now(),
      ).run().catch(() => {});

      created++;
    }

    return c.json({ success: true, orgId, date: today, snapshotsCreated: created });
  } catch (error: unknown) {
    console.error('[TALENT] Snapshot creation error:', error);
    return c.json({ error: (error instanceof Error ? error.message : '') || '스냅샷 생성 실패' }, 500);
  }
});

// =============================================
// POST /api/talent/org — Create organization
// =============================================
talentRoute.post('/api/talent/org', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증 필요' }, 401);

    const { name } = await c.req.json<{ name: string }>();
    if (!name) return c.json({ error: 'name은 필수입니다.' }, 400);

    const db = c.env.DB;
    const orgId = 'org_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    // Add creator as owner
    await db.prepare(`
      INSERT INTO org_memberships (org_id, user_id, role, joined_at)
      VALUES (?1, ?2, 'owner', ?3)
    `).bind(orgId, auth.userId, Date.now()).run();

    return c.json({ success: true, orgId, name });
  } catch (error: unknown) {
    return c.json({ error: (error instanceof Error ? error.message : '') || '조직 생성 실패' }, 500);
  }
});

// =============================================
// POST /api/talent/org/:orgId/members — Add member
// =============================================
talentRoute.post('/api/talent/org/:orgId/members', requireRole('admin'), async (c) => {
  try {
    const orgId = c.req.param('orgId');
    const { userId, teamId, role } = await c.req.json<{
      userId: string; teamId?: string; role?: string;
    }>();

    if (!userId) return c.json({ error: 'userId는 필수입니다.' }, 400);

    const db = c.env.DB;
    await db.prepare(`
      INSERT OR IGNORE INTO org_memberships (org_id, user_id, team_id, role, joined_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(orgId, userId, teamId || null, role || 'member', Date.now()).run();

    return c.json({ success: true, orgId, userId });
  } catch (error: unknown) {
    return c.json({ error: (error instanceof Error ? error.message : '') || '멤버 추가 실패' }, 500);
  }
});

// =============================================
// GET /api/talent/my-indicators — 개인 4축 지표 조회
// =============================================
talentRoute.get('/api/talent/my-indicators', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증 필요' }, 401);

    const db = c.env.DB;

    const result = await db.prepare(`
      SELECT sms.indicator_id,
        AVG(sms.normalized_score) as avg_score,
        COUNT(*) as samples,
        MAX(sms.created_at) as last_scored_at
      FROM session_micro_scores sms
      JOIN sessions s ON sms.session_id = s.id
      WHERE s.user_id = ?1
      GROUP BY sms.indicator_id
      ORDER BY sms.indicator_id ASC
    `).bind(auth.userId).all();

    // Group by axis
    const grouped: Record<string, any[]> = { logical: [], data: [], flexibility: [], communication: [] };
    for (const row of (result.results || []) as Array<{ indicator_id: string; avg_score: number; samples: number }>) {
      const prefix = row.indicator_id.substring(0, 2);
      const axis = prefix === 'ls' ? 'logical' : prefix === 'dl' ? 'data' : prefix === 'cf' ? 'flexibility' : 'communication';
      grouped[axis].push({
        id: row.indicator_id,
        avgScore: Math.round(row.avg_score * 100) / 100,
        samples: row.samples,
      });
    }

    return c.json({ userId: auth.userId, indicators: grouped });
  } catch (error: unknown) {
    console.error('[TALENT] My indicators error:', error);
    return c.json({ indicators: { logical: [], data: [], flexibility: [], communication: [] } });
  }
});

function getTopAxis( m: TalentSnapshotRow): string {
  const axes = [
    { name: 'logical', score: m.logical_structuring },
    { name: 'data', score: m.data_literacy },
    { name: 'flexibility', score: m.cognitive_flexibility },
    { name: 'communication', score: m.business_communication },
  ];
  return axes.sort((a, b) => b.score - a.score)[0]?.name || 'logical';
}

export default talentRoute;
