// Analytics Queue Worker (Background Consumer)
// Architecture Task 2: Cloudflare Queues consumer for deep analytics
//
// This worker receives messages from the 'socratic-analytics-queue'
// and runs heavy 18-axis analysis in a background context.
// 
// Deployment: This is a separate Worker that handles queue messages.
// It shares the same D1 binding but runs independently.
//
// NOTE: For Cloudflare Pages, queue consumers are not natively supported.
// This file serves as the architectural blueprint for when the project
// migrates to a full Workers setup. Currently, ctx.waitUntil() is used
// as the fallback execution path (see chat.ts).

import { runDeepAnalytics, type AnalyticsQueueMessage } from '../services/deep-analytics';

export interface Env {
  DB: D1Database;
  SOONGSIL_API_KEY: string;
  GEMINI_API_KEY: string;
  ANALYTICS_QUEUE: Queue; // Dead-letter or retry queue
}

export default {
  async queue(batch: MessageBatch<AnalyticsQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const data = message.body;
      
      try {
        console.log(`[ANALYTICS_WORKER] Processing session: ${data.sessionId}`);
        
        const apiKey = env.SOONGSIL_API_KEY || env.GEMINI_API_KEY;
        const fallbackKey = env.SOONGSIL_API_KEY ? env.GEMINI_API_KEY : undefined;

        await runDeepAnalytics(
          env.DB,
          data.sessionId,
          data.conversationHistory.map(m => ({
            role: m.role as 'user' | 'ai',
            content: m.content,
            turn: m.turn,
            timestamp: 0,
          })),
          {
            topic: data.topic,
            bookTitle: data.bookTitle,
            coreClaim: data.coreClaim,
            currentClaim: data.currentClaim,
            radarScores: data.radarScores,
            avgLogic: data.avgLogic,
            totalEvidenceCited: data.totalEvidenceCited,
            weaknessPattern: data.weaknessPattern,
          },
          apiKey,
          fallbackKey,
        );

        // Acknowledge message
        message.ack();
        console.log(`[ANALYTICS_WORKER] Completed session: ${data.sessionId}`);
      } catch (error) {
        console.error(`[ANALYTICS_WORKER] Failed session: ${data.sessionId}`, error);
        // Retry up to 3 times, then dead-letter
        message.retry();
      }
    }
  },
};
