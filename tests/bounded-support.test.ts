import { describe,expect,it } from 'vitest';
import { runCriticAgent } from '../src/services/math/critic-agent';
import type { AIRouter, AIRouteRequest, AIJSONValidator } from '../src/services/ai-router';
describe('bounded support retains independent release checks',()=>{
 async function review(response:string,overrides:Record<string,unknown>={}) {
  const router={async completeValidatedJSON<T>(_lane:string,_request:AIRouteRequest,validate:AIJSONValidator<T>) {
   const value=validate({leakageScore:0,bloomLevel:'create',bloomCompliant:true,passed:true,issues:[],suggestions:[],reasoning:'Fixture review',engagementScore:60,quotesStudentWords:true,isGenericQuestion:false,intellectualTension:0,diversityFromPrevious:50,...overrides});
   if(!value)throw new Error('Invalid fixture');
   return {value,metadata:{lane:'release_critic',provider:'deepseek',model:'offline-fixture',fallback:false,attemptCount:1,latencyMs:0}};
  }} as AIRouter;
  return (await runCriticAgent(router,response,{currentState:'revision',topic:'Policy',studentMessage:'All policies are universal',selectedAction:'give_hint',hintLevel:3,boundedSupport:{sourceIds:['source-a']},learningOrderDirective:'Source-a: the mechanism depends on conditions.'})).verdict;
 }
 it('permits one grounded explanation with reconstruction without requiring pressure',async()=>{
  expect((await review('The mechanism depends on the condition [SOURCE_ID=source-a]. How would you reconstruct your rule?')).passed).toBe(true);
 });
 it('still withholds answer substitution, unsupported citations, lower depth and missing reconstruction',async()=>{
  expect((await review('This is the whole answer [SOURCE_ID=source-a]. Agree?',{leakageScore:90})).passed).toBe(false);
  expect((await review('A correction [SOURCE_ID=forged]. Reconstruct it?')).passed).toBe(false);
  expect((await review('A correction. Reconstruct it?')).passed).toBe(false);
  expect((await review('A correction [SOURCE_ID=source-a]. Recall it?',{bloomLevel:'remember'})).passed).toBe(false);
  expect((await review('A correction [SOURCE_ID=source-a].')).passed).toBe(false);
 });
});
