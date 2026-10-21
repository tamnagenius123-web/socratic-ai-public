/**
 * SocraticAI Debate Arena Worker
 *
 * The Page Worker owns the canonical lifecycle reservation in D1. This
 * Durable Object owns one room's serialized logical turn and persists a
 * recoverable phase before attempting the D1 replica write.
 */

interface Env {
  DEBATE_ROOM: DurableObjectNamespace;
  DB: D1Database;
  SOONGSIL_API_KEY?: string;
  GEMINI_API_KEY?: string;
  // Required Worker secret. The Page Worker uses the same binding name.
  DEBATE_RUNTIME_SERVICE_TOKEN?: string;
}

const MAX_ROOM_ID_LENGTH = 256;
const MAX_PARTICIPANT_ID_LENGTH = 256;
const MAX_TURN_MUTATION_ID_LENGTH = 128;
const MAX_CONTENT_LENGTH = 12_000;
const TURN_MUTATION_KEY_PREFIX = 'turn-mutation:';
const AGENT_ROLES = ['critic', 'advocate', 'moderator'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isTurnMutationId(value: unknown): value is string {
  return isBoundedString(value, MAX_TURN_MUTATION_ID_LENGTH)
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function timingSafeTokenEqual(presented: string, expected: string): boolean {
  const presentedBytes = new TextEncoder().encode(presented);
  const expectedBytes = new TextEncoder().encode(expected);
  let mismatch = presentedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= (presentedBytes[index] ?? 0) ^ expectedBytes[index];
  }
  return mismatch === 0;
}

function hasRuntimeServiceAuthorization(request: Request, env: Env): boolean {
  const expected = env.DEBATE_RUNTIME_SERVICE_TOKEN;
  const authorization = request.headers.get('Authorization');
  if (!expected || !authorization?.startsWith('Bearer ')) return false;
  return timingSafeTokenEqual(authorization.slice('Bearer '.length), expected);
}

async function contentSha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function studentTurnIdFor(mutationId: string): string {
  return `debate-turn:${mutationId}:student`;
}

function agentTurnIdFor(mutationId: string, role: string): string {
  return `debate-turn:${mutationId}:agent:${role}`;
}

interface ParticipantInfo {
  id: string;
  role: 'student' | 'observer';
  displayName: string;
  joinedAt: number;
}

interface TrustedParticipant {
  id: string;
}

interface TurnData {
  turnNumber: number;
  participantId: string; // debate_participants.id, never the user id
  content: string;
  role: 'student';
  agentResponses: Record<string, string>;
  timestamp: number;
}

interface RuntimeTurnResult extends TurnData {
  ok: true;
  roomId: string;
  userId: string;
  turnMutationId: string;
  studentTurnId: string;
}

interface PendingTurnMutation {
  state: 'generation_pending' | 'd1_pending';
  roomId: string;
  userId: string;
  participantId: string;
  content: string;
  contentSha256: string;
  turnMutationId: string;
  turnNumber: number;
  // Inclusive end of the deterministic student + AI sequence reservation.
  lastTurnNumber: number;
  timestamp: number;
  logicalResult?: RuntimeTurnResult;
}

type StoredTurnMutation = RuntimeTurnResult | PendingTurnMutation;

interface RoomState {
  roomId: string;
  topic: string;
  status: 'open' | 'turn_pending' | 'closed' | 'archived';
  createdAt: number;
  lastActivity: number;
  currentTurn: number;
  turns: TurnData[];
}

interface ReplicaRow {
  id: string;
  participant_id: string;
  turn_number: number;
  content: string;
  role: string;
}

export class DebateRoomDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, ParticipantInfo> = new Map();
  // This only suppresses same-instance overlap; durable phase data remains the
  // crash/restart recovery source of truth.
  private activeMutationKeys: Set<string> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/websocket':
          return this.handleWebSocketUpgrade(request);
        case '/init':
          if (request.method === 'POST') return this.handleInit(request);
          break;
        case '/turn':
          if (request.method === 'POST') return this.handleTurn(request);
          break;
        case '/status':
          return this.handleStatus(request);
        case '/close':
          if (request.method === 'POST') return this.handleClose(request);
          break;
        default:
          return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
      }
    } catch (error) {
      console.error('[DO] Unhandled request failure:', error);
      return Response.json({ error: 'Debate runtime unavailable', code: 'DEBATE_RUNTIME_UNAVAILABLE' }, { status: 503 });
    }
    return Response.json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    const roomId = this.expectedRoomId(request);
    const url = new URL(request.url);
    const userId = url.searchParams.get('participantId');
    if (!roomId || !isBoundedString(userId, MAX_PARTICIPANT_ID_LENGTH)) {
      return Response.json({ error: 'Invalid room or participant identity', code: 'INVALID_PARTICIPANT' }, { status: 400 });
    }
    const participant = await this.findTrustedParticipant(roomId, userId);
    if (!participant) {
      return Response.json({ error: 'Trusted room membership is required', code: 'ROOM_MEMBERSHIP_REQUIRED' }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const displayName = url.searchParams.get('name') || 'Student';
    this.state.acceptWebSocket(server);
    this.sessions.set(server, { id: participant.id, role: 'student', displayName, joinedAt: Date.now() });
    server.send(JSON.stringify({ type: 'room_state', data: await this.getRoomState() }));
    this.broadcast({ type: 'participant_joined', data: { participantId: participant.id, displayName } }, server);
    await this.resetAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      if (parsed.type === 'turn') {
        // A WebSocket message cannot prove body/header idempotency equality.
        ws.send(JSON.stringify({
          type: 'error',
          code: 'REST_TURN_MUTATION_REQUIRED',
          message: 'Submit turns through the authenticated REST endpoint.',
        }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid message format' }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const participant = this.sessions.get(ws);
    if (!participant) return;
    this.sessions.delete(ws);
    this.broadcast({ type: 'participant_left', data: { participantId: participant.id, displayName: participant.displayName } });
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[DO] WebSocket error:', error);
    this.sessions.delete(ws);
  }

  private async handleInit(request: Request): Promise<Response> {
    const roomId = this.expectedRoomId(request);
    if (!roomId) return Response.json({ error: 'Invalid room identity', code: 'INVALID_ROOM_ID' }, { status: 400 });
    let body: unknown;
    try { body = await request.json(); } catch {
      return Response.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, { status: 400 });
    }
    if (!isPlainObject(body)
      || !isBoundedString(body.roomId, MAX_ROOM_ID_LENGTH)
      || body.roomId !== roomId
      || !isBoundedString(body.topic, 1_000)) {
      return Response.json({ error: 'Invalid room initialization body', code: 'INVALID_BODY' }, { status: 400 });
    }

    const initialized = await this.state.blockConcurrencyWhile(async () => {
      const existing = await this.getRoomState();
      if (existing) {
        if (existing.roomId === roomId && existing.status === 'open') return true;
        return false;
      }
      const now = Date.now();
      await this.state.storage.put('room', {
        roomId,
        topic: body.topic,
        status: 'open',
        createdAt: now,
        lastActivity: now,
        currentTurn: 0,
        turns: [],
      } satisfies RoomState);
      return true;
    });
    if (!initialized) {
      return Response.json({ error: 'Room is not available for initialization', code: 'ROOM_INITIALIZATION_CONFLICT' }, { status: 409 });
    }
    await this.resetAlarm();
    return Response.json({ ok: true, roomId });
  }

  private async handleTurn(request: Request): Promise<Response> {
    const roomId = this.expectedRoomId(request);
    if (!roomId) return Response.json({ error: 'Invalid room identity', code: 'INVALID_ROOM_ID' }, { status: 400 });
    let body: unknown;
    try { body = await request.json(); } catch {
      return Response.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, { status: 400 });
    }
    if (!isPlainObject(body)) return Response.json({ error: 'Request body must be an object', code: 'INVALID_BODY' }, { status: 400 });

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const userId = body.participantId;
    const turnMutationId = body.turnMutationId;
    if (!content || content.length > MAX_CONTENT_LENGTH
      || !isBoundedString(userId, MAX_PARTICIPANT_ID_LENGTH)
      || !isTurnMutationId(turnMutationId)
      || request.headers.get('X-Debate-Turn-Mutation-Id') !== turnMutationId
      || request.headers.get('Idempotency-Key') !== turnMutationId) {
      return Response.json({ error: 'Invalid turn mutation', code: 'INVALID_TURN_MUTATION' }, { status: 400 });
    }

    const participant = await this.findTrustedParticipant(roomId, userId);
    if (!participant) return Response.json({ error: 'Trusted room membership is required', code: 'ROOM_MEMBERSHIP_REQUIRED' }, { status: 403 });
    const hash = await contentSha256(content);
    const mutationKey = `${TURN_MUTATION_KEY_PREFIX}${turnMutationId}`;
    const existing = await this.state.storage.get<StoredTurnMutation>(mutationKey);
    if (existing) {
      if (!this.matchesMutation(existing, roomId, userId, participant.id, content, hash, turnMutationId)) {
        return Response.json({ error: 'Turn mutation id conflicts with a prior request', code: 'TURN_MUTATION_CONFLICT' }, { status: 409 });
      }
      return this.runMutation(mutationKey, existing);
    }

    const reservation = await this.state.blockConcurrencyWhile(async (): Promise<StoredTurnMutation | Response> => {
      // A duplicate may have arrived after the first storage read and before
      // this short state gate. Reuse it rather than create a second turn.
      const stored = await this.state.storage.get<StoredTurnMutation>(mutationKey);
      if (stored) {
        if (!this.matchesMutation(stored, roomId, userId, participant.id, content, hash, turnMutationId)) {
          return Response.json({ error: 'Turn mutation id conflicts with a prior request', code: 'TURN_MUTATION_CONFLICT' }, { status: 409 });
        }
        return stored;
      }
      const room = await this.getRoomState();
      if (!room || room.roomId !== roomId) return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 });
      if (room.status !== 'open') return Response.json({ error: 'Room is closed or unavailable', code: 'ROOM_NOT_OPEN' }, { status: 409 });

      const now = Date.now();
      const pending: PendingTurnMutation = {
        state: 'generation_pending',
        roomId,
        userId,
        participantId: participant.id,
        content,
        contentSha256: hash,
        turnMutationId,
        turnNumber: room.currentTurn + 1,
        lastTurnNumber: room.currentTurn + 1 + AGENT_ROLES.length,
        timestamp: now,
      };
      const reservedRoom: RoomState = {
        ...room,
        status: 'turn_pending',
        // Reserve the student and every deterministic AI response slot now,
        // so the following student turn cannot collide with an AI turn.
        currentTurn: pending.lastTurnNumber,
        lastActivity: now,
      };
      // Multi-key KV put is one durable storage operation. The phase and room
      // state become recoverable together before any external D1 mutation.
      await this.state.storage.put({ room: reservedRoom, [mutationKey]: pending });
      return pending;
    });
    if (reservation instanceof Response) return reservation;
    return this.runMutation(mutationKey, reservation);
  }

  private async runMutation(mutationKey: string, mutation: StoredTurnMutation): Promise<Response> {
    if ('ok' in mutation && mutation.ok === true) return Response.json(mutation);
    if (this.activeMutationKeys.has(mutationKey)) return this.unknownMutationResponse(mutation);
    this.activeMutationKeys.add(mutationKey);
    try {
      return await this.resumeMutation(mutationKey, mutation);
    } finally {
      this.activeMutationKeys.delete(mutationKey);
    }
  }

  private async resumeMutation(mutationKey: string, mutation: StoredTurnMutation): Promise<Response> {
    if ('ok' in mutation && mutation.ok === true) return Response.json(mutation);
    if (mutation.state === 'generation_pending') return this.generateLogicalTurn(mutationKey, mutation);
    if (!mutation.logicalResult) return this.unknownMutationResponse(mutation);

    const room = await this.getRoomState();
    if (!room || room.roomId !== mutation.roomId) return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 });
    if (room.status === 'closed') return Response.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 404 });
    if (room.status !== 'turn_pending' || room.currentTurn !== mutation.lastTurnNumber) {
      return this.unknownMutationResponse(mutation);
    }

    try {
      await this.persistAndVerifyD1Replica(mutation);
    } catch (error) {
      console.error('[DO] D1 turn replica unavailable:', error);
      return this.unknownMutationResponse(mutation);
    }

    const finalized = await this.state.blockConcurrencyWhile(async () => {
      // The close handler uses this same gate. A close that acquires it first
      // leaves a durable tombstone and this turn can no longer reopen it.
      const latest = await this.getRoomState();
      if (!latest || latest.roomId !== mutation.roomId
        || latest.status !== 'turn_pending' || latest.currentTurn !== mutation.lastTurnNumber) {
        return false;
      }
      const completedRoom: RoomState = { ...latest, status: 'open', lastActivity: Date.now() };
      // Do not store/replay a final success until all D1 turn rows have been
      // atomically persisted and subsequently verified.
      await this.state.storage.put({ room: completedRoom, [mutationKey]: mutation.logicalResult });
      return true;
    });
    if (!finalized) return this.unknownMutationResponse(mutation);
    try {
      await this.resetAlarm();
    } catch (error) {
      console.error('[DO] Final mutation storage unavailable:', error);
      return this.unknownMutationResponse(mutation);
    }
    this.broadcast({ type: 'new_turn', data: mutation.logicalResult });
    return Response.json(mutation.logicalResult);
  }

  private async generateLogicalTurn(mutationKey: string, mutation: PendingTurnMutation): Promise<Response> {
    const room = await this.getRoomState();
    if (!room || room.roomId !== mutation.roomId) return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 });
    if (room.status === 'closed') return Response.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 404 });
    if (room.status !== 'turn_pending' || room.currentTurn !== mutation.lastTurnNumber) return this.unknownMutationResponse(mutation);

    let agentResponses: Record<string, string>;
    try {
      agentResponses = await this.generateAgentResponses(room.topic, mutation.content, room.turns);
    } catch (error) {
      const providerUnavailable = error instanceof Error && error.message.startsWith('DEBATE_AI_PROVIDER_');
      return Response.json({
        error: providerUnavailable ? 'Debate AI provider is unavailable' : 'Debate runtime turn is unavailable',
        code: providerUnavailable ? error.message : 'DEBATE_RUNTIME_TURN_UNAVAILABLE',
        status: providerUnavailable ? 'unavailable' : 'UNKNOWN',
        roomId: mutation.roomId,
        turnMutationId: mutation.turnMutationId,
      }, { status: 503 });
    }

    if (AGENT_ROLES.some((role) => typeof agentResponses[role] !== 'string')
      || Object.keys(agentResponses).length !== AGENT_ROLES.length) {
      return this.unknownMutationResponse(mutation);
    }

    const logicalResult: RuntimeTurnResult = {
      ok: true,
      roomId: mutation.roomId,
      userId: mutation.userId,
      turnMutationId: mutation.turnMutationId,
      studentTurnId: studentTurnIdFor(mutation.turnMutationId),
      turnNumber: mutation.turnNumber,
      participantId: mutation.participantId,
      content: mutation.content,
      role: 'student',
      agentResponses,
      timestamp: mutation.timestamp,
    };
    const nextMutation: PendingTurnMutation = { ...mutation, state: 'd1_pending', logicalResult };
    try {
      const advanced = await this.state.blockConcurrencyWhile(async () => {
        const current = await this.getRoomState();
        if (!current || current.roomId !== mutation.roomId) return 'missing' as const;
        if (current.status === 'closed') return 'closed' as const;
        if (current.status !== 'turn_pending' || current.currentTurn !== mutation.lastTurnNumber) return 'unknown' as const;
        const nextRoom: RoomState = { ...current, turns: [...current.turns, logicalResult] };
        // The replayable logical result and the room turn are durable together
        // before D1 synchronization. Exact retries now resume sync, never a
        // second agent turn.
        await this.state.storage.put({ room: nextRoom, [mutationKey]: nextMutation });
        return 'advanced' as const;
      });
      if (advanced === 'missing') return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 });
      if (advanced === 'closed') return Response.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 404 });
      if (advanced !== 'advanced') return this.unknownMutationResponse(mutation);
    } catch (error) {
      console.error('[DO] Logical turn storage unavailable:', error);
      return this.unknownMutationResponse(mutation);
    }
    return this.resumeMutation(mutationKey, nextMutation);
  }

  private async handleStatus(request: Request): Promise<Response> {
    const roomId = this.expectedRoomId(request);
    if (!roomId) return Response.json({ error: 'Invalid room identity', code: 'INVALID_ROOM_ID' }, { status: 400 });
    const room = await this.getRoomState();
    if (!room || room.roomId !== roomId) return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND', roomId }, { status: 404 });
    return Response.json({
      ...room,
      connectedParticipants: Array.from(this.sessions.values()).map(({ id, displayName, joinedAt }) => ({ id, displayName, joinedAt })),
    });
  }

  private async handleClose(request: Request): Promise<Response> {
    const roomId = this.expectedRoomId(request);
    if (!roomId) return Response.json({ error: 'Invalid room identity', code: 'INVALID_ROOM_ID' }, { status: 400 });
    const closeState = await this.state.blockConcurrencyWhile(async (): Promise<RoomState | Response> => {
      const room = await this.getRoomState();
      if (room && room.roomId !== roomId) {
        return Response.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND', roomId }, { status: 404 });
      }
      // A close may race a delayed init. Persisting a closed tombstone makes
      // that later init fail instead of recreating an unusable room.
      const closedRoom: RoomState = room
        ? { ...room, status: 'closed', lastActivity: Date.now() }
        : { roomId, topic: '', status: 'closed', createdAt: Date.now(), lastActivity: Date.now(), currentTurn: 0, turns: [] };
      if (!room || room.status !== 'closed') await this.state.storage.put('room', closedRoom);
      return closedRoom;
    });
    if (closeState instanceof Response) return closeState;
    if (closeState.status === 'closed') {
      // The Page Worker has already made D1 canonical before invoking close.
      // This awaited mirror update can only report success after its own D1
      // write completes; it never reopens a room.
      await this.syncRoomStatusToD1(closeState);
    }
    for (const [ws] of this.sessions) ws.close(1000, 'Room closed');
    this.sessions.clear();
    return Response.json({ ok: true, roomId, status: 'closed' });
  }

  private async generateAgentResponses(topic: string, studentContent: string, turns: TurnData[]): Promise<Record<string, string>> {
    const apiKey = this.env.SOONGSIL_API_KEY || this.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('DEBATE_AI_PROVIDER_UNAVAILABLE');
    const history = turns.slice(-5).map((turn) => `[${turn.role}]: ${turn.content}`).join('\n');
    const isGemini = apiKey.startsWith('AIza');
    const roles = [
      { role: 'critic', prompt: `You are a critical debater. Challenge the student's argument and find weaknesses. Topic: ${topic}\n\nHistory:\n${history}\n\nStudent: ${studentContent}\n\nRespond as a thoughtful critic in Korean (2-3 sentences):` },
      { role: 'advocate', prompt: `You are a supportive debater. Strengthen or build upon the student's argument. Topic: ${topic}\n\nHistory:\n${history}\n\nStudent: ${studentContent}\n\nRespond as a supportive advocate in Korean (2-3 sentences):` },
      { role: 'moderator', prompt: `You are a neutral moderator. Summarize the key points and guide the discussion forward. Topic: ${topic}\n\nHistory:\n${history}\n\nStudent: ${studentContent}\n\nRespond as a balanced moderator in Korean (2-3 sentences):` },
    ];
    const responses = await Promise.allSettled(roles.map(async ({ role, prompt }) => {
      const reply = isGemini ? await this.callGeminiText(apiKey, prompt) : await this.callOpenAIText(apiKey, prompt);
      if (!reply.trim()) throw new Error('EMPTY_AI_REPLY');
      return { role, reply };
    }));
    if (responses.some((response) => response.status === 'rejected')) throw new Error('DEBATE_AI_PROVIDER_PARTIAL');
    return Object.fromEntries(responses.flatMap((response) => response.status === 'fulfilled' ? [[response.value.role, response.value.reply]] : []));
  }

  private async callOpenAIText(apiKey: string, prompt: string): Promise<string> {
    const response = await fetch('https://api.soongsil.ac.kr/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an AI debate participant. Respond concisely in Korean.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });
    if (!response.ok) throw new Error(`API_${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('EMPTY_AI_REPLY');
    return content;
  }

  private async callGeminiText(apiKey: string, prompt: string): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
        }),
      },
    );
    if (!response.ok) throw new Error(`GEMINI_${response.status}`);
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== 'string') throw new Error('EMPTY_AI_REPLY');
    return content;
  }

  private async persistAndVerifyD1Replica(mutation: PendingTurnMutation): Promise<void> {
    const result = mutation.logicalResult;
    if (!result) throw new Error('MISSING_LOGICAL_RESULT');
    const reservation = await this.env.DB.prepare(
      `SELECT mutation_id FROM debate_turn_mutations
        WHERE mutation_id = ?1 AND room_id = ?2 AND user_id = ?3 AND participant_id = ?4
          AND content_sha256 = ?5 AND status IN ('pending', 'unknown', 'complete')`
    ).bind(
      mutation.turnMutationId,
      mutation.roomId,
      mutation.userId,
      mutation.participantId,
      mutation.contentSha256,
    ).first<{ mutation_id: string }>();
    if (!reservation) throw new Error('D1_MUTATION_RESERVATION_MISSING');

    const expected: ReplicaRow[] = [
      {
        id: result.studentTurnId,
        participant_id: result.participantId,
        turn_number: result.turnNumber,
        content: result.content,
        role: 'student',
      },
      ...Object.entries(result.agentResponses).map(([role, content], offset): ReplicaRow => ({
        id: agentTurnIdFor(result.turnMutationId, role),
        participant_id: `${result.roomId}_ai_${role}`,
        turn_number: result.turnNumber + offset + 1,
        content,
        role,
      })),
    ];
    const highestPersistedNumber = Math.max(...expected.map((row) => row.turn_number));
    if (highestPersistedNumber !== mutation.lastTurnNumber) {
      throw new Error('D1_TURN_SEQUENCE_RESERVATION_MISMATCH');
    }

    await this.env.DB.batch(expected.map((row) => this.env.DB.prepare(
      `INSERT OR IGNORE INTO debate_turns (
         id, room_id, participant_id, turn_number, content, role, moderation_json, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      row.id,
      result.roomId,
      row.participant_id,
      row.turn_number,
      row.content,
      row.role,
      row.role === 'student' ? null : JSON.stringify({ source: 'ai-do', mutationId: result.turnMutationId }),
      result.timestamp,
    )));

    const placeholders = expected.map((_, index) => `?${index + 1}`).join(', ');
    const persisted = await this.env.DB.prepare(
      `SELECT id, participant_id, turn_number, content, role
         FROM debate_turns WHERE id IN (${placeholders})`
    ).bind(...expected.map((row) => row.id)).all<ReplicaRow>();
    if (persisted.results.length !== expected.length) throw new Error('D1_TURN_REPLICA_INCOMPLETE');
    const byId = new Map(persisted.results.map((row) => [row.id, row]));
    for (const row of expected) {
      const actual = byId.get(row.id);
      if (!actual
        || actual.participant_id !== row.participant_id
        || actual.turn_number !== row.turn_number
        || actual.content !== row.content
        || actual.role !== row.role) {
        throw new Error('D1_TURN_REPLICA_CONFLICT');
      }
    }
  }

  private async findTrustedParticipant(roomId: string, userId: string): Promise<TrustedParticipant | null> {
    return this.env.DB.prepare(
      `SELECT id FROM debate_participants
        WHERE room_id = ?1 AND user_id = ?2 AND participant_type = 'human' AND left_at IS NULL
        LIMIT 1`
    ).bind(roomId, userId).first<TrustedParticipant>();
  }

  private matchesMutation(
    mutation: StoredTurnMutation,
    roomId: string,
    userId: string,
    participantId: string,
    content: string,
    hash: string,
    turnMutationId: string,
  ): boolean {
    return mutation.roomId === roomId
      && mutation.userId === userId
      && mutation.participantId === participantId
      && mutation.content === content
      && mutation.turnMutationId === turnMutationId
      && ('ok' in mutation || mutation.contentSha256 === hash);
  }

  private unknownMutationResponse(mutation: PendingTurnMutation): Response {
    return Response.json({
      error: 'Debate runtime turn state is uncertain',
      status: 'UNKNOWN',
      code: 'DEBATE_RUNTIME_TURN_UNCERTAIN',
      roomId: mutation.roomId,
      turnMutationId: mutation.turnMutationId,
    }, { status: 503 });
  }

  private expectedRoomId(request: Request): string | null {
    const roomId = request.headers.get('X-Debate-Room-Id');
    return isBoundedString(roomId, MAX_ROOM_ID_LENGTH) ? roomId : null;
  }

  private async getRoomState(): Promise<RoomState | null> {
    return await this.state.storage.get<RoomState>('room') || null;
  }

  private async resetAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
  }

  private async syncRoomStatusToD1(room: RoomState): Promise<void> {
    await this.env.DB.prepare('UPDATE debate_rooms SET status = ?2 WHERE id = ?1')
      .bind(room.roomId, room.status).run();
  }

  async alarm(): Promise<void> {
    const room = await this.getRoomState();
    if (!room) return;
    if (Date.now() - room.lastActivity > 30 * 60 * 1000) {
      const closedRoom: RoomState = { ...room, status: 'closed', lastActivity: Date.now() };
      await this.state.storage.put('room', closedRoom);
      await this.syncRoomStatusToD1(closedRoom);
      for (const [ws] of this.sessions) ws.close(1000, 'Room closed due to inactivity');
      this.sessions.clear();
      return;
    }
    await this.resetAlarm();
  }

  private broadcast(message: Record<string, unknown>, exclude?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try { ws.send(payload); } catch { /* closed socket */ }
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^\/]+)(\/.*)?$/);
    if (!match) {
      const tokenConfigured = Boolean(env.DEBATE_RUNTIME_SERVICE_TOKEN?.trim());
      if (!tokenConfigured) {
        return Response.json({
          service: 'socratic-debate-arena',
          version: '28.0.0',
          status: 'degraded',
          checks: {
            runtimeServiceToken: 'missing',
            provider: 'unverified',
            d1: 'unverified',
          },
        }, { status: 503 });
      }
      if (!hasRuntimeServiceAuthorization(request, env)) {
        return Response.json({ error: 'Runtime service authentication is required', code: 'DEBATE_RUNTIME_SERVICE_AUTH_REQUIRED' }, { status: 401 });
      }
      const providerConfigured = Boolean(env.SOONGSIL_API_KEY || env.GEMINI_API_KEY);
      let d1Ready = false;
      try {
        const probe = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        d1Ready = probe?.ok === 1;
      } catch (error) {
        console.error('[DEBATE_RUNTIME_HEALTH_D1]', error);
      }
      const ready = providerConfigured && d1Ready;
      return Response.json({
        service: 'socratic-debate-arena',
        version: '28.0.0',
        status: ready ? 'ok' : 'degraded',
        checks: {
          runtimeServiceToken: 'configured',
          provider: providerConfigured ? 'configured' : 'missing',
          d1: d1Ready ? 'ready' : 'unavailable',
        },
      }, { status: ready ? 200 : 503 });
    }

    const roomId = match[1];
    const subPath = match[2] || '/status';
    if (!isBoundedString(roomId, MAX_ROOM_ID_LENGTH)) {
      return Response.json({ error: 'Invalid room identity', code: 'INVALID_ROOM_ID' }, { status: 400 });
    }
    if (!hasRuntimeServiceAuthorization(request, env)) {
      return Response.json({ error: 'Runtime service authentication is required', code: 'DEBATE_RUNTIME_SERVICE_AUTH_REQUIRED' }, { status: 401 });
    }

    const id = env.DEBATE_ROOM.idFromName(roomId);
    const stub = env.DEBATE_ROOM.get(id);
    const doUrl = new URL(request.url);
    doUrl.pathname = subPath;
    const headers = new Headers(request.headers);
    headers.set('X-Debate-Room-Id', roomId);
    return stub.fetch(new Request(doUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
    }));
  },
};
