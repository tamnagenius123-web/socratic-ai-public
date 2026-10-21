import { describe, expect, it } from 'vitest';
import { buildTrainingRouteOffer, trainingRouteActionPreference, trainingRouteDirective, type TrainingRouteDecision } from '../src/services/training/training-route';
import type { DeepEvaluation } from '../src/services/tutoring/types';
import type { ReadyEvidenceGroundedScenario } from '../src/services/training/scenario-evidence';

const source = (id: string) => ({ sourceId: id, selectionIndex: 0, bookId: id, bookTitle: id, bookAuthor: 'Author', chunkId: id, chunkIndex: 0, charStart: 0, charEnd: 8, excerpt: 'Evidence', contentSha256: 'b'.repeat(64), relevanceScore: 1, lifecycleStatus: 'active' as const });
const build: ReadyEvidenceGroundedScenario = {
 status: 'ready', evidencePack: { status: 'ready', query: 'policy', manifestSha256: 'a'.repeat(64), sources: [source('a'), source('b')], sourceCount: 2, bookCount: 2 },
 scenario: { title: 'Policy', role: 'Analyst', context: 'Compare policies', decisionQuestion: 'Which policy meets the constraint?', constraints: ['Equal access'], stakeholders: ['Students', 'Teachers'], tradeoffs: ['Cost versus access'], expectedTensions: ['Cost'], sessionGoal: 'Justify a decision', evidenceSourceIds: ['a', 'b'], rubric: [{ id: 'claim', label: 'Claim', description: 'State a claim', weight: 0.5 }, { id: 'evidence', label: 'Evidence', description: 'Justify with sources', weight: 0.5 }] },
 question: { title: 'Policy', question: 'Which?', context: 'Compare', expected_tensions: ['Cost'], sessionGoal: 'Justify', briefing: { summary: '', key_numbers: [], angles: [], sources: [] } },
};

describe('evidence-bound task-local route offers', () => {
 it('offers three orders with the same rubric and linked alternatives without efficacy claims', () => {
  const offer = buildTrainingRouteOffer('session-a', build);
  expect(offer.options.map(o => o.route)).toEqual(['case-first', 'proof-first', 'mixed']);
  expect(offer.efficacy).toBe('UNKNOWN');
  expect(offer.target.rubric).toEqual(build.scenario.rubric);
  for (const option of offer.options) {
   expect(option.supportStatus).toBe('TASK_SUPPORTED');
   expect(option.evidenceRefs).toContain('scenario:decisionQuestion');
   expect(option.alternatives).toHaveLength(2);
   expect(option.alternatives.every(a => a.evidenceRefs.length > 0)).toBe(true);
  }
  expect(buildTrainingRouteOffer('session-a', build)).toEqual(offer);
  expect(buildTrainingRouteOffer('session-b', build).taskIdentity).not.toEqual(offer.taskIdentity);
 });
 it('changes introductory order without overriding a low-score remediation or inventing effectiveness', () => {
  const offer = buildTrainingRouteOffer('session-a', build);
  const decision: TrainingRouteDecision = { id: 'decision-a', revision: 1, selectedRoute: 'case-first', supportStatus: 'TASK_SUPPORTED', effectiveFromTurn: 1, createdAt: 1, offer };
  const evaluation: DeepEvaluation = { claim_clarity: 4, evidence_use: 4, reasoning_strength: 4, consistency: 4, relevance: 4, next_action: 'ask_reasoning', hint_level: 0, weakness_tags: [], diagnosis: '', claim: 'A policy claim', evidence_detected: ['source'], reasoning_gap: '' };
  expect(trainingRouteActionPreference(decision, 'ask_reasoning', evaluation, 'elicitation').initial).toBe('ask_evidence');
  expect(trainingRouteActionPreference({ ...decision, selectedRoute: 'proof-first' }, 'ask_evidence', evaluation, 'elicitation').initial).toBe('ask_reasoning');
  expect(trainingRouteActionPreference(decision, 'narrow_scope', { ...evaluation, relevance: 1 }, 'elicitation')).toEqual({ initial: 'narrow_scope', candidates: null });
  expect(trainingRouteActionPreference(decision, 'ask_revision', evaluation, 'revision')).toEqual({ initial: 'ask_revision', candidates: null });
  const unknown = { ...decision, supportStatus: 'UNKNOWN' as const };
  expect(trainingRouteActionPreference(unknown, 'ask_reasoning', evaluation, 'elicitation')).toEqual({ initial: 'ask_reasoning', candidates: null });
  expect(trainingRouteDirective(unknown)).toContain('use the ordinary tutor policy');
  expect(trainingRouteDirective(decision)).toContain('"efficacy":"UNKNOWN"');
 });
 it('keeps applicability unknown when no valid task evidence supports the order', () => {
  const offer = buildTrainingRouteOffer('session-a', { ...build, scenario: { ...build.scenario, evidenceSourceIds: ['foreign'], rubric: [] } });
  expect(offer.options.every(o => o.supportStatus === 'UNKNOWN')).toBe(true);
  expect(offer.options.every(o => o.evidenceRefs.length === 0)).toBe(true);
 });
});
