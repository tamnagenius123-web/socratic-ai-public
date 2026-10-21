import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectRecheckAssistance } from '../src/services/growth-recheck-assistance';

function stored(log: unknown) {
  const logJson = JSON.stringify(log);
  return { storedSourcePayload: { assistance: { capturePolicyRevision: 'training-assistance-capture-v1',
    coverage: 'LOCAL_RECORDED_ONLY', externalAssistance: 'UNKNOWN', deliveryValidation: 'UNKNOWN', protocolValidation: 'UNKNOWN',
    logJson, logSha256: createHash('sha256').update(logJson, 'utf8').digest('hex') } } };
}
const episode = (sessionId: string) => ({ sessionId, turns: [{ hint_level: 0 }], interventions: [] });

const sparringEpisode = (sessionId: string) => ({ kind: 'SPARRING_SESSION_TOTALS_V1', sessionId,
  contextId: `context-${sessionId}`, completedAt: 1000, openingManifestSha256: 'a'.repeat(64),
  acceptedTurns: 3, evaluatedTurns: 2, hintRequests: 1, hintLevelAtCompletion: 2,
  deliveredHints: 'NOT_RECORDED', controls: 'NOT_RECORDED' });
function sparringSignal(log: unknown) {
  const value = stored(log);
  value.storedSourcePayload.assistance.capturePolicyRevision = 'sparring-assistance-capture-v1';
  return JSON.stringify(value);
}

describe('private recheck assistance projection', () => {
  it('reads historical Sparring totals without inventing per-turn help or control records', async () => {
    const signal = sparringSignal({ baseline: sparringEpisode('before'), followUp: sparringEpisode('after') });
    expect(await projectRecheckAssistance(signal, 'before', 'after', 'SPARRING')).toMatchObject({
      status: 'RECORDED', kind: 'SPARRING_SESSION_TOTALS_V1',
      followUp: { acceptedTurns: 3, evaluatedTurns: 2, hintRequests: 1, hintLevelAtCompletion: 2,
        deliveredHints: 'NOT_RECORDED', controls: 'NOT_RECORDED' },
    });
    const result = JSON.stringify(await projectRecheckAssistance(signal, 'before', 'after', 'SPARRING'));
    expect(result).not.toContain('supportRecorded');
    expect(result).not.toContain('logJson');
    expect(await projectRecheckAssistance(signal, 'before', 'after', 'TRAINING')).toEqual({ status: 'UNAVAILABLE' });
  });
  it('refuses wrong-origin, damaged and malformed Sparring captures', async () => {
    const baseline = sparringEpisode('before'), followUp = sparringEpisode('after');
    for (const delta of [{acceptedTurns:null}, {hintRequests:-1}, {hintLevelAtCompletion:6},
      {kind:'FUTURE_RECORDS'}, {controls:0}, {contextId:''}, {sessionId:'foreign'}]) {
      expect(await projectRecheckAssistance(sparringSignal({baseline, followUp:{...followUp,...delta}}), 'before', 'after', 'SPARRING'))
        .toEqual({status:'UNAVAILABLE'});
    }
    const signal = JSON.parse(sparringSignal({baseline, followUp}));
    signal.storedSourcePayload.assistance.logJson += ' ';
    expect(await projectRecheckAssistance(JSON.stringify(signal), 'before', 'after', 'SPARRING')).toEqual({status:'UNAVAILABLE'});
    expect(await projectRecheckAssistance(JSON.stringify(stored({baseline:episode('before'),followUp:episode('after')})), 'before', 'after', 'SPARRING'))
      .toEqual({status:'UNAVAILABLE'});
  });
  it('distinguishes absent legacy capture from a known empty intervention list', async () => {
    expect(await projectRecheckAssistance(null, 'before', 'after')).toEqual({ status: 'NOT_RECORDED' });
    expect(await projectRecheckAssistance(JSON.stringify({ storedSourcePayload: { axes: {} } }), 'before', 'after')).toEqual({ status: 'NOT_RECORDED' });
    expect(await projectRecheckAssistance(JSON.stringify(stored({ baseline: episode('before'), followUp: episode('after') })), 'before', 'after'))
      .toMatchObject({ status: 'RECORDED', followUp: { supportRequested: 0, supportRecorded: 0 } });
  });
  it('withholds counts when retained bytes no longer match their digest', async () => {
    const signal = stored({ baseline: episode('before'), followUp: episode('after') });
    signal.storedSourcePayload.assistance.logJson += ' ';
    expect(await projectRecheckAssistance(JSON.stringify(signal), 'before', 'after')).toEqual({ status: 'UNAVAILABLE' });
  });
  it('refuses a valid capture for another attempt and unsupported capture policies', async () => {
    const signal = stored({ baseline: episode('before'), followUp: episode('foreign') });
    expect(await projectRecheckAssistance(JSON.stringify(signal), 'before', 'after')).toEqual({ status: 'UNAVAILABLE' });
    signal.storedSourcePayload.assistance.capturePolicyRevision = 'future-policy';
    expect(await projectRecheckAssistance(JSON.stringify(signal), 'before', 'foreign')).toEqual({ status: 'UNAVAILABLE' });
  });
  it('does not turn malformed or missing assistance fields into zero help', async () => {
    for (const signal of ['{', JSON.stringify(stored({ baseline: episode('before'), followUp: { sessionId: 'after', turns: [{ hint_level: null }] } }))]) {
      expect(await projectRecheckAssistance(signal, 'before', 'after')).toEqual({ status: 'UNAVAILABLE' });
    }
  });
  it('counts unresolved requests separately from saved explanations without returning private text', async () => {
    const signal = stored({ baseline: episode('before'), followUp: { sessionId: 'after',
      turns: [{ hint_level: 0 }, { hint_level: 2 }], interventions: [
        { action: 'HELP', response: null }, { action: 'PAUSE', response: null },
        { action: 'RESUME', response: null }, { action: 'HELP', response: 'PRIVATE SUPPORT TEXT' },
      ] } });
    const result = await projectRecheckAssistance(JSON.stringify(signal), 'before', 'after');
    expect(result).toMatchObject({ status: 'RECORDED', followUp: { acceptedTurns: 2, supportRequested: 2, supportRecorded: 1, pauses: 1, turnsWithHints: 1 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE SUPPORT TEXT');
    expect(JSON.stringify(result)).not.toContain('logJson');
  });
});
