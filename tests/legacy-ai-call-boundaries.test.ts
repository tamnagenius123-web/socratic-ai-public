import { beforeEach, describe, expect, it, vi } from 'vitest';
const ai = vi.hoisted(() => ({ withEnv: vi.fn(), legacy: vi.fn() }));
vi.mock('../src/services/ai-client', () => ({ callAIJSONWithEnv: ai.withEnv, callAIJSON: ai.legacy }));
import { classifyDialogueActLLM, processArgumentMiningPipelineLLM } from '../src/services/argunet-da';
import { DEFAULT_CLASSCHAT_CONFIG, generateFacilitatorResponse } from '../src/services/classchat-engine';

describe('legacy AI call boundaries', () => {
  beforeEach(() => vi.resetAllMocks());
  it('passes the environment separately from the classifier prompts and preserves zero confidence', async () => {
    const env = { AI_PROVIDER: 'offline-test' };
    ai.withEnv.mockResolvedValue({ actType: 'evidence', confidence: 0, illocutionaryForce: 0 });
    const result = await classifyDialogueActLLM('연구 결과를 근거로 제시합니다.', [], 2, env);
    expect(ai.withEnv).toHaveBeenCalledWith(env, expect.stringContaining('Dialogue Act classifier'), expect.stringContaining('연구 결과'), { temperature: 0.3 });
    expect(result).toMatchObject({ actType: 'evidence', confidence: 0, illocutionaryForce: 0 });
    expect(ai.legacy).not.toHaveBeenCalled();
  });
  it('passes facilitator context through the environment wrapper and preserves a zero quality result', async () => {
    const env = { AI_PROVIDER: 'offline-test' };
    ai.withEnv.mockResolvedValue({ message: '다른 근거를 검토해 주세요.', suggestedRoleRotation: false, nextSpeaker: null, discussionQuality: 0, missingPerspectives: [], synthesisReady: false });
    const result = await generateFacilitatorResponse([], [], { ...DEFAULT_CLASSCHAT_CONFIG, topic: 'Test topic' }, env);
    expect(ai.withEnv).toHaveBeenCalledWith(env, expect.any(String), expect.stringContaining('Test topic'));
    expect(result.discussionQuality).toBe(0);
    expect(result.message).toBe('다른 근거를 검토해 주세요.');
    expect(ai.legacy).not.toHaveBeenCalled();
  });
  it('routes relation mining through the same environment after classifying the source utterances', async () => {
    const env = { AI_PROVIDER: 'offline-test' };
    ai.withEnv.mockResolvedValueOnce({ actType: 'claim', confidence: 0.8, illocutionaryForce: 0.7 })
      .mockResolvedValueOnce({ actType: 'evidence', confidence: 0.9, illocutionaryForce: 0.6 })
      .mockResolvedValueOnce([{ sourceId: 'arg_0_0', targetId: 'arg_1_0', type: 'support', strength: 0.7 }]);
    const result = await processArgumentMiningPipelineLLM(['A claim with enough text', 'Evidence with enough text'], undefined, env);
    expect(ai.withEnv).toHaveBeenLastCalledWith(env, 'Analyze argument relations. Return JSON array only.', expect.stringContaining('arg_1_0'), { temperature: 0.2 });
    expect(result.relations).toContainEqual({ sourceId: 'arg_0_0', targetId: 'arg_1_0', type: 'support', strength: 0.7 });
    expect(ai.legacy).not.toHaveBeenCalled();
  });
  it('retains the explicit facilitator outage response when the provider rejects', async () => {
    ai.withEnv.mockRejectedValue(new Error('offline outage'));
    const result = await generateFacilitatorResponse([], [], DEFAULT_CLASSCHAT_CONFIG, {});
    expect(result.message).toContain('일시적으로 중단');
    expect(result.synthesisReady).toBe(false);
  });
});
