// SocraticAI v35 — Singularity Detector (T1.3.2)
// 더블 게이트: 마스터리 >= 0.65 AND 몰입 >= 0.70 AND 학년 >= 6
// 원문 근거: R3_dialectical_learning_evidence_deep.md AC-1

import { SingularityGateResult } from './types';

/**
 * 태극 엔진 활성화를 위한 더블 게이트 검사
 *
 * 모두 통과해야만 ready=true:
 * - mastery >= 0.65 (Sinha-Kapur 2021, PF 충실도 기준)
 * - engagement >= 0.70 (반례 수용 가능성 임계값)
 * - gradeLevel >= 6 (중학생 이상, 효과 역전 방지)
 *
 * @param mastery 학생 현재 마스터리 점수 (0~1)
 * @param engagement 학생 몰입도 점수 (0~1)
 * @param gradeLevel 학년 (1~12)
 * @returns { ready, reason? }
 */
export function checkSingularityGate(
  mastery: number,
  engagement: number,
  gradeLevel: number
): SingularityGateResult {
  // 조건 1: 학년 >= 6
  if (gradeLevel < 6) {
    return {
      ready: false,
      reason: `grade_below_6 (${gradeLevel})`,
    };
  }

  // 조건 2: 마스터리 >= 0.65
  if (mastery < 0.65) {
    return {
      ready: false,
      reason: `mastery_${mastery.toFixed(2)}_below_0.65`,
    };
  }

  // 조건 3: 몰입 >= 0.70
  if (engagement < 0.70) {
    return {
      ready: false,
      reason: `engagement_${engagement.toFixed(2)}_below_0.70`,
    };
  }

  // 모든 조건 통과
  return {
    ready: true,
  };
}

/**
 * 게이트 통과 여부를 boolean으로 반환 (편의함수)
 */
export function isSingularityReady(
  mastery: number,
  engagement: number,
  gradeLevel: number
): boolean {
  return checkSingularityGate(mastery, engagement, gradeLevel).ready;
}

/**
 * 게이트 상태 상세 정보 (디버깅/로깅용)
 */
export function getSingularityGateStatus(
  mastery: number,
  engagement: number,
  gradeLevel: number
): {
  gradeCheck: boolean;
  masteryCheck: boolean;
  engagementCheck: boolean;
  allPassed: boolean;
  failureReasons: string[];
} {
  const reasons: string[] = [];
  const gradeCheck = gradeLevel >= 6;
  const masteryCheck = mastery >= 0.65;
  const engagementCheck = engagement >= 0.70;

  if (!gradeCheck) reasons.push(`grade_${gradeLevel}_below_6`);
  if (!masteryCheck) reasons.push(`mastery_${mastery.toFixed(2)}_below_0.65`);
  if (!engagementCheck) reasons.push(`engagement_${engagement.toFixed(2)}_below_0.70`);

  return {
    gradeCheck,
    masteryCheck,
    engagementCheck,
    allPassed: gradeCheck && masteryCheck && engagementCheck,
    failureReasons: reasons,
  };
}
