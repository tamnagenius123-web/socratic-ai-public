/**
 * Knowledge Tracing (KT) Types
 * BKT (Bayesian Knowledge Tracing) and AKT (Attentive Knowledge Tracing) type definitions
 * Reference: Corbett & Anderson 1995, Ghosh et al. 2020
 */

export interface BKTParams {
  pL0: number; // Initial Learning probability (prior knowledge)
  pT: number; // Acquisition probability (transition from unlearned to learned)
  pG: number; // Guess probability (correct response given unlearned state)
  pS: number; // Slip probability (incorrect response given learned state)
}

export interface BKTState {
  skillId: string; // Unique skill identifier
  userId: string; // Unique user identifier
  pKnow: number; // Current probability of knowledge (p(L_n))
  n: number; // Number of opportunities observed
  lastUpdateAt: number; // Timestamp in milliseconds
}

export interface AKTState {
  userId: string;
  sequenceEmbedding: Float32Array; // Latent representation; stored as JSON in D1
  lastSkills: string[];
  lastResponses: boolean[];
  modelVersion: string;
}

export interface AKTPrediction {
  skillId: string;
  pCorrect: number;
  attentionMap: Array<{ pastTurn: number; weight: number }>;
}
