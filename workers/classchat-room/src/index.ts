// ============================================================
// SocraticAI v33 — ClassChat Room Durable Object Worker
// v33: WebSocket-based real-time ClassChat (NC-004 scaffolding)
// 
// Architecture: Durable Object with WebSocket Hibernation API
// Each ClassChat room = 1 DO instance with persistent WebSocket connections
// Broadcast pattern: All participants receive messages in real-time
// AI Facilitator: Conditionally injects pedagogical prompts
//
// NOTE: This is a scaffolding for future deployment.
// Requires Cloudflare Paid Plan with Durable Objects enabled.
// Deploy as a separate Worker project.
// ============================================================

export interface Env {
  CLASSCHAT_ROOM: DurableObjectNamespace;
  AI?: Ai;
  DB?: D1Database;
}

// ---- Durable Object: ClassChatRoomDO ----
export class ClassChatRoomDO implements DurableObject {
  private sessions: Map<WebSocket, { userId: string; role: string; username: string }> = new Map();
  private messageHistory: Array<{
    userId: string;
    content: string;
    da?: string;
    timestamp: number;
    type: 'message' | 'facilitator';
  }> = [];
  private messageCount = 0;
  private facilitatorThreshold = 5; // Trigger AI facilitator every N messages

  constructor(private state: DurableObjectState, private env: Env) {
    // Restore message history from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<typeof this.messageHistory>('messageHistory');
      if (stored) this.messageHistory = stored;
      const count = await this.state.storage.get<number>('messageCount');
      if (count) this.messageCount = count;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = url.searchParams.get('userId') || 'anonymous';
      const role = url.searchParams.get('role') || 'student';
      const username = url.searchParams.get('username') || userId.slice(0, 8);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Use WebSocket Hibernation API for efficient resource usage
      this.state.acceptWebSocket(server);
      
      // Store session metadata
      this.sessions.set(server, { userId, role, username });

      // Send message history to new joiner
      server.send(JSON.stringify({
        type: 'history',
        messages: this.messageHistory.slice(-50), // Last 50 messages
        participantCount: this.sessions.size,
      }));

      // Broadcast join event
      this.broadcast(JSON.stringify({
        type: 'system',
        content: `${username} 님이 입장했습니다.`,
        timestamp: Date.now(),
        participantCount: this.sessions.size,
      }), server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // REST API fallback: GET /messages
    if (url.pathname.endsWith('/messages') && request.method === 'GET') {
      return new Response(JSON.stringify({
        messages: this.messageHistory.slice(-100),
        participantCount: this.sessions.size,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // REST API: POST /message
    if (url.pathname.endsWith('/message') && request.method === 'POST') {
      const body = await request.json() as { content: string; userId: string };
      const message = {
        userId: body.userId || 'anonymous',
        content: body.content,
        timestamp: Date.now(),
        type: 'message' as const,
      };
      this.messageHistory.push(message);
      this.messageCount++;
      await this.persistHistory();
      this.broadcast(JSON.stringify({ type: 'message', ...message }));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('ClassChat Room DO — WebSocket upgrade required', { status: 400 });
  }

  // WebSocket Hibernation API callbacks
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);
      const session = this.sessions.get(ws);
      
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // Standard message
      const daResult = this.fastRuleTag(data.content || '');
      
      const broadcastMsg = {
        type: 'message',
        userId: session?.userId || data.userId || 'anonymous',
        username: session?.username || 'Unknown',
        content: data.content,
        da: daResult.act,
        daConfidence: daResult.confidence,
        timestamp: Date.now(),
      };

      // Store in history
      this.messageHistory.push({
        userId: broadcastMsg.userId,
        content: broadcastMsg.content,
        da: broadcastMsg.da,
        timestamp: broadcastMsg.timestamp,
        type: 'message',
      });
      this.messageCount++;
      await this.persistHistory();

      // Broadcast to all participants
      this.broadcast(JSON.stringify(broadcastMsg));

      // AI Facilitator (every N messages)
      if (this.messageCount % this.facilitatorThreshold === 0) {
        await this.triggerFacilitator();
      }
    } catch (err) {
      console.error('[ClassChatDO] Message processing error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Message processing failed' }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    
    if (session) {
      this.broadcast(JSON.stringify({
        type: 'system',
        content: `${session.username} 님이 퇴장했습니다.`,
        timestamp: Date.now(),
        participantCount: this.sessions.size,
      }));
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[ClassChatDO] WebSocket error:', error);
    this.sessions.delete(ws);
  }

  // ---- Internal helpers ----
  
  private broadcast(message: string, exclude?: WebSocket): void {
    for (const client of this.state.getWebSockets()) {
      if (client !== exclude) {
        try {
          client.send(message);
        } catch (e) {
          console.error('[ClassChatDO] Broadcast error:', e);
        }
      }
    }
  }

  private async persistHistory(): Promise<void> {
    // Keep only last 200 messages in storage
    if (this.messageHistory.length > 200) {
      this.messageHistory = this.messageHistory.slice(-200);
    }
    await this.state.storage.put('messageHistory', this.messageHistory);
    await this.state.storage.put('messageCount', this.messageCount);
  }

  // Lightweight DA classification (rule-based, <1ms)
  private fastRuleTag(text: string): { act: string; confidence: number } {
    const t = text.trim().toLowerCase();
    if (t.endsWith('?') || t.includes('왜') || t.includes('어떻게')) {
      return { act: 'clarification_request', confidence: 0.8 };
    }
    if (t.includes('하지만') || t.includes('그러나') || t.includes('반대로')) {
      return { act: 'rebuttal', confidence: 0.75 };
    }
    if (t.includes('예를 들') || t.includes('연구에 따르') || t.includes('데이터')) {
      return { act: 'evidence', confidence: 0.8 };
    }
    if (t.includes('동의') || t.includes('맞아') || t.includes('인정')) {
      return { act: 'concession', confidence: 0.7 };
    }
    if (t.includes('생각합니다') || t.includes('주장') || t.includes('이라고 봅니다')) {
      return { act: 'claim', confidence: 0.75 };
    }
    return { act: 'elaboration', confidence: 0.5 };
  }

  // AI Facilitator: generates pedagogical intervention
  private async triggerFacilitator(): Promise<void> {
    const recentMessages = this.messageHistory.slice(-10);
    const daCounts: Record<string, number> = {};
    recentMessages.forEach(m => {
      if (m.da) daCounts[m.da] = (daCounts[m.da] || 0) + 1;
    });

    // Determine facilitation strategy
    let facilMessage = '';
    const hasRebuttal = (daCounts['rebuttal'] || 0) > 0;
    const hasEvidence = (daCounts['evidence'] || 0) > 0;
    const hasClaim = (daCounts['claim'] || 0) > 0;

    if (!hasRebuttal) {
      facilMessage = '🤔 지금까지 좋은 논의가 이어지고 있습니다. 혹시 반대 입장에서도 생각해 보셨나요? 상대방의 주장에 대한 반론을 제시해 보세요.';
    } else if (!hasEvidence) {
      facilMessage = '📊 논의가 활발합니다! 주장을 뒷받침할 구체적인 근거나 사례를 추가해 보면 어떨까요?';
    } else if (hasClaim && hasRebuttal && hasEvidence) {
      facilMessage = '✨ 훌륭한 논증 구조입니다! 이제 상대방의 논거에서 가장 약한 부분을 찾아 비판적으로 분석해 보세요.';
    } else {
      facilMessage = '💡 다양한 관점에서 접근해 보세요. 아직 다뤄지지 않은 시각이 있을 수 있습니다.';
    }

    const facilMsg = {
      type: 'facilitator',
      content: facilMessage,
      timestamp: Date.now(),
      da_summary: daCounts,
      missingPerspectives: this.identifyMissingPerspectives(daCounts),
    };

    this.messageHistory.push({
      userId: 'facilitator',
      content: facilMessage,
      timestamp: Date.now(),
      type: 'facilitator',
    });
    await this.persistHistory();

    this.broadcast(JSON.stringify(facilMsg));
  }

  private identifyMissingPerspectives(daCounts: Record<string, number>): string[] {
    const missing: string[] = [];
    if (!daCounts['rebuttal']) missing.push('반론 제시');
    if (!daCounts['evidence']) missing.push('근거 제시');
    if (!daCounts['counterexample']) missing.push('반례 제시');
    if (!daCounts['clarification_request']) missing.push('질문/명확화 요청');
    return missing;
  }
}

// ---- Worker entry point ----
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/ws\/classchat\/(.+)/);
    
    if (match) {
      const roomId = match[1];
      const id = env.CLASSCHAT_ROOM.idFromName(roomId);
      const stub = env.CLASSCHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'classchat-room-do',
        version: '33.0.0',
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('ClassChat Room Worker v33', { status: 200 });
  },
};
