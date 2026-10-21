import { describe, expect, it } from 'vitest';
import { createStudentModel, updateStudentModel } from '../src/services/tutoring/student-model-engine';
import type { DeepEvaluation } from '../src/services/tutoring/types';
import { calculateEffectiveHintLevel } from '../src/services/tutoring/hint-ladder';
import { determineChallengeLevel, createDefaultChallengeState } from '../src/services/tutoring/challenge-engine';
import { nextState } from '../src/services/tutoring/state-machine';
const evaluation: DeepEvaluation = { claim_clarity: 4, evidence_use: 3, reasoning_strength: 3, consistency: 4, relevance: 4, next_action: 'ask_reasoning', hint_level: 0, weakness_tags: [], diagnosis: 'Needs a warrant', claim: 'A paraphrase of the same claim', evidence_detected: [], reasoning_gap: 'Warrant' };
describe('declared learner revision, not evaluator wording drift', () => {
 it('does not withdraw support from a prior tutor request without a current explicit correction', () => {
  const model={...createStudentModel('session','Policy'),helpLevel:3 as const,lastTutorAction:'ask_revision' as const};
  expect(updateStudentModel(model,evaluation,'ask_reasoning').helpLevel).toBe(3);
  expect(updateStudentModel(model,evaluation,'ask_reasoning',{reviewingLearnerRevision:true}).helpLevel).toBe(2);
 });
 it('does not unlock scaffolding from an unverified legacy counter', () => {
  const model={...createStudentModel('session','Policy'),helpLevel:5 as const,revisionCount:99};
  expect(calculateEffectiveHintLevel(model,3)).toBe(3);
 });
 it('uses accepted attempts only to pace scaffolding without weakening early-turn limits', () => {
  const model={...createStudentModel('session','Policy'),helpLevel:5 as const};
  expect(calculateEffectiveHintLevel(model,3,1)).toBe(4);
  expect(calculateEffectiveHintLevel(model,3,2)).toBe(5);
  expect(calculateEffectiveHintLevel(model,2,2)).toBe(2);
  expect(calculateEffectiveHintLevel(model,3,null)).toBe(3);
 });
 it('does not award a difficulty bonus from a legacy count and AI growth claim', () => {
  const observed={...evaluation,claim_clarity:3,evidence_use:3,reasoning_strength:3,consistency:3,relevance:3,student_growth_since_last_turn:'significant' as const};
  expect(determineChallengeLevel(createDefaultChallengeState(),observed,3,{revisionCount:99,helpLevel:0}).currentLevel).toBe(1);
 });
 it('does not bypass missing claim and evidence criteria because of a legacy count', () => {
  expect(nextState({currentState:'revision',scores:{claim_clarity:2,evidence_use:2,reasoning_strength:3,consistency:3,relevance:3},repeatedWeaknessCounts:{},revisionCount:99,turnNumber:4,maxTurns:10})).toBe('revision');
 });
 it('does not count an evaluator paraphrase as a learner revision attempt', () => {
  const model = createStudentModel('session', 'Policy', 'Justify a claim');
  model.currentClaim = 'Original phrasing';
  expect(updateStudentModel(model, evaluation, 'ask_reasoning').revisionCount).toBe(0);
 });
});
