// ============================================================
// v20 Remediation Tests
// ============================================================
// Hybrid KT history, LinUCB selection, Self-CASS semantics,
// JSON-LD export, Adapter ARC, Vectorize fallback, Debate flow
// ============================================================

import { describe, it, expect } from 'vitest';

// =============================================
// P0-A: Hybrid KT Data Loop
// =============================================
describe('Hybrid KT Engine', () => {
  it('computeHybridKT should use interactionHistory for DKT stream', async () => {
    const { computeHybridKT } = await import('../src/services/math/hybrid-kt-engine');

    // With empty history → DKT returns 0.3 (placeholder)
    const resultEmpty = computeHybridKT('algebra', { p_know: 0.5, p_transit: 0.1, p_slip: 0.15, p_guess: 0.25 }, [], 1000, true);
    expect(resultEmpty.dktPKnow).toBe(0.3);
    expect(resultEmpty.ktMethod).toBe('ensemble');

    // With real history → DKT should return something different from 0.3
    const history = [
      { correct: true, difficulty: 0.5 },
      { correct: true, difficulty: 0.6 },
      { correct: false, difficulty: 0.8 },
      { correct: true, difficulty: 0.5 },
      { correct: true, difficulty: 0.7 },
    ];
    const resultWithHistory = computeHybridKT('algebra', { p_know: 0.5, p_transit: 0.1, p_slip: 0.15, p_guess: 0.25 }, history, 1000, true);
    expect(resultWithHistory.dktPKnow).not.toBe(0.3);
    expect(resultWithHistory.dktPKnow).toBeGreaterThan(0);
    expect(resultWithHistory.dktPKnow).toBeLessThanOrEqual(1);
    expect(resultWithHistory.ensembledPKnow).toBeGreaterThan(0);
    expect(resultWithHistory.confidence).toBeGreaterThan(0);
  });

  it('DKT should detect consecutive correct streak (learning leap)', async () => {
    const { computeHybridKT } = await import('../src/services/math/hybrid-kt-engine');
    const longStreak = Array.from({ length: 6 }, () => ({ correct: true, difficulty: 0.5 }));
    const result = computeHybridKT('logic', { p_know: 0.3, p_transit: 0.1, p_slip: 0.15, p_guess: 0.25 }, longStreak, 1200, true);
    // With a long correct streak, DKT p_know should be high
    expect(result.dktPKnow).toBeGreaterThan(0.6);
  });
});

// =============================================
// P0-B: LinUCB Real Selection
// =============================================
describe('LinUCB Engine', () => {
  it('selectLinUCBAction should return a valid action from arms', async () => {
    const { createLinUCBArm, selectLinUCBAction, updateLinUCBArm } = await import('../src/services/math/linucb-engine');

    const arms = ['ask_evidence', 'ask_counterexample', 'ask_definition'].map(a => createLinUCBArm(a));
    const context = {
      daTags: new Array(14).fill(0),
      thoughtProfile: [0.5, 0.3, 0.2, 0.4],
      challengeLevel: 0.6,
      eloNormalized: 0,
      revisionDebt: 0.5,
      turnProgress: 0.3,
    };

    const result = selectLinUCBAction(arms, context, 1.0);
    expect(['ask_evidence', 'ask_counterexample', 'ask_definition']).toContain(result.action);
    expect(typeof result.ucb).toBe('number');
  });

  it('updateLinUCBArm should modify A matrix and b vector', async () => {
    const { createLinUCBArm, updateLinUCBArm } = await import('../src/services/math/linucb-engine');

    const arm = createLinUCBArm('ask_evidence');
    const context = {
      daTags: new Array(14).fill(0.1),
      thoughtProfile: [0.5, 0.3, 0.2, 0.4],
      challengeLevel: 0.6,
      eloNormalized: 0,
      revisionDebt: 0.5,
      turnProgress: 0.3,
    };

    const updated = updateLinUCBArm(arm, context, 0.8);
    expect(updated.timesSelected).toBe(1);
    expect(updated.totalReward).toBe(0.8);
    // A matrix should be modified (not identity anymore for some entries)
    expect(updated.A[0][0]).toBeGreaterThan(1); // diagonal should increase
    // b vector should have non-zero entries
    expect(updated.b.some(v => v !== 0)).toBe(true);
  });
});

// =============================================
// P0-C: Self-CASS Semantics
// =============================================
describe('Self-CASS Metrics', () => {
  it('SelfCASSMetrics should have relationBalance, not kappa', async () => {
    const { computeCASSMetrics } = await import('../src/services/math/xaif-schema');

    const mockDoc = {
      AIF: {
        nodes: [
          { nodeID: 'L1', type: 'L' as const, text: 'test locution', personID: 'student', timestamp: 0, turnNumber: 1 },
          { nodeID: 'I1', type: 'I' as const, text: 'test claim', scheme: undefined, confidence: 0.8, subtype: 'claim' as const },
          { nodeID: 'I2', type: 'I' as const, text: 'test premise', scheme: undefined, confidence: 0.7, subtype: 'premise' as const },
        ],
        edges: [
          { edgeID: 'TA1', fromID: 'L1', toID: 'I1', type: 'TA' as const },
          { edgeID: 'RA1', fromID: 'I2', toID: 'I1', type: 'RA' as const, relation: 'support' as const },
        ],
        locutions: [],
        participants: [],
      },
      metadata: {
        sessionId: 'test', turnNumber: 1, timestamp: Date.now(),
        argumentStrength: 50, missingEdgeCount: 0,
      },
      version: '2.0' as const,
    };

    const metrics = computeCASSMetrics(mockDoc);
    // v20 P0-C: kappa 필드가 없고 relationBalance 필드가 있어야 함
    expect('relationBalance' in metrics).toBe(true);
    expect('kappa' in metrics).toBe(false);
    expect(metrics.relationBalance).toBeGreaterThanOrEqual(0);
    expect(metrics.macroF1).toBeGreaterThanOrEqual(0);
    expect(metrics.uAlpha).toBeGreaterThanOrEqual(0);
  });

  it('CASSBenchmarkResult should have kappaInterAnnotator (gold comparison only)', async () => {
    const { computeCASSBenchmark } = await import('../src/services/math/xaif-schema');

    const makeDoc = (nodes: any[], edges: any[]) => ({
      AIF: { nodes, edges, locutions: [], participants: [] },
      metadata: { sessionId: 'test', turnNumber: 1, timestamp: Date.now(), argumentStrength: 50, missingEdgeCount: 0 },
      version: '2.0' as const,
    });

    const predicted = makeDoc(
      [{ nodeID: 'I1', type: 'I', text: 'cats are pets', confidence: 0.9 }],
      [],
    );
    const gold = makeDoc(
      [{ nodeID: 'G1', type: 'I', text: 'cats are domestic pets', confidence: 1.0 }],
      [],
    );

    const result = computeCASSBenchmark(predicted, gold);
    expect('kappaInterAnnotator' in result).toBe(true);
    expect(result.macroF1VsGold).toBeGreaterThanOrEqual(0);
    expect(result.nodeAlignment.precision).toBeGreaterThanOrEqual(0);
  });
});

// =============================================
// P0-D: JSON-LD Serialization
// =============================================
describe('JSON-LD Serialization', () => {
  it('serializeToJSONLD should produce valid @context and @type', async () => {
    const { serializeToJSONLD } = await import('../src/services/math/xaif-schema');

    const doc = {
      AIF: {
        nodes: [
          { nodeID: 'I1', type: 'I' as const, text: 'test', confidence: 0.8 },
        ],
        edges: [],
        locutions: [],
        participants: [{ participantID: 'student', firstname: 'Student', role: 'learner' }],
      },
      metadata: {
        sessionId: 'sess1', turnNumber: 1, timestamp: Date.now(),
        argumentStrength: 50, missingEdgeCount: 0,
      },
      version: '2.0' as const,
    };

    const jsonld = serializeToJSONLD(doc) as any;
    expect(jsonld['@context']).toBeDefined();
    expect(jsonld['@context'].aif).toBe('http://www.arg.dundee.ac.uk/aif#');
    expect(jsonld['@type']).toBe('xaif:ArgumentDocument');
    expect(jsonld['@id']).toContain('urn:socratic-ai:session:sess1:turn:1');
    expect(jsonld['aif:hasNode']).toHaveLength(1);
  });
});

// =============================================
// P0-E: Adapter-aware ARC Inference
// =============================================
describe('Adapter-aware ARC', () => {
  it('inferARCWithAdapter should fallback to heuristic when no URL', async () => {
    const { inferARCWithAdapter } = await import('../src/services/tutoring/illocutionary-encoder');

    const result = await inferARCWithAdapter(
      {
        act: 'counter_assertion',
        context: {
          prevDATags: new Array(14).fill(0),
          avgIllocutionaryStrength: 0.5,
          challengePressureIndex: 0.3,
          revisionTendency: 0.2,
          currentState: 'reasoning',
          turnProgress: 0.5,
        },
        illoForce: { category: 'assertive', strength: 0.8, certainty: 0.7, polarity: 'negative', hedging: 0.2 },
        utterance: '그건 틀렸어요. 증거가 부족합니다.',
      },
      {}, // no adapter URL
    );

    expect(result.source).toBe('heuristic');
    expect(result.adapterId).toBe('heuristic-v19');
    expect(result.support + result.attack + result.neutral).toBeCloseTo(1, 1);
  });
});

// =============================================
// Debate Arena Basic Flow
// =============================================
describe('Debate Arena', () => {
  it('should import debate route without errors', async () => {
    const { debateRoute } = await import('../src/routes/debate');
    expect(debateRoute).toBeDefined();
  });
});

// =============================================
// Badge / ZKP
// =============================================
describe('ZKP Badge', () => {
  it('should import badge route without errors', async () => {
    const { badgeRoute } = await import('../src/routes/badge');
    expect(badgeRoute).toBeDefined();
  });
});
