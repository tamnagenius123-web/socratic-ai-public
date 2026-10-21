// v13.0: WebSearchAggregator stub (original implementation removed as dead code)
// Kept as minimal stub because intelligent-hint.ts references it
// In production, integrate with a real search API if needed

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  relevanceScore: number;
}

export interface WebSearchOutput {
  queries: string[];
  results: SearchResult[];
  summary: string;
}

export class WebSearchAggregator {
  constructor(_soongsilApiKey: string, _geminiApiKey?: string) {}

  async generateSearchQueries(topic: string, _context: string, _weaknessArea?: string): Promise<string[]> {
    return [`${topic} 학술 논문`, `${topic} 실제 사례`];
  }

  async structureSearchResults(_rawData: string, _topic: string): Promise<{ results: SearchResult[]; summary: string }> {
    return { results: [], summary: '' };
  }

  async searchAndAggregate(topic: string, _context: string, _weaknessArea?: string): Promise<WebSearchOutput> {
    return { queries: [`${topic}`], results: [], summary: '' };
  }
}
