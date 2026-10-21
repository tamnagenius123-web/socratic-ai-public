// AI API Client for Cloudflare Workers
// V2: Migrated from Gemini-only to GPT-5 Nano via Soongsil Gateway
// Uses OpenAI-compatible API with Gemini fallback

import { callAI, callAIJSON } from './ai-client';

// Re-export the new AI functions for backward compatibility
export { callAI, callAIJSON };

// Legacy function signatures maintained for existing code
export async function callGemini(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  _schema?: object,
  temperature: number = 0.7,
  soongsilApiKey?: string,
): Promise<string> {
  // Use Soongsil API as primary if available, otherwise fallback to Gemini
  const primaryKey = soongsilApiKey || apiKey;
  const fallbackKey = soongsilApiKey ? apiKey : undefined;

  const result = await callAI(primaryKey, fallbackKey, systemPrompt, userMessage, {
    temperature,
    maxTokens: 4096,
    jsonMode: !!_schema,
  });

  return result.content;
}

export async function callGeminiJSON<T>(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  _schema?: object,
  temperature: number = 0.7,
  soongsilApiKey?: string,
): Promise<T> {
  const primaryKey = soongsilApiKey || apiKey;
  const fallbackKey = soongsilApiKey ? apiKey : undefined;

  return callAIJSON<T>(primaryKey, fallbackKey, systemPrompt, userMessage, {
    temperature,
    maxTokens: 4096,
  });
}
