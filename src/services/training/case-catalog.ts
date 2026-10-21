import type { BookData } from '../../data/books';
import { resolveTrainingCase } from './case-contracts/haneul-harbor-investment';

export type PublicTrainingCaseEntry = {
  caseId: string;
  caseVersion: string;
  locale: 'ko-KR';
  title: string;
  summary: string;
  category: 'business';
  difficulty: 'intermediate';
  mode: 'evidence';
  defaultMaxTurns: 8;
  sourceManifestVersion: string;
  sources: Array<{
    bookId: string;
    title: string;
    author: string;
    requiredLifecycleStatus: 'active';
    requiredVisibility: 'builtin';
    sourceVersion: string;
    reviewedExcerptVersion: string;
  }>;
};

type CatalogSource = {
  book: BookData;
  sourceVersion: string;
  reviewedExcerptVersion: string;
};

const HANEUL_HARBOR = resolveTrainingCase('HH-INVEST-100B');
if (!HANEUL_HARBOR) throw new Error('The authored Korean Training case catalog is incomplete.');

const SOURCE_MANIFEST_VERSION = 'HH-SYNTHETIC-SOURCES-1.0.0';
const REVIEWED_EXCERPT_VERSION = 'HH-SYNTHETIC-EXAMPLES-1.0.0';

// Newly authored synthetic examples for the public demo. They quote no issuer,
// filing, actual park or observed dataset, and are not evidence of real outcomes.
const CATALOG_SOURCES: readonly CatalogSource[] = Object.freeze([
  Object.freeze({
    sourceVersion: 'HH-SYNTHETIC-DEMAND-1.0.0',
    reviewedExcerptVersion: REVIEWED_EXCERPT_VERSION,
    book: Object.freeze({
      id: HANEUL_HARBOR.sourceIdentities[0].bookId,
      title: HANEUL_HARBOR.sourceIdentities[0].title,
      author: HANEUL_HARBOR.sourceIdentities[0].author,
      chapter: 'Synthetic examples · HH-SYNTHETIC-SOURCES-1.0.0',
      language: 'en',
      text: [
        '[Synthetic example 1: a fictional planning notebook]\n'
          + 'Imagine a park team discussing two untested ideas: a covered waiting area and a later opening time. One planner predicts that either idea could change attendance demand during a rainy season. Another asks whether visitors would simply move a visit from one day to another. Neither prediction is an observation. No visitor count, forecast, company report or survey is supplied in this example.\n\n',
        '[Synthetic example 2: designing a comparison]\n'
          + 'For a hypothetical pilot, the team could record the weather, waiting time, available operating capacity and operating cost on comparable days. The planner would decide the comparison and the measurement period before looking at results. A rise in entries during the pilot would still leave open explanations such as a holiday or a changed ticket offer. These are possible questions, not a report that a pilot happened or that an intervention worked.\n\n',
        '[Synthetic example 3: a reversible decision]\n'
          + 'A learner may propose a small test, request better demand and seasonality information, or explain why the evidence is insufficient to spend. The learner should say what would count against the proposal and when to revise it. This fictional notebook supplies no preferred strategy, investment allocation, causal conclusion or hidden answer. Its details must not be presented as facts about Haneul Harbor or any real operator.',
      ].join(''),
      keyPassages: [
        { verse: 'Synthetic example 1', text: 'A demand prediction is a hypothesis; no visitor observations are supplied.' },
        { verse: 'Synthetic example 2', text: 'Specify a comparison and possible alternative explanations before interpreting a hypothetical result.' },
      ],
    }),
  }),
  Object.freeze({
    sourceVersion: 'HH-SYNTHETIC-OPERATIONS-1.0.0',
    reviewedExcerptVersion: REVIEWED_EXCERPT_VERSION,
    book: Object.freeze({
      id: HANEUL_HARBOR.sourceIdentities[1].bookId,
      title: HANEUL_HARBOR.sourceIdentities[1].title,
      author: HANEUL_HARBOR.sourceIdentities[1].author,
      chapter: 'Synthetic examples · HH-SYNTHETIC-SOURCES-1.0.0',
      language: 'en',
      text: [
        '[Synthetic example: a fictional operations discussion]\n'
          + 'A made-up park team considers a temporary evening activity. A safety lead asks about staffing and maintenance. An accessibility lead asks whether the route can be used by visitors with different mobility needs. A finance lead asks which operating cost would rise even if attendance demand did not. These questions describe an invented conversation, not an actual inspection, incident, user record or compliance assessment.\n\n',
        '[Synthetic example: deciding what remains unknown]\n'
          + 'Before proposing expansion, a learner could identify a capacity limit, a safety guardrail, a measurement interval and a reason to stop or revise. Weather and seasonality might affect comparisons, but this example supplies no measured effects. The learner can defend several strategies or decline to recommend one until missing evidence is available. There is no company filing, guaranteed attendance outcome or canonical answer behind these fictional notes.',
      ].join(''),
      keyPassages: [
        { verse: 'Synthetic operations example', text: 'Invented discussion questions identify missing safety, maintenance and cost evidence; they do not establish measured effects.' },
      ],
    }),
  }),
]);

const PUBLIC_CASE_ENTRIES: readonly PublicTrainingCaseEntry[] = Object.freeze([
  Object.freeze({
    caseId: HANEUL_HARBOR.id,
    caseVersion: HANEUL_HARBOR.projection.caseVersion,
    locale: 'ko-KR',
    title: '하늘항 테마파크 1000억 원 투자 판단',
    summary: '새로 작성한 합성 예문을 바탕으로 가정과 미확인 정보를 구분하고, 가상 공원의 단계적 투자 판단을 연습합니다. 실제 기업 공시나 관측 데이터는 사용하지 않습니다.',
    category: 'business',
    difficulty: 'intermediate',
    mode: 'evidence',
    defaultMaxTurns: 8,
    sourceManifestVersion: SOURCE_MANIFEST_VERSION,
    sources: CATALOG_SOURCES.map((source) => Object.freeze({
      bookId: source.book.id,
      title: source.book.title,
      author: source.book.author,
      requiredLifecycleStatus: 'active' as const,
      requiredVisibility: 'builtin' as const,
      sourceVersion: source.sourceVersion,
      reviewedExcerptVersion: source.reviewedExcerptVersion,
    })),
  }),
]);

export function getBuiltinTrainingCaseSourceBooks(): BookData[] {
  return CATALOG_SOURCES.map((source) => source.book);
}

export function getPublicTrainingCaseEntries(): PublicTrainingCaseEntry[] {
  return PUBLIC_CASE_ENTRIES.map((entry) => ({
    ...entry,
    sources: entry.sources.map((source) => ({ ...source })),
  }));
}

export function getPublicTrainingCaseEntry(caseId: string): PublicTrainingCaseEntry | null {
  return getPublicTrainingCaseEntries().find((entry) => entry.caseId === caseId) || null;
}
