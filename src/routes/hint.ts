// Context-bound, ungraded Sparring help; persist the response before returning it.
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';
import { provideSparringHint } from '../services/sparring-hints';
import { GrowthServiceError } from '../services/growth-cycle-types';
import { LearningSessionContextError } from '../services/learning-session-context';
import { isAIInvocationReceiptPersistenceError } from '../services/ai-router';
const hintRoute = new Hono<{ Bindings: Bindings }>();
hintRoute.use('/api/hint',requireAuth);
hintRoute.post('/api/hint',async c=>{
  try{
    const body:unknown=await c.req.json();
    if(!body||typeof body!=='object'||Array.isArray(body))return c.json({code:'SPARRING_HINT_INPUT_INVALID'},400);
    const input=body as Record<string,unknown>;
    if(Object.keys(input).some(key=>!['sessionId','mutationKey','expectedTurn'].includes(key))||typeof input.sessionId!=='string'||!input.sessionId.trim()
      ||typeof input.mutationKey!=='string'||input.mutationKey.length<8||input.mutationKey.length>128||!Number.isSafeInteger(input.expectedTurn)||Number(input.expectedTurn)<1)return c.json({code:'SPARRING_HINT_INPUT_INVALID'},400);
    const owner=getAuthUser(c)?.userId;
    if(!owner)return c.json({code:'AUTHENTICATION_REQUIRED'},401);
    return c.json(await provideSparringHint(c.env,owner,input.sessionId,input.mutationKey,Number(input.expectedTurn)));
  }catch(error){
    if(error instanceof GrowthServiceError)return c.json({error:error.code==='SPARRING_SOURCE_UNAVAILABLE'?'이 도서의 근거를 더 이상 사용할 수 없습니다. 저장된 도움은 기록에서 확인하고, 다른 도서로 새 대화를 시작할 수 있습니다.':'도움 요청을 처리하지 못했습니다.',code:error.code,phase:error.phase,retryable:error.retryable,assessmentState:'UNGRADABLE'},error.status);
    if(error instanceof LearningSessionContextError)return c.json({error:'학습 맥락을 확인할 수 없습니다.',code:error.code==='CONTEXT_NOT_FOUND'?'SESSION_CONTEXT_REQUIRED':'SESSION_CONTEXT_INVALID',retryable:false,assessmentState:'UNGRADABLE'},error.code==='CONTEXT_NOT_FOUND'?409:503);
    if(isAIInvocationReceiptPersistenceError(error))return c.json({error:'도움 생성 기록을 저장하지 못했습니다.',code:'AI_INVOCATION_RECEIPT_REQUIRED',retryable:false,assessmentState:'UNGRADABLE'},503);
    if(error instanceof SyntaxError)return c.json({code:'SPARRING_HINT_INPUT_INVALID'},400);
    return c.json({error:'도움을 생성하거나 저장하지 못했습니다. 같은 요청으로 다시 시도해 주세요.',code:'SPARRING_HINT_UNAVAILABLE',retryable:true,assessmentState:'UNGRADABLE'},503);
  }
});
export default hintRoute;
