// SocraticAI v34 — In-Basket Case Study Engine
// Generates realistic business scenarios with financial data and personas
// Tracks data references in student responses

import { callAIJSONWithEnv, callAIWithEnv } from '../ai-client';
import { Persona, PERSONA_TEMPLATES, selectPersonaForWeakness, buildPersonaPrompt } from './persona-engine';

// =============================================
// Types
// =============================================

export interface CaseStudy {
  id: string;
  title: string;
  scenario: string;
  role: string;
  industry: string;
  financialData: FinancialData;
  personas: Persona[];
  expectedCompetencies: string[];
  dataPoints: DataPoint[];
  difficulty: number;
}

export interface FinancialData {
  revenue: { current: number; previous: number; unit: string };
  operatingProfit: { current: number; previous: number; unit: string };
  marketShare: { current: number; previous: number; unit: string };
  keyMetrics: { name: string; value: string; trend: 'up' | 'down' | 'stable' }[];
  summary: string;
}

export interface DataPoint {
  key: string;
  value: string;
  source: string;
  importance: number;  // 1~5
}

export interface DataReferenceResult {
  referenced: DataPoint[];
  missed: DataPoint[];
  referenceRate: number;
  importantMissed: DataPoint[];
}

export interface CaseStudyTurnResult {
  aiResponse: string;
  persona: Persona;
  dataReferences: DataReferenceResult;
  thinkingContent?: string;
}

// =============================================
// Financial Data Generator
// =============================================

function generateRealisticFinancialData(industry: string, difficulty: number): FinancialData {
  const industries: Record<string, { revenueBase: number; profitMargin: number }> = {
    '식품': { revenueBase: 5000, profitMargin: 0.08 },
    'IT': { revenueBase: 3000, profitMargin: 0.15 },
    '금융': { revenueBase: 10000, profitMargin: 0.12 },
    '제조': { revenueBase: 8000, profitMargin: 0.06 },
    '유통': { revenueBase: 15000, profitMargin: 0.04 },
    '헬스케어': { revenueBase: 4000, profitMargin: 0.10 },
  };

  const config = industries[industry] || industries['IT'];
  const declineRate = 0.10 + (difficulty * 0.05); // 10~25% decline
  const prevRevenue = config.revenueBase;
  const currentRevenue = Math.round(prevRevenue * (1 - declineRate));
  const prevProfit = Math.round(prevRevenue * config.profitMargin);
  const currentProfit = Math.round(currentRevenue * (config.profitMargin - 0.03));

  return {
    revenue: { current: currentRevenue, previous: prevRevenue, unit: '억원' },
    operatingProfit: { current: currentProfit, previous: prevProfit, unit: '억원' },
    marketShare: { current: 18.5 - (difficulty * 2), previous: 22.3, unit: '%' },
    keyMetrics: [
      { name: '고객 이탈률', value: `${(8 + difficulty * 3).toFixed(1)}%`, trend: 'up' },
      { name: '신규 고객 획득비용', value: `${(45 + difficulty * 10).toFixed(0)}만원`, trend: 'up' },
      { name: '직원 만족도', value: `${(72 - difficulty * 5).toFixed(0)}점`, trend: 'down' },
      { name: '브랜드 인지도', value: `${(65 - difficulty * 3).toFixed(0)}%`, trend: 'down' },
    ],
    summary: `매출 ${prevRevenue}억→${currentRevenue}억 (${(declineRate * 100).toFixed(0)}% 감소), 영업이익률 ${(config.profitMargin * 100).toFixed(1)}%→${((config.profitMargin - 0.03) * 100).toFixed(1)}%`,
  };
}

function extractKeyDataPoints(financialData: FinancialData): DataPoint[] {
  const points: DataPoint[] = [
    { key: '매출 감소율', value: `${(((financialData.revenue.previous - financialData.revenue.current) / financialData.revenue.previous) * 100).toFixed(1)}%`, source: '재무제표', importance: 5 },
    { key: '현재 매출', value: `${financialData.revenue.current}${financialData.revenue.unit}`, source: '재무제표', importance: 4 },
    { key: '영업이익', value: `${financialData.operatingProfit.current}${financialData.operatingProfit.unit}`, source: '재무제표', importance: 4 },
    { key: '시장점유율', value: `${financialData.marketShare.current}${financialData.marketShare.unit}`, source: '시장 보고서', importance: 3 },
  ];
  
  for (const metric of financialData.keyMetrics) {
    points.push({ key: metric.name, value: metric.value, source: '경영 분석', importance: 3 });
  }
  
  return points;
}

// =============================================
// Case Study Generator
// =============================================

const INDUSTRIES = ['식품', 'IT', '금융', '제조', '유통', '헬스케어'];

export async function generateCaseStudy(
  env: Record<string, any>,
  db: D1Database,
  params: {
    userId: string;
    preferredIndustry?: string;
    targetCompetency?: string;
    difficulty?: number;
  }
): Promise<CaseStudy> {
  // 1. Get user's weakest skills from BKT
  let weakestConcept = '근거 부족';
  try {
    const bktResult = await db.prepare(`
      SELECT concept, p_know FROM bkt_knowledge_states
      WHERE user_id = ?1 ORDER BY p_know ASC LIMIT 1
    `).bind(params.userId).first();
    if (bktResult) {
      weakestConcept = bktResult.concept as string;
    }
  } catch (e) {
    console.warn('[CASE_STUDY] BKT lookup failed, using default weakness:', e);
  }

  // 2. Select industry and difficulty
  const industry = params.preferredIndustry || INDUSTRIES[Math.floor(Math.random() * INDUSTRIES.length)];
  const difficulty = params.difficulty ?? Math.min(3, Math.max(1, Math.random() * 2 + 1));

  // 3. Generate financial data
  const financialData = generateRealisticFinancialData(industry, difficulty);
  const dataPoints = extractKeyDataPoints(financialData);

  // 4. Generate scenario with DeepSeek
  const scenarioPrompt = `당신은 비즈니스 케이스 스터디를 설계하는 전문가입니다.
다음 조건으로 현실적인 비즈니스 상황을 생성하세요:

- 산업: ${industry}
- 난이도: ${difficulty.toFixed(1)}/3.0
- 핵심 재무 데이터: ${financialData.summary}
- 학생이 연습할 역량: ${params.targetCompetency || weakestConcept}

JSON으로 응답하세요:
{
  "title": "케이스 스터디 제목 (한국어)",
  "scenario": "학생에게 제시할 상황 설명 (3~5문장, 한국어)",
  "role": "학생이 맡을 역할 (예: 마케팅 팀장)",
  "challenge": "핵심 도전 과제 (1문장)"
}`;

  let scenarioData: any;
  try {
    scenarioData = await callAIJSONWithEnv(env, scenarioPrompt, 
      `산업: ${industry}, 데이터: ${financialData.summary}`, 
      { preferFast: true, temperature: 0.8 });
  } catch (e) {
    // Fallback scenario
    scenarioData = {
      title: `${industry} 기업 위기 대응 전략`,
      scenario: `당신은 매출이 전년 대비 ${((financialData.revenue.previous - financialData.revenue.current) / financialData.revenue.previous * 100).toFixed(0)}% 하락한 ${industry} 회사의 전략기획팀장입니다. 경영진 회의에서 위기 대응 전략을 발표해야 합니다. 주어진 재무 데이터와 시장 분석을 기반으로 구체적인 전략을 제시하세요.`,
      role: '전략기획팀장',
      challenge: '제한된 예산으로 매출 회복과 시장점유율 방어를 동시에 달성해야 합니다.',
    };
  }

  // 5. Select personas based on weakness
  const primaryPersonaKey = selectPersonaForWeakness(weakestConcept);
  const personas: Persona[] = [
    { id: `persona_${primaryPersonaKey}`, ...PERSONA_TEMPLATES[primaryPersonaKey] },
    { id: 'persona_socrates', ...PERSONA_TEMPLATES.socrates },
  ];

  // 6. Build case study
  const caseStudy: CaseStudy = {
    id: `cs_${crypto.randomUUID()}`,
    title: scenarioData.title || `${industry} 케이스 스터디`,
    scenario: scenarioData.scenario || '',
    role: scenarioData.role || '팀장',
    industry,
    financialData,
    personas,
    expectedCompetencies: [weakestConcept, params.targetCompetency || '논리적 구조화'].filter(Boolean),
    dataPoints,
    difficulty,
  };

  // 7. Save to DB
  try {
    await db.prepare(`
      INSERT INTO case_studies (id, user_id, title, scenario_json, financial_data_json, personas_json, data_points_json, difficulty, industry, target_competencies, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11)
    `).bind(
      caseStudy.id, params.userId, caseStudy.title,
      JSON.stringify({ scenario: caseStudy.scenario, role: caseStudy.role }),
      JSON.stringify(caseStudy.financialData),
      JSON.stringify(caseStudy.personas),
      JSON.stringify(caseStudy.dataPoints),
      caseStudy.difficulty, caseStudy.industry,
      JSON.stringify(caseStudy.expectedCompetencies),
      Date.now()
    ).run();
  } catch (e) {
    console.error('[CASE_STUDY] DB save failed:', e);
  }

  return caseStudy;
}

// =============================================
// Data Reference Tracker
// =============================================

export function trackDataReference(
  studentMessage: string,
  dataPoints: DataPoint[],
): DataReferenceResult {
  const referenced: DataPoint[] = [];
  const missed: DataPoint[] = [];
  const msg = studentMessage.toLowerCase().replace(/\s+/g, '');

  for (const dp of dataPoints) {
    const valueNorm = dp.value.toLowerCase().replace(/\s+/g, '');
    const keyNorm = dp.key.toLowerCase().replace(/\s+/g, '');
    
    const isReferenced = 
      msg.includes(valueNorm) ||
      msg.includes(keyNorm) ||
      // Fuzzy: check if key numbers appear
      extractNumbers(dp.value).some(num => msg.includes(num));
    
    if (isReferenced) {
      referenced.push(dp);
    } else {
      missed.push(dp);
    }
  }

  return {
    referenced,
    missed,
    referenceRate: dataPoints.length > 0 ? referenced.length / dataPoints.length : 0,
    importantMissed: missed.filter(dp => dp.importance >= 4),
  };
}

function extractNumbers(s: string): string[] {
  const matches = s.match(/\d+\.?\d*/g);
  return matches || [];
}

// =============================================
// Case Study Turn Handler
// =============================================

export async function processCaseStudyTurn(
  env: Record<string, any>,
  caseStudy: CaseStudy,
  persona: Persona,
  studentMessage: string,
  conversationHistory: { role: string; content: string }[],
): Promise<CaseStudyTurnResult> {
  // 1. Track data references
  const dataReferences = trackDataReference(studentMessage, caseStudy.dataPoints);

  // 2. Build data context string
  const dataContext = caseStudy.dataPoints
    .map(dp => `- ${dp.key}: ${dp.value} (출처: ${dp.source})`)
    .join('\n');

  // 3. Build conversation history for context
  const historyStr = conversationHistory.slice(-6)
    .map(m => `${m.role === 'user' ? '학생' : persona.name}: ${m.content}`)
    .join('\n');

  // 4. Build persona prompt with data reference feedback
  let dataFeedback = '';
  if (dataReferences.importantMissed.length > 0) {
    dataFeedback = `\n[중요] 학생이 다음 핵심 데이터를 인용하지 않았습니다: ${dataReferences.importantMissed.map(dp => dp.key).join(', ')}. 이를 자연스럽게 언급하며 데이터 활용을 유도하세요.`;
  } else if (dataReferences.referenceRate > 0.5) {
    dataFeedback = `\n[참고] 학생이 데이터를 잘 활용하고 있습니다. 더 심층적인 분석을 요구하세요.`;
  }

  const fullPrompt = buildPersonaPrompt(persona, caseStudy.scenario, dataContext, studentMessage) + dataFeedback;

  // 5. Call AI with thinking mode for deeper reasoning
  const result = await callAIWithEnv(env, fullPrompt, 
    `${historyStr}\n\n학생: ${studentMessage}`, {
    temperature: 0.7,
    maxTokens: 1024,
    useThinking: false,  // Use fast mode for turn responses
    preferFast: true,
  });

  return {
    aiResponse: result.content,
    persona,
    dataReferences,
    thinkingContent: result.thinkingContent,
  };
}
