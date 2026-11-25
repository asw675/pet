import { describe, expect, it } from 'vitest';
import { aiIntentSchema, aiRequestSchema, aiResultSchema, aiResultMatches, credentialSaveSchema, credentialLookupSchema } from '../src/shared/ai-ipc';
import type { AiRequest, AiResult } from '../src/shared/ai-ipc';

const identity = { petId: 'pet-1', conversationId: 'conv-1', requestId: 'turn-1' };
const send = { requestId: 'transport-1', intent: { method: 'chat/start', payload: { ...identity, trigger: 'USER', userText: '今天怎么样？' } } } satisfies AiRequest;
const result = { requestId: send.requestId, ok: true, method: 'chat/start', data: identity } satisfies AiResult;
describe('closed control-center AI methods', () => {
  it('accepts exact user turn and distinguishes turn vs transport correlation', () => {
    expect(aiRequestSchema.parse(send)).toEqual(send);
    expect(aiResultSchema.parse(result)).toEqual(result);
    expect(aiResultMatches(send,result)).toBe(true);
    expect(aiResultMatches(send,{...result,requestId:'other'})).toBe(false);
    expect(aiResultMatches(send,{...result,data:{...identity,requestId:'other'}})).toBe(false);
    expect(aiResultMatches(send,{...result,data:{...identity,petId:'other'}})).toBe(false);
  });
  it('allows only explicit user chat, not caller context, arbitrary provider or actions', () => {
    for(const extra of [{trigger:'PROACTIVE'},{providerId:'remote'},{persona:{name:'other'}},{apiKey:'fake'},
      {action:{type:'run',command:'something'}},{deadline:123},{userText:' '.repeat(5)}]) expect(aiRequestSchema.safeParse({...send,intent:{...send.intent,payload:{...send.intent.payload,...extra}}}).success).toBe(false);
    expect(aiIntentSchema.safeParse({method:'execute',payload:{}}).success).toBe(false);
  });
  it('strictly checks conversation page scope and cross-method results', () => {
    const request={requestId:'page-1',intent:{method:'messages/list',payload:{petId:'pet-1',conversationId:'conv-1',offset:0,limit:20}}} satisfies AiRequest;
    const response={requestId:'page-1',ok:true,method:'messages/list',data:{petId:'pet-1',conversationId:'conv-1',offset:0,limit:20,rows:[{...identity,messageId:'m1',role:'USER',createdAt:1,status:'COMPLETED',text:'test'}]}} satisfies AiResult;
    expect(aiResultSchema.safeParse(response).success).toBe(true); expect(aiResultMatches(request,response)).toBe(true);
    expect(aiResultMatches(request,{...response,data:{...response.data,offset:20}})).toBe(false);
    expect(aiResultSchema.safeParse({...response,data:{...response.data,rows:[{...response.data.rows[0],petId:'other'}]}}).success).toBe(false);
    expect(aiResultMatches(send,{...response,requestId:send.requestId})).toBe(false);
  });
  it('makes each shared memory recipient an explicit choice, never a model grant', () => {
    const intent={method:'memory/confirm',payload:{petId:'pet-1',candidateId:'c1',decision:{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']}}};
    expect(aiIntentSchema.safeParse(intent).success).toBe(true);
    for(const decision of [{kind:'CONFIRM',scope:'SHARED'},{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['p','p']},
      {kind:'CONFIRM',scope:'PRIVATE',recipientPetIds:['p']},{kind:'CONFIRM',scope:'PRIVATE',consentState:'CONFIRMED'}]) expect(aiIntentSchema.safeParse({...intent,payload:{...intent.payload,decision}}).success).toBe(false);
  });
  it('isolates plaintext credential ingress from all AI request/results', () => {
    expect(credentialSaveSchema.safeParse({providerId:'p1',credentialRef:'credential:key1',secret:'synthetic-not-a-real-key'}).success).toBe(true);
    expect(credentialSaveSchema.safeParse({providerId:'p1',credentialRef:'credential:key1',secret:'bad\nkey'}).success).toBe(false);
    expect(credentialLookupSchema.safeParse({lookupId:'lookup-1',providerId:'p1',credentialRef:'credential:key1',identity}).success).toBe(true);
    expect(aiResultSchema.safeParse({...result,secret:'synthetic'}).success).toBe(false);
  });
});
