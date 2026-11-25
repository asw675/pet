import { describe, expect, it, vi } from 'vitest';
import { appSnapshotSchema } from '@pet-desktop/contracts';
import { actionProposalSchema, aiLimits, memoryRecordSchema, pendingMemoryCandidateSchema } from '@pet-desktop/contracts/ai';
import type { ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import type { AiIntent, ChatIdentity, ProviderRecordView } from '../src/shared/ai-ipc';
import {
  aiNextOffset, canConfirmRest, draftProviderConfig, memoryDecisionIntent, newChatOverlay, providerAssignmentIntent,
  reduceChatOverlay, sameChatIdentity, validRecipientIds, validateAiResponse,
} from '../src/renderer/shared/ai-view-policy';
import type { MemoryDraft, ProviderDraft } from '../src/renderer/shared/ai-view-policy';
const identity: ChatIdentity = { petId:'star', conversationId:'star-conv', requestId:'req-star-1' };
const mockReply = { text: '实际文本', motionIntent:null, emotion:'happy' as const, memoryCandidates:[], actionProposals:[] };
const baseDraft: ProviderDraft = { providerId:'provider-1', profile:'MOCK', baseUrl:'https://irrelevant.example/v1', modelId:'mock-desktop',
  useCredential:true, jsonMode:true, streamText:true, maxContextTokens:8192, maxOutputTokens:1024, timeoutMs:60000 };
const mockConfig = draftProviderConfig(baseDraft, null, () => 'credential:mock')!;
const localDraft: ProviderDraft = { ...baseDraft, profile:'LOCAL', baseUrl:'http://127.0.0.1:11434/v1', modelId:'model:local', useCredential:false, jsonMode:false };
const cloudDraft: ProviderDraft = { ...baseDraft, profile:'CLOUD', baseUrl:'https://model.example/v1', modelId:'model:remote' };
const cloudConfig = draftProviderConfig(cloudDraft, null, () => 'credential:cloud')!;
const cloud: ProviderRecordView = { config:cloudConfig, revision:3, updatedAt:200 };
const local: ProviderRecordView = { config:draftProviderConfig(localDraft,null,()=> 'credential:ignored')!, revision:1, updatedAt:100 };
const pet = (petId: string, char: string, edits: Partial<PetSnapshot> = {}): PetSnapshot => ({
  petId, characterId:char, nickname:petId, presence:'HOME', activity:'IDLE', mood:'CALM', healthStatus:'NORMAL', visibility:'HIDDEN',
  moodScore:50, healthPoints:100, energy:90, bond:10, level:2, xp:150, revision:1, ...edits,
});
const star = pet('star','star-singer',{ visibility:'VISIBLE' }), ranger = pet('ranger','fluffy-ranger'), nova = pet('nova','nova');
const snapshot = appSnapshotSchema.parse({revision:7,primaryPetId:'star',walletCoins:5,doNotDisturb:false,pausedRender:false,pets:[star,ranger,nova]});
const candidate = pendingMemoryCandidateSchema.parse({ownerPetId:'star',candidateId:'candidate-1',conversationId:'star-conv',requestId:'req-star-1',
  type:'PREFERENCE',scope:'SHARED',summary:'喜欢看星星',sourceMessageIds:['user-1'],confidence:.8,consentState:'PENDING',createdAt:1000,expiresAt:10000});
const memory = memoryRecordSchema.parse({ownerPetId:'star',memoryId:'memory-1',sourceConversationId:'star-conv',
  type:'PREFERENCE',scope:'SHARED',recipientPetIds:['ranger'],summary:candidate.summary,sourceMessageIds:['user-1'],confidence:.8,
  consentState:'CONFIRMED',createdAt:1200,updatedAt:1300,pinned:false,expiresAt:null});
const privateDraft: MemoryDraft = {summary:'喜欢看星星',scope:'PRIVATE',recipients:[],pinned:true,expiresAt:null};
const proposal = actionProposalSchema.parse({...identity,proposalId:'proposal-1',type:'REST',targetId:'self',reason:'休息一下',expiresAt:2000,confirmationRequired:true});

describe('stream presentation isolation (never stored history)', () => {
  const init = () => newChatOverlay(identity,3,7);
  const delta = (sequence:number,text:string,edit:Partial<ChatIdentity>={}) => ({ ...identity,...edit,sequence,kind:'textDelta',delta:text });
  const reduce = (state=init(),raw:unknown=delta(0,'你好'),gen:number|null=3,epoch=7) => reduceChatOverlay(state,raw,gen,epoch);
  it('accumulates only contiguous bounded text deltas of exact same identity',()=>{
    const first=reduce(), second=reduce(first,delta(1,'，伙伴'));
    expect(second.text).toBe('你好，伙伴'); expect(second.nextSequence).toBe(2); expect(second.terminal).toBeNull();
    expect(first.text).toBe('你好'); expect(sameChatIdentity(identity,{...identity})).toBe(true);
  });
  it.each([{petId:'ranger'},{conversationId:'other-conv'},{requestId:'another-request'}])('rejects foreign identity %j',edit=>{
    const current=init(); expect(reduce(current,delta(0,'不能渲染',edit))).toBe(current);
  });
  it('rejects stale or absent service generation and local scope epoch',()=>{
    const current=init();
    expect(reduce(current,delta(0,'stale'),2)).toBe(current);
    expect(reduce(current,delta(0,'stale'),null)).toBe(current);
    expect(reduce(current,delta(0,'stale'),3,8)).toBe(current);
  });
  it('rejects malformed or repeated deltas',()=>{
    const one=reduce();
    expect(reduce(one,delta(0,'duplicate'))).toBe(one);
    expect(reduce(one,{ ...delta(1,'x'), script:'not permitted' })).toBe(one);
    expect(reduce(one,delta(1,''))).toBe(one);
  });
  it('stops displaying incomplete data after a sequence gap but handles a valid subsequent committed final',()=>{
    const first=reduce(), gap=reduce(first,delta(2,'gap'));
    expect(gap).toMatchObject({degraded:true,text:'',nextSequence:3,terminal:null});
    expect(reduce(gap,delta(1,'late'))).toBe(gap);
    expect(reduce(gap,delta(3,'no preview')).text).toBe('');
    const final=reduce(gap,{...identity,sequence:4,kind:'final',reply:mockReply,usage:null});
    expect(final).toMatchObject({terminal:'final',text:'',degraded:true}); expect(final).not.toHaveProperty('reply');
    expect(reduce(final,delta(5,'late'))).toBe(final);
  });
  it('enforces aggregate reply bound even when every delta is individually valid',()=>{
    let state=init();
    for(let i=0;i<aiLimits.replyText/aiLimits.deltaText;i++) state=reduce(state,delta(i,'甲'.repeat(aiLimits.deltaText)));
    expect(state.text.length).toBe(aiLimits.replyText);
    expect(reduce(state,delta(state.nextSequence,'超'))).toMatchObject({degraded:true,text:''});
  });
  it('terminal errors and cancellations clear partial text and are immutable, without exposing raw error text',()=>{
    const partial=reduce();
    const err=reduce(partial,{...identity,sequence:1,kind:'error',error:{code:'NETWORK',message:'not for display',retryable:true}});
    expect(err).toMatchObject({terminal:'error',error:'NETWORK',text:''});expect(JSON.stringify(err)).not.toContain('not for display');
    expect(reduce(err,{...identity,sequence:2,kind:'cancelled',reason:'USER'})).toBe(err);
    const cancelled=reduce(partial,{...identity,sequence:1,kind:'cancelled',reason:'USER'});
    expect(cancelled).toMatchObject({terminal:'cancelled',error:null,text:''});
  });
  it('final reply draft branch effects are not copied into overlay',()=>{
    const event:ChatStreamEvent={...identity,kind:'final',sequence:0,reply:{...mockReply,actionProposals:[{type:'REST',targetId:'self',reason:'建议'}],
      memoryCandidates:[{type:'PREFERENCE',scope:'SHARED',summary:'喜欢星星',confidence:.8,sourceMessageIds:['user-1']}]},usage:null};
    const final=reduce(init(),event);
    expect(final.terminal).toBe('final');expect(final.text).toBe('');expect(final).not.toHaveProperty('memoryCandidates');expect(final).not.toHaveProperty('actionProposals');
  });
});

describe('provider configuration and explicit privacy boundary',()=>{
  it('MOCK strips network URL, credentials and remote capability flags',()=>{
    const make=vi.fn(()=> 'credential:never');
    const config=draftProviderConfig(baseDraft,null,make)!;
    expect(config).toMatchObject({baseUrl:null,credentialRef:null,privacyBoundary:'MOCK',endpointKind:'MOCK',capabilities:{nativeStructured:true,jsonMode:false}});
    expect(make).not.toHaveBeenCalled();
  });
  it.each(['http://127.0.0.1:11434/v1','http://localhost:8080/v1','https://[::1]:443/v1'])('accepts explicit loopback %s',baseUrl=>{
    expect(draftProviderConfig({...localDraft,baseUrl},null,()=> 'credential:ignored')).toMatchObject({privacyBoundary:'LOCAL',baseUrl,credentialRef:null});
  });
  it.each(['http://model.example/v1','https://model.example/v1','http://192.168.1.10/v1','http://127.1/v1','http://localhost/v1?token=x'])('rejects mislabeled LOCAL endpoint %s',baseUrl=>{
    expect(draftProviderConfig({...localDraft,baseUrl},null,()=> 'credential:x')).toBeUndefined();
  });
  it('cloud requires remote canonical HTTPS and a separate opaque credential reference',()=>{
    expect(cloudConfig).toMatchObject({endpointKind:'OPENAI_COMPATIBLE',privacyBoundary:'CLOUD',credentialRef:'credential:cloud'});
    expect(draftProviderConfig({...cloudDraft,baseUrl:'http://model.example/v1'},null,()=> 'credential:cloud')).toBeUndefined();
    expect(draftProviderConfig({...cloudDraft,baseUrl:'https://localhost/v1'},null,()=> 'credential:cloud')).toBeUndefined();
    expect(draftProviderConfig(cloudDraft,null,()=> 'plain-api-key')).toBeUndefined();
  });
  it('never reuses a cloud credential ref when endpoint changes, even for same existing providerId',()=>{
    const make=vi.fn(()=> 'credential:new-endpoint');
    expect(draftProviderConfig({...cloudDraft,modelId:'different-model'},cloud,make)?.credentialRef).toBe('credential:cloud');
    expect(make).not.toHaveBeenCalled();
    expect(draftProviderConfig({...cloudDraft,baseUrl:'https://different.example/v1'},cloud,make)?.credentialRef).toBe('credential:new-endpoint');
    expect(make).toHaveBeenCalledTimes(1);
  });
  it('local optional credentials are explicit and budget constraint is enforced',()=>{
    expect(draftProviderConfig({...localDraft,useCredential:true},null,()=> 'credential:local')?.credentialRef).toBe('credential:local');
    expect(draftProviderConfig({...localDraft,maxOutputTokens:8192},null,()=> 'credential:local')).toBeUndefined();
    expect(draftProviderConfig({...localDraft,timeoutMs:999},null,()=> 'credential:local')).toBeUndefined();
  });
  it('cloud assignment cannot be constructed without independent explicit approval; local cannot carry remote consent',()=>{
    expect(providerAssignmentIntent('star',cloud,false)).toBeUndefined();
    expect(providerAssignmentIntent('star',cloud,true)).toEqual({method:'provider/assign',payload:{petId:'star',providerId:'provider-1',providerRevision:3,allowCloudContext:true}});
    expect(providerAssignmentIntent('ranger',local,true)).toBeUndefined();
    expect(providerAssignmentIntent('ranger',local,false)?.payload).toMatchObject({petId:'ranger',allowCloudContext:false,providerRevision:1});
  });
});

describe('memory and action suggestions require explicit bounded user intent',()=>{
  it('model-suggested SHARED pending row does not grant access or influence a private choice',()=>{
    const result=memoryDecisionIntent(candidate,privateDraft,snapshot,'star',2000);
    expect(result).toEqual({method:'memory/confirm',payload:{petId:'star',candidateId:'candidate-1',decision:{kind:'CONFIRM',scope:'PRIVATE',
      editedSummary:'喜欢看星星',pinned:true,expiresAt:null}}});
    expect(JSON.stringify(result)).not.toContain('sourceMessageIds');
  });
  it('SHARED only passes names selected by the user, sorted and bounded',()=>{
    const draft={...privateDraft,scope:'SHARED' as const,recipients:['ranger','nova']};
    expect(memoryDecisionIntent(candidate,draft,snapshot,'star',2000)?.payload).toMatchObject({decision:{scope:'SHARED',recipientPetIds:['nova','ranger']}});
  });
  it.each([[],['star'],['ranger','ranger'],['unknown'],['ranger','star']].map(recipients=>({recipients})))('rejects invalid recipient list $recipients',({recipients})=>{
    expect(validRecipientIds('star',recipients,snapshot)).toBe(false);
    expect(memoryDecisionIntent(candidate,{...privateDraft,scope:'SHARED',recipients},snapshot,'star',2000)).toBeUndefined();
  });
  it('rejects recipient IDs hidden in a PRIVATE intent',()=>{
    expect(memoryDecisionIntent(candidate,{...privateDraft,recipients:['nova']},snapshot,'star',2000)).toBeUndefined();
  });
  it('rejects cross-pet owner, expired candidate and invalid new memory expiry',()=>{
    expect(memoryDecisionIntent(candidate,privateDraft,snapshot,'ranger',2000)).toBeUndefined();
    expect(memoryDecisionIntent(candidate,privateDraft,snapshot,'star',candidate.expiresAt)).toBeUndefined();
    expect(memoryDecisionIntent(candidate,{...privateDraft,expiresAt:2000},snapshot,'star',2000)).toBeUndefined();
    expect(memoryDecisionIntent(candidate,{...privateDraft,summary:'  '},snapshot,'star',2000)).toBeUndefined();
    expect(memoryDecisionIntent(candidate,{...privateDraft,summary:'甲'.repeat(513)},snapshot,'star',2000)).toBeUndefined();
  });
  it('edits confirmed record identity, pin and exact new scope instead of creating another record',()=>{
    expect(memoryDecisionIntent(memory,{...privateDraft,scope:'SHARED',recipients:['nova'],summary:'更新星星偏好'},snapshot,'star',2000)).toEqual({
      method:'memory/edit',payload:{petId:'star',memoryId:'memory-1',decision:{kind:'EDIT',scope:'SHARED',recipientPetIds:['nova'],
        summary:'更新星星偏好',pinned:true,expiresAt:null}},
    });
  });
  it('REST is only an ordinary explicit game gesture for self and live home pet before expiry',()=>{
    expect(canConfirmRest(proposal,'star',snapshot,1999)).toBe(true);
    expect(canConfirmRest(proposal,'star',snapshot,2000)).toBe(false);
    expect(canConfirmRest(proposal,'ranger',snapshot,1999)).toBe(false);
    for(const edit of [{type:'TRIP_SUGGESTION' as const},{type:'QUICK_ACTION_SUGGESTION' as const,targetRevision:0,targetLabel:'editor'},{targetId:'arbitrary'}])
      expect(canConfirmRest({...proposal,...edit},'star',snapshot,1999)).toBe(false);
    const offsite:AppSnapshot={...snapshot,pets:[{...star,presence:'AWAY',activity:null,trip:{tripId:'trip',routeId:'mist-forest',status:'TRAVELING',expectedReturnAt:5000}},ranger,nova]};
    expect(canConfirmRest(proposal,'star',offsite,1999)).toBe(false);
    for(const activity of ['CHAT','DRAG'] as const)expect(canConfirmRest(proposal,'star',{...snapshot,pets:[{...star,activity},ranger,nova]},1999)).toBe(false);
  });
});

describe('IPC response scope and page bounds',()=>{
  const intent:AiIntent={method:'conversations/list',payload:{petId:'star',offset:0,limit:1}};
  const conversation={petId:'star',conversationId:'star-conv',title:'真实会话',createdAt:100,updatedAt:200};
  const response={ok:true,requestId:'transport-unique',method:'conversations/list',data:{...intent.payload,rows:[conversation]}};
  it('accepts schema-checked exact query scope',()=>expect(validateAiResponse(intent,response)).toEqual(response));
  it('rejects mismatched pet, wrong page, duplicate/more-than-limit rows and invalid method',()=>{
    expect(validateAiResponse(intent,{...response,data:{...response.data,petId:'ranger',rows:[{...conversation,petId:'ranger'}]}})).toBeNull();
    expect(validateAiResponse(intent,{...response,data:{...response.data,offset:1}})).toBeNull();
    expect(validateAiResponse(intent,{...response,data:{...response.data,rows:[conversation,conversation]}})).toBeNull();
    expect(validateAiResponse(intent,{...response,data:{...response.data,rows:[conversation,{...conversation,conversationId:'another'}]}})).toBeNull();
    expect(validateAiResponse(intent,{...response,method:'provider/clear',data:{changed:true}})).toBeNull();
  });
  it('rejects wrong stream start identity despite success schema',()=>{
    const start:AiIntent={method:'chat/start',payload:{...identity,trigger:'USER',userText:'你好'}};
    const ok={ok:true,requestId:'rpc-request',method:'chat/start',data:{...identity}};
    expect(validateAiResponse(start,ok)).toEqual(ok);
    expect(validateAiResponse(start,{...ok,data:{...identity,requestId:'wrong'}})).toBeNull();
  });
  it('rejects invalid memory ownership and duplicate rows on a management page',()=>{
    const query:AiIntent={method:'memory/list',payload:{petId:'star',offset:0,candidateOffset:0,limit:2}};
    const ok={ok:true,requestId:'rpc-request',method:'memory/list',data:{...query.payload,memories:[memory],candidates:[candidate]}};
    expect(validateAiResponse(query,ok)).toEqual(ok);
    expect(validateAiResponse(query,{...ok,data:{...ok.data,memories:[memory,memory]}})).toBeNull();
    expect(validateAiResponse(query,{...ok,data:{...ok.data,candidates:[{...candidate,ownerPetId:'nova'}]}})).toBeNull();
  });
  it('no total is invented; only exactly full page offers possible next offset',()=>{
    expect(aiNextOffset(0,20,20,1)).toBe(20);expect(aiNextOffset(0,20,19,1)).toBeUndefined();
    expect(aiNextOffset(20,20,0,-1)).toBe(0);expect(aiNextOffset(0,20,20,-1)).toBeUndefined();
    expect(aiNextOffset(10_000,20,20,1)).toBeUndefined();
  });
});
