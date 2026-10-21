// ============================================================
// v32: ClassChat Peer Learning Engine
// ============================================================
// DeepSkill Fidelity Target: +10% (ClassChat mirror)
// Reference: Park et al. (2024) "ClassChat: Multi-student
//   Collaborative Learning with Shared AI Agent"
//
// Features:
//   - Peer-to-peer argumentation with AI facilitation
//   - Real-time DA classification for each participant
//   - Collective argument graph construction
//   - Role rotation (Devil's advocate, Summarizer, Questioner)
// ============================================================

import { callAIJSONWithEnv } from './ai-client';
import type { DialogueActClassification } from '../types/d1-rows';

export interface ClassChatConfig {
  maxParticipants: number;
  facilitatorMode: 'ai_guided' | 'peer_led' | 'hybrid';
  rotationInterval: number; // turns before role rotation
  topic: string;
  difficultyLevel: 'beginner' | 'intermediate' | 'advanced';
}

export interface ClassChatParticipant {
  userId: string;
  username: string;
  currentRole: 'advocate' | 'critic' | 'questioner' | 'summarizer' | 'observer';
  turnCount: number;
  daDistribution: Record<string, number>;
  contributionScore: number;
}

export interface ClassChatTurn {
  participantId: string;
  role: string;
  content: string;
  daClassification: string;
  arcRelation: string | null;
  timestamp: number;
}

export interface ClassChatFacilitatorResponse {
  message: string;
  suggestedRoleRotation: boolean;
  nextSpeaker: string | null;
  discussionQuality: number;
  missingPerspectives: string[];
  synthesisReady: boolean;
}

// Default config
export const DEFAULT_CLASSCHAT_CONFIG: ClassChatConfig = {
  maxParticipants: 6,
  facilitatorMode: 'ai_guided',
  rotationInterval: 3,
  topic: '',
  difficultyLevel: 'intermediate',
};

// =============================================
// AI Facilitator: Guides peer discussion
// =============================================

export async function generateFacilitatorResponse(
  turns: ClassChatTurn[],
  participants: ClassChatParticipant[],
  config: ClassChatConfig,
  env?: Record<string, unknown>
): Promise<ClassChatFacilitatorResponse> {
  if (!env) {
    return {
      message: '토론을 계속 진행해 주세요.',
      suggestedRoleRotation: false,
      nextSpeaker: null,
      discussionQuality: 0.5,
      missingPerspectives: [],
      synthesisReady: false,
    };
  }

  try {
    const recentTurns = turns.slice(-6).map(t => `[${t.role}] ${t.content}`).join('\n');
    const participantSummary = participants.map(p =>
      `${p.username} (${p.currentRole}): ${p.turnCount}턴, 기여도 ${(p.contributionScore * 100).toFixed(0)}%`
    ).join('\n');

    const prompt = `ClassChat AI 퍼실리테이터로서 다음 상황을 분석하고 토론을 안내하세요.

주제: ${config.topic}
난이도: ${config.difficultyLevel}
참가자 현황:
${participantSummary}

최근 발언:
${recentTurns}

다음 JSON 형식으로 응답하세요:
{
  "message": "퍼실리테이터 메시지 (한국어, 토론 방향 제시)",
  "suggestedRoleRotation": true/false,
  "nextSpeaker": "다음 발언자 userId 또는 null",
  "discussionQuality": 0.0~1.0,
  "missingPerspectives": ["누락된 관점 목록"],
  "synthesisReady": true/false
}`;

    const result = await callAIJSONWithEnv<ClassChatFacilitatorResponse>(env, 'Facilitate the peer discussion. Respond with the requested JSON object.', prompt);
    return {
      message: result?.message || '토론을 계속 진행해 주세요.',
      suggestedRoleRotation: result?.suggestedRoleRotation || false,
      nextSpeaker: result?.nextSpeaker || null,
      discussionQuality: result?.discussionQuality ?? 0.5,
      missingPerspectives: result?.missingPerspectives || [],
      synthesisReady: result?.synthesisReady || false,
    };
  } catch (e) {
    console.error('[ClassChat] Facilitator response error:', e);
    return {
      message: '토론을 계속 진행해 주세요. AI 분석이 일시적으로 중단되었습니다.',
      suggestedRoleRotation: false,
      nextSpeaker: null,
      discussionQuality: 0.5,
      missingPerspectives: [],
      synthesisReady: false,
    };
  }
}

// =============================================
// Role assignment and rotation
// =============================================

export function assignInitialRoles(participantIds: string[]): Map<string, string> {
  const roles = ['advocate', 'critic', 'questioner', 'summarizer', 'observer'];
  const assignment = new Map<string, string>();
  participantIds.forEach((id, i) => {
    assignment.set(id, roles[i % roles.length]);
  });
  return assignment;
}

export function rotateRoles(participants: ClassChatParticipant[]): ClassChatParticipant[] {
  const roles = participants.map(p => p.currentRole);
  // Rotate: each person gets the role of the next person
  return participants.map((p, i) => ({
    ...p,
    currentRole: roles[(i + 1) % roles.length] as ClassChatParticipant['currentRole'],
  }));
}

// =============================================
// Contribution scoring
// =============================================

export function calculateContributionScore(
  participant: ClassChatParticipant,
  totalTurns: number,
  daDistribution: Record<string, number>
): number {
  if (totalTurns === 0) return 0;

  // Participation rate (0-0.3)
  const participationRate = Math.min(participant.turnCount / Math.max(1, totalTurns / participant.turnCount), 1) * 0.3;

  // DA diversity (0-0.3) — more diverse dialogue acts = higher score
  const daTypes = Object.keys(daDistribution).filter(k => daDistribution[k] > 0).length;
  const daDiversity = Math.min(daTypes / 5, 1) * 0.3;

  // Role fulfillment (0-0.4) — did they play their role?
  const roleDA: Record<string, string[]> = {
    advocate: ['claim', 'evidence'],
    critic: ['rebuttal', 'challenge', 'counter_claim'],
    questioner: ['question', 'clarification'],
    summarizer: ['concession', 'clarification'],
    observer: ['question'],
  };
  const expectedDAs = roleDA[participant.currentRole] || [];
  const roleHits = expectedDAs.filter(da => (daDistribution[da] || 0) > 0).length;
  const roleFulfillment = expectedDAs.length > 0 ? (roleHits / expectedDAs.length) * 0.4 : 0.2;

  return Math.min(1, participationRate + daDiversity + roleFulfillment);
}
