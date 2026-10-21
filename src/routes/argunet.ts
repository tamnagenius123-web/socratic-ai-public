// ======================================================
// SocraticAI v27 — ArguNet + oAMF + Hybrid KT API Routes
// v27: LLM-based DA classification + real session integration
// ======================================================

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';
import { classifyDialogueActLLM, classifyDialogueAct, processArgumentMiningPipelineLLM, processArgumentMiningPipeline } from '../services/argunet-da';
import { 
  initHybridKTState, updateBKTState, initBKTState, 
  buildContextVector, recommendNextAction, updateLinUCBArm,
  adjustDifficulty, initDDAState, predictBKTPerformance
} from '../services/hybrid-kt-engine';

export const argunetRoute = new Hono<{ Bindings: Bindings }>();

// v27: ArguNet DA Classification endpoint (LLM-enhanced)
argunetRoute.post('/api/argunet/classify', requireAuth, async (c) => {
  try {
    const { utterance, previousActs, turnIndex, useLLM } = await c.req.json();
    
    if (!utterance) {
      return c.json({ error: 'utterance is required' }, 400);
    }

    // v27: Use LLM-based classification by default
    const classification = (useLLM !== false)
      ? await classifyDialogueActLLM(utterance, previousActs || [], turnIndex || 0, c.env)
      : classifyDialogueAct(utterance, previousActs || [], turnIndex || 0);

    return c.json({
      success: true,
      classification,
      metadata: {
        processor: classification.llmClassified ? 'ArguNet-v27-LLM' : 'ArguNet-v27-Rules',
        standard: 'ISO-24617-2',
        llmEnhanced: classification.llmClassified || false,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error: unknown) {
    return c.json({ error: 'DA classification failed', details: String(error) }, 500);
  }
});

// v27: oAMF Pipeline endpoint (LLM-enhanced)
argunetRoute.post('/api/argunet/pipeline', requireAuth, async (c) => {
  try {
    const { utterances, existingGraph, useLLM } = await c.req.json();
    
    if (!utterances || !Array.isArray(utterances) || utterances.length === 0) {
      return c.json({ error: 'utterances array is required' }, 400);
    }

    // v27: Use LLM pipeline when enabled
    const result = (useLLM !== false)
      ? await processArgumentMiningPipelineLLM(utterances, existingGraph, c.env)
      : processArgumentMiningPipeline(utterances, existingGraph);

    return c.json({
      success: true,
      pipeline: result,
      stats: {
        tokenCount: result.tokens.length,
        argumentCount: result.arguments.length,
        relationCount: result.relations.length,
        llmEnhanced: result.dialogueActs.some((da) => da.llmClassified === true),
        daDistribution: result.dialogueActs.reduce((acc: Record<string, number>, da) => {
          acc[da.actType] = (acc[da.actType] || 0) + 1;
          return acc;
        }, {})
      }
    });
  } catch (error: unknown) {
    return c.json({ error: 'Pipeline processing failed', details: String(error) }, 500);
  }
});

// v27: Hybrid KT State endpoint with real session integration
argunetRoute.post('/api/hybrid-kt/recommend', requireAuth, async (c) => {
  try {
    const userId = getAuthUser(c)?.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const { turnNumber, lastScore, difficulty, conceptId, isCorrect, sessionId } = await c.req.json();
    
    // Load or init state
    let state = initHybridKTState(userId);
    
    // Try load from DB
    try {
      const stored = await c.env.DB.prepare(
        'SELECT state_json FROM hybrid_kt_states WHERE user_id = ?'
      ).bind(userId).first();
      if (stored && (stored as Record<string, unknown>).state_json) {
        state = JSON.parse((stored as Record<string, unknown>).state_json as string);
      }
    } catch (e) { console.error('[P1-004] default:', e); }

    // Update BKT if concept interaction provided
    if (conceptId !== undefined) {
      if (!state.bktStates[conceptId]) {
        state.bktStates[conceptId] = initBKTState(conceptId);
      }
      state.bktStates[conceptId] = updateBKTState(
        state.bktStates[conceptId],
        isCorrect ?? (lastScore >= 60),
        difficulty || 0.5
      );
    }

    // Get recommendation
    const recommendation = recommendNextAction(
      state,
      turnNumber || 0,
      lastScore || 50,
      difficulty || 0.5
    );

    // Update LinUCB arm with reward from last action
    if (state.lastAction && lastScore !== undefined && state.linucbArms[state.lastAction]) {
      const reward = lastScore / 100;
      const context = buildContextVector(state.bktStates, turnNumber || 0, lastScore, difficulty || 0.5);
      state.linucbArms[state.lastAction] = updateLinUCBArm(
        state.linucbArms[state.lastAction],
        context,
        reward
      );
    }

    state.lastAction = recommendation.action;
    state.lastReward = lastScore;

    // Save state
    try {
      await c.env.DB.prepare(
        'INSERT OR REPLACE INTO hybrid_kt_states (user_id, state_json, updated_at) VALUES (?, ?, ?)'
      ).bind(userId, JSON.stringify(state), new Date().toISOString()).run();
    } catch (e) { console.error('[P1-004] non-critical:', e); }

    // BKT predictions for all concepts
    const conceptPredictions: Record<string, number> = {};
    for (const [cId, cState] of Object.entries(state.bktStates)) {
      conceptPredictions[cId] = Math.round(predictBKTPerformance(cState) * 100);
    }

    return c.json({
      success: true,
      recommendation,
      knowledgeState: {
        concepts: conceptPredictions,
        avgMastery: Object.values(conceptPredictions).length > 0
          ? Math.round(Object.values(conceptPredictions).reduce((a, b) => a + b, 0) / Object.values(conceptPredictions).length)
          : 50
      },
      ddaState: {
        currentDifficulty: difficulty || 0.5,
        adjustedAction: recommendation.action
      }
    });
  } catch (error: unknown) {
    return c.json({ error: 'Hybrid KT failed', details: String(error) }, 500);
  }
});

// v26: DDA (Dynamic Difficulty Adjustment) endpoint
argunetRoute.post('/api/dda/adjust', requireAuth, async (c) => {
  try {
    const { score, responseTimeMs, currentState } = await c.req.json();
    
    const state = currentState || initDDAState();
    const newState = adjustDifficulty(state, score || 50, responseTimeMs || 30000);
    
    return c.json({
      success: true,
      difficulty: newState.currentDifficulty,
      state: newState,
      recommendation: newState.currentDifficulty > 0.7 
        ? '고급 과제 추천' 
        : newState.currentDifficulty > 0.4 
          ? '중급 과제 추천' 
          : '기초 강화 추천'
    });
  } catch (error: unknown) {
    return c.json({ error: 'DDA adjustment failed', details: String(error) }, 500);
  }
});

// v27: Get user's BKT knowledge state (for dashboard visualization)
argunetRoute.get('/api/hybrid-kt/state', requireAuth, async (c) => {
  try {
    const userId = getAuthUser(c)?.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const stored = await c.env.DB.prepare(
      'SELECT state_json, updated_at FROM hybrid_kt_states WHERE user_id = ?'
    ).bind(userId).first();

    if (!stored || !(stored as Record<string, unknown>).state_json) {
      return c.json({ success: true, state: null, message: 'No KT state found' });
    }

    const state = JSON.parse((stored as Record<string, unknown>).state_json as string);
    
    // Compute predictions
    const conceptPredictions: Record<string, { mastery: number; lastUpdated: string }> = {};
    for (const [cId, cState] of Object.entries(state.bktStates || {})) {
      const s = cState as { pKnown: number; pGuess: number; pSlip: number; lastUpdated: string };
      conceptPredictions[cId] = {
        mastery: Math.round(predictBKTPerformance(s as ReturnType<typeof initBKTState>) * 100),
        lastUpdated: s.lastUpdated || ''
      };
    }

    // Compute LinUCB stats
    const actionStats: Record<string, { pulls: number; avgReward: number }> = {};
    for (const [armId, arm] of Object.entries(state.linucbArms || {})) {
      const a = arm as { pullCount: number; totalReward: number };
      actionStats[armId] = {
        pulls: a.pullCount || 0,
        avgReward: a.pullCount > 0 ? Math.round((a.totalReward / a.pullCount) * 100) : 0
      };
    }

    return c.json({
      success: true,
      state: {
        concepts: conceptPredictions,
        actionStats,
        lastAction: state.lastAction,
        updatedAt: (stored as Record<string, unknown>).updated_at
      }
    });
  } catch (error: unknown) {
    return c.json({ error: 'Failed to fetch KT state', details: String(error) }, 500);
  }
});
