import { DatabaseSync } from 'node:sqlite';
import { describe,expect,it,vi } from 'vitest';
import { AiAuthorityService } from '../../../packages/app-service/src/ai-authority-service.ts';
import { AI_STATE_MIGRATION_SQL,AiStateStorage } from '../../../packages/app-service/src/ai-state-storage.ts';
import { AiControlService } from '../src/app-service/ai/ai-control-service';
import { aiRequestSchema,aiResultMatches,aiResultSchema } from '../src/shared/ai-ipc';
import { chatStreamEventSchema } from '@pet-desktop/contracts/ai';

const NOW=1000,SECRET='fixture-credential-not-real';
const cfg={providerId:'mock-one',endpointKind:'MOCK',privacyBoundary:'MOCK',baseUrl:null,modelId:'mock',credentialRef:null,
  capabilities:{streamText:true,nativeStructured:false,jsonMode:false,usage:false,embeddings:false},maxContextTokens:8000,maxOutputTokens:400,timeoutMs:30000};
const cloud={...cfg,providerId:'cloud-one',endpointKind:'OPENAI_COMPATIBLE',privacyBoundary:'CLOUD',baseUrl:'https://chosen.example/v1',
  modelId:'test-model',credentialRef:'credential:one',capabilities:{...cfg.capabilities,nativeStructured:true}};
const pet=(petId,characterId,nickname)=>({petId,characterId,nickname,presence:'HOME',activity:'IDLE',healthStatus:'NORMAL',mood:'CALM',visibility:'VISIBLE',
  moodScore:50,healthPoints:100,energy:99,bond:20,xp:0,level:1,revision:1});
const snapshot=()=>({revision:3,primaryPetId:'pet-1',walletCoins:21,doNotDisturb:false,pausedRender:false,
  pets:[pet('pet-1','star-singer','星咏'),pet('pet-2','fluffy-ranger','绒绒')]});
const page={offset:0,limit:50};
const identity=(conversation,requestId='turn-one')=>({petId:conversation.petId,conversationId:conversation.conversationId,requestId});
const basic={text:'我会陪伴你。',emotion:'calm',motionIntent:'talk',actionProposals:[],memoryCandidates:[]};
function jsonReply(reply){return new Response(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}]}),
  {status:200,headers:{'content-type':'application/json'}});}
const currentSource=init=>JSON.parse(JSON.parse(init.body).messages[1].content).currentUserMessage.messageId;

async function fixture(run,{fetch:fetcher,broker,authorityOverride,authorizeProactive}={}){
  const db=new DatabaseSync(':memory:');
  let service;
  try{
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE pets(pet_id TEXT PRIMARY KEY) STRICT; INSERT INTO pets VALUES('pet-1'),('pet-2'); CREATE TABLE wallet(coins INTEGER); INSERT INTO wallet VALUES(21);");
    db.exec(AI_STATE_MIGRATION_SQL);
    let active=false,serial=0,invoke=0,clock=NOW;
    const game={snapshot};const transaction=fn=>{
      expect(active).toBe(false);active=true;db.exec('BEGIN IMMEDIATE');
      try{const value=fn(new AiStateStorage(db,()=>active),game);active=false;db.exec('COMMIT');return value;}
      catch(error){active=false;db.exec('ROLLBACK');throw error;}};
    const authority=new AiAuthorityService({transaction,createId:kind=>`${kind}-${++serial}`});
    const events=[],fetch=vi.fn(fetcher??(()=>{throw new Error('Unexpected real provider request');}));
    const credentials={resolveCredential:vi.fn(broker??(async()=>SECRET))};
    service=new AiControlService({authority:authorityOverride?.(authority)??authority,readGameSnapshot:snapshot,
      credentialBroker:credentials,sendEvent:event=>{expect(chatStreamEventSchema.safeParse(event).success).toBe(true);events.push(event);},
      authorizeProactive,now:()=>clock,createId:kind=>`${kind}-${++serial}`,openAiOptions:{fetch}});
    function call(method,payload){
      const request=aiRequestSchema.parse({requestId:`invoke-${++invoke}`,intent:{method,payload}}),result=service.handleRequest(request);
      expect(aiResultSchema.safeParse(result).success).toBe(true);expect(aiResultMatches(request,result)).toBe(true);
      return result;
    }
    const result1=call('conversation/create',{petId:'pet-1',title:'对话一'}),result2=call('conversation/create',{petId:'pet-2',title:'对话二'});
    expect(result1.ok&&result2.ok).toBe(true);
    const f={db,service,authority,events,fetch,credentials,call,conv1:result1.data,conv2:result2.data,setNow(value){clock=value;}};
    return await run(f);
  }finally{service?.close();db.close();}
}
function configure(f,config=cfg,petId='pet-1',allowCloudContext=config.privacyBoundary==='CLOUD'){
  const result=f.call('provider/save',{config,expectedRevision:null});
  expect(result.ok).toBe(true);
  const assigned=f.call('provider/assign',{petId,providerId:config.providerId,providerRevision:result.data.revision,allowCloudContext});
  expect(assigned.ok).toBe(true);return assigned.data;
}
function start(f,conversation=f.conv1,requestId='turn-one',userText='我喜欢茶。'){
  return f.call('chat/start',{...identity(conversation,requestId),trigger:'USER',userText});
}
async function waitTerminal(f,requestId='turn-one'){
  await vi.waitFor(()=>expect(f.events.some(event=>event.requestId===requestId&&['final','error','cancelled'].includes(event.kind))).toBe(true));
  return f.events.find(event=>event.requestId===requestId&&event.kind!=='textDelta');
}
function memoryList(f,petId='pet-1'){return f.call('memory/list',{petId,...page,candidateOffset:0}).data;}

describe('AI utility closed IPC routing and actual provider selection',()=>{
  it('returns correlated closed errors for malformed payloads; never interprets model-supplied controls',()=>fixture(f=>{
    const response=f.service.handleRequest({requestId:'bad-call',intent:{method:'chat/start',payload:{...identity(f.conv1),trigger:'USER',userText:'hello',providerId:'cloud-one'}}});
    expect(response).toMatchObject({requestId:'bad-call',method:'chat/start',ok:false,error:{code:'UNSUPPORTED'}});
    expect(()=>f.service.handleRequest({requestId:'bad-call',intent:{method:'shell/run',payload:{cmd:'example'}}})).toThrow('Invalid AI request envelope');
    expect(f.service.handleRequest({requestId:'bad-call-2',intent:{method:'chat/start',payload:{...identity(f.conv1),trigger:'PROACTIVE',userText:null}}})).toMatchObject({ok:false});
    expect(f.service.handleRequest({requestId:'bad-call-3',intent:{method:'messages/list',payload:{...identity(f.conv1),...page}}}).ok).toBe(false);
  }));
  it('denies an internal proactive turn without explicit trusted authorization',()=>fixture(f=>{
    configure(f);
    const onEvent=vi.fn();
    expect(f.service.startProactive({...identity(f.conv1),trigger:'PROACTIVE',userText:null},onEvent))
      .toMatchObject({accepted:false,reason:'AUTHORITY_REJECTED'});
    expect(onEvent).not.toHaveBeenCalled();
  }));
  it('lets explicit user chat preempt its pet’s authorized proactive job',()=>fixture(async f=>{
    configure(f);
    const onEvent=vi.fn();
    const proactive={...identity(f.conv1,'proactive-fixture'),trigger:'PROACTIVE',userText:null};
    expect(f.service.startProactive(proactive,onEvent)).toMatchObject({accepted:true});
    expect(start(f)).toMatchObject({ok:true});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({kind:'cancelled',requestId:'proactive-fixture',reason:'SUPERSEDED'}));
    expect(await waitTerminal(f)).toMatchObject({kind:'final'});
    expect(f.fetch).not.toHaveBeenCalled();
  },{authorizeProactive:identity=>identity.petId==='pet-1'&&identity.requestId==='proactive-fixture'}));
  it('default unassigned, only supported provider configs are stored; no silent mock or remote fallback',()=>fixture(async f=>{
    expect(start(f)).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
    const unsupported={...cloud,endpointKind:'OPENAI_RESPONSES'};
    expect(f.call('provider/save',{config:unsupported,expectedRevision:null})).toMatchObject({ok:false,error:{code:'UNSUPPORTED'}});
    expect(f.call('provider/save',{config:{...cfg,capabilities:{...cfg.capabilities,embeddings:true}},expectedRevision:null})).toMatchObject({ok:false});
    expect(f.call('provider/save',{config:{...cfg,capabilities:{...cfg.capabilities,usage:true}},expectedRevision:null})).toMatchObject({ok:false});
    expect(f.call('settings/list',page).data).toEqual({providers:[],assignments:[]});
    expect(f.fetch).not.toHaveBeenCalled();expect(f.credentials.resolveCredential).not.toHaveBeenCalled();
  }));
  it('cloud assignment requires explicit acknowledgment and returns no consent token or credential',()=>fixture(f=>{
    const saved=f.call('provider/save',{config:cloud,expectedRevision:null});
    expect(saved.data.revision).toBe(1);
    expect(f.call('provider/assign',{petId:'pet-1',providerId:cloud.providerId,providerRevision:1,allowCloudContext:false})).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
    expect(f.call('provider/assign',{petId:'pet-1',providerId:cloud.providerId,providerRevision:2,allowCloudContext:true})).toMatchObject({ok:false});
    expect(f.call('provider/assign',{petId:'pet-1',providerId:cloud.providerId,providerRevision:1,allowCloudContext:true}).data).toEqual({
      petId:'pet-1',providerId:cloud.providerId,providerRevision:1,assignedAt:NOW,cloudConsent:true});
    const settings=f.call('settings/list',page);
    expect(settings.data.assignments).toHaveLength(1);expect(JSON.stringify(settings)).not.toContain('consent:');expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(f.call('provider/clear',{petId:'pet-1'}).data.changed).toBe(true);
    expect(f.call('provider/clear',{petId:'pet-1'}).data.changed).toBe(false);
    expect(f.call('settings/list',page).data.assignments).toEqual([]);
  }));
  it('real mock provider responds locally, exact turn acceptance differs from IPC invoke id, pending and final persist',()=>fixture(async f=>{
    configure(f);const accepted=start(f);
    expect(accepted.ok).toBe(true);expect(accepted.requestId).not.toEqual(accepted.data.requestId);
    expect(accepted.data).toEqual(identity(f.conv1));
    expect(f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows).toMatchObject([{role:'USER',status:'COMPLETED'},{role:'ASSISTANT',status:'PENDING'}]);
    expect(await waitTerminal(f)).toMatchObject({...identity(f.conv1),kind:'final',reply:{text:expect.stringContaining('本地模拟回复')}});
    expect(f.events.map(event=>event.kind)).toEqual(['textDelta','final']);
    expect(f.events.map(event=>event.sequence)).toEqual([0,1]);
    expect(f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows.at(-1).status).toBe('COMPLETED');
    expect(start(f)).toMatchObject({ok:false});
    expect(f.call('messages/list',{petId:'pet-2',conversationId:f.conv1.conversationId,...page}).data.rows).toEqual([]);
    expect(f.call('conversations/list',{petId:'pet-1',...page}).data.rows.map(row=>row.conversationId)).toEqual([f.conv1.conversationId]);
    expect(f.credentials.resolveCredential).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled();
  }));
  it('real compatible adapter sends only the settings endpoint, trusted per-turn credential and projected context to fake transport',()=>fixture(async f=>{
    configure(f,cloud);expect(start(f,f.conv1,'turn-one','请陪我聊聊')).toMatchObject({ok:true});
    expect(await waitTerminal(f)).toMatchObject({kind:'final',reply:{text:basic.text}});
    expect(f.credentials.resolveCredential).toHaveBeenCalledExactlyOnceWith(cloud.providerId,cloud.credentialRef,expect.any(AbortSignal),identity(f.conv1));
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url,request]=f.fetch.mock.calls[0];
    expect(url).toBe('https://chosen.example/v1/chat/completions');
    expect(new Headers(request.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(request.redirect).toBe('error');expect(request.body).not.toContain(SECRET);expect(request.body).not.toContain('绒绒');
    expect(JSON.stringify(f.events)).not.toContain(SECRET);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM ai_messages').all())).not.toContain(SECRET);
  },{fetch:async()=>jsonReply(basic)}));
  it('missing credentials fail closed with no provider call, no hidden mock response',()=>fixture(async f=>{
    configure(f,cloud);start(f);expect(await waitTerminal(f)).toMatchObject({kind:'error',error:{code:'AUTH_REQUIRED'}});
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows.at(-1)).toMatchObject({status:'FAILED',text:''});
  },{broker:async()=>null}));
  it('honors bounded paging, and never reports unrelated assignment as if it belonged to the selected settings page',()=>fixture(f=>{
    configure(f,cfg);
    const second=f.call('provider/save',{config:cloud,expectedRevision:null});expect(second.ok).toBe(true);
    expect(f.call('settings/list',{offset:0,limit:1}).data.providers.map(record=>record.config.providerId)).toEqual(['cloud-one']);
    expect(f.call('settings/list',{offset:1,limit:1}).data.providers.map(record=>record.config.providerId)).toEqual(['mock-one']);
    expect(f.call('settings/list',{offset:2,limit:1}).data.providers).toEqual([]);
    expect(f.call('settings/list',{offset:2,limit:1}).data.assignments).toEqual([{petId:'pet-1',providerId:'mock-one',providerRevision:1,assignedAt:NOW,cloudConsent:false}]);
    expect(f.service.handleRequest({requestId:'bound',intent:{method:'settings/list',payload:{offset:10001,limit:1}}})).toMatchObject({ok:false,error:{code:'UNSUPPORTED'}});
  }));
  it('rejects mismatched authority rows, owner IDs and raw exceptions without echoing their contents',()=>fixture(f=>{
    const messages=f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page});
    expect(messages).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
    expect(JSON.stringify(messages)).not.toContain('foreign user');
    const memory=f.call('memory/edit',{petId:'pet-1',memoryId:'memory-id',decision:{kind:'EDIT',scope:'PRIVATE',summary:'我的记录',expiresAt:null,pinned:false}});
    expect(memory).toMatchObject({ok:false});expect(JSON.stringify(memory)).not.toContain('foreign memory');
    const settings=f.call('settings/list',page);expect(settings).toMatchObject({ok:false});
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  },{authorityOverride:authority=>Object.assign(Object.create(authority),{
    listMessages:(_pet,conversationId)=>[{petId:'pet-2',conversationId,messageId:'foreign-id',requestId:'request-foreign',role:'USER',status:'COMPLETED',text:'foreign user',createdAt:0}],
    editMemory:()=>({memoryId:'memory-id',ownerPetId:'pet-2',sourceConversationId:'foreign-conv',type:'PREFERENCE',scope:'PRIVATE',summary:'foreign memory',
      sourceMessageIds:['foreign-id'],confidence:.9,consentState:'CONFIRMED',createdAt:0,updatedAt:1,expiresAt:null,pinned:false}),
    listProviderConfigs:()=>{throw new Error(`private repository information ${SECRET}`);},
  })}));
});

describe('credential races, cancellation, proposal and memory authority',()=>{
  it('provider clear while broker awaits aborts durable pending turn; late credential cannot contact fake transport',()=> {
    let resolve;
    return fixture(async f=>{
      configure(f,cloud);start(f);await vi.waitFor(()=>expect(f.credentials.resolveCredential).toHaveBeenCalledOnce());
      expect(f.call('chat/cancel',{...identity(f.conv2),reason:'USER'}).data.changed).toBe(false);
      expect(f.call('provider/clear',{petId:'pet-1'}).data.changed).toBe(true);
      expect(await waitTerminal(f)).toMatchObject({kind:'cancelled',reason:'SUPERSEDED'});
      expect(f.credentials.resolveCredential.mock.calls[0][2].aborted).toBe(true);
      resolve(SECRET);await Promise.resolve();await Promise.resolve();
      expect(f.events).toHaveLength(1);expect(f.fetch).not.toHaveBeenCalled();
      expect(f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows.at(-1).status).toBe('CANCELLED');
    },{broker:()=>new Promise(done=>{resolve=done;})});
  });
  it('saving changed settings before the provider begins invalidates old consent, never sends new endpoint with old assignment',()=>fixture(async f=>{
    configure(f,cloud);start(f);
    const changed=f.call('provider/save',{config:{...cloud,baseUrl:'https://updated.example/v1'},expectedRevision:1});
    expect(changed.data.revision).toBe(2);expect(await waitTerminal(f)).toMatchObject({kind:'cancelled'});
    expect(f.fetch).not.toHaveBeenCalled();expect(f.credentials.resolveCredential).not.toHaveBeenCalled();
    expect(start(f,f.conv1,'fresh')).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
  }));
  it('actual message redaction during an opened provider request cancels and ignores its late result',()=>{
    let resolve;
    return fixture(async f=>{
      configure(f,cloud);start(f);await vi.waitFor(()=>expect(f.fetch).toHaveBeenCalledOnce());
      const request=f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows[0];
      expect(f.call('message/edit',{petId:'pet-2',conversationId:f.conv1.conversationId,messageId:request.messageId,text:'伪造'}).data.changed).toBe(false);
      expect(f.call('message/edit',{petId:'pet-1',conversationId:f.conv1.conversationId,messageId:request.messageId,text:'我喜欢咖啡'}).data.changed).toBe(true);
      expect(await waitTerminal(f)).toMatchObject({kind:'cancelled'});
      resolve(jsonReply(basic));await Promise.resolve();await Promise.resolve();
      expect(f.events).toHaveLength(1);
      expect(f.call('message/delete',{petId:'pet-1',conversationId:f.conv1.conversationId,messageId:request.messageId}).data.changed).toBe(true);
      expect(f.call('messages/list',{petId:'pet-1',conversationId:f.conv1.conversationId,...page}).data.rows).toMatchObject([{role:'ASSISTANT',status:'CANCELLED'}]);
    },{fetch:()=>new Promise(done=>{resolve=done;})});
  });
  it('only inert approved proposal IDs and real user-sourced memory candidates persist; explicit CRUD never writes game values',()=>fixture(async f=>{
    configure(f,cloud);start(f);
    expect(await waitTerminal(f)).toMatchObject({kind:'final',reply:{actionProposals:[{type:'REST',targetId:'self'}],memoryCandidates:[{scope:'SHARED'}]}});
    const proposals=f.call('proposals/list',{petId:'pet-1'}).data.rows;
    expect(proposals).toHaveLength(1);expect(proposals[0].confirmationRequired).toBe(true);
    expect(f.call('proposals/list',{petId:'pet-2'}).data.rows).toEqual([]);
    expect(f.call('proposal/dismiss',{petId:'pet-2',proposalId:proposals[0].proposalId}).data.changed).toBe(false);
    expect(f.call('proposal/dismiss',{petId:'pet-1',proposalId:proposals[0].proposalId}).data.changed).toBe(true);
    expect(f.call('proposals/list',{petId:'pet-1'}).data.rows).toEqual([]);
    const initial=memoryList(f);expect(initial.memories).toEqual([]);expect(initial.candidates).toHaveLength(1);
    const candidate=initial.candidates[0];
    expect(f.call('memory/confirm',{petId:'pet-2',candidateId:candidate.candidateId,decision:{kind:'CONFIRM',scope:'PRIVATE'}}).ok).toBe(false);
    const confirmed=f.call('memory/confirm',{petId:'pet-1',candidateId:candidate.candidateId,decision:{kind:'CONFIRM',scope:'PRIVATE',pinned:true}});
    expect(confirmed.data).toMatchObject({scope:'PRIVATE',ownerPetId:'pet-1',pinned:true});
    const memoryId=confirmed.data.memoryId;
    expect(memoryList(f).candidates).toEqual([]);expect(f.authority.retrieveMemories('pet-2','茶',NOW)).toEqual([]);
    expect(f.call('memory/edit',{petId:'pet-2',memoryId,decision:{kind:'EDIT',scope:'PRIVATE',summary:'他人修改',expiresAt:null,pinned:false}}).ok).toBe(false);
    expect(f.call('memory/edit',{petId:'pet-1',memoryId,decision:{kind:'EDIT',scope:'SHARED',recipientPetIds:['pet-2'],summary:'用户喜欢红茶',expiresAt:null,pinned:false}}).data).toMatchObject({scope:'SHARED'});
    expect(f.authority.retrieveMemories('pet-2','茶',NOW)).toHaveLength(1);
    expect(f.call('memory/revoke',{petId:'pet-1',memoryId,recipientPetId:'pet-2'}).data.changed).toBe(true);
    expect(f.authority.retrieveMemories('pet-2','茶',NOW)).toEqual([]);
    expect(f.call('memory/delete',{petId:'pet-2',memoryId}).data.changed).toBe(false);
    expect(f.call('memory/clear',{petId:'pet-1'}).data.count).toBe(1);
    expect(memoryList(f).memories).toEqual([]);
    expect(f.db.prepare('SELECT coins FROM wallet').get().coins).toBe(21);
  },{fetch:async(_url,init)=>jsonReply({...basic,actionProposals:[
    {type:'REST',targetId:'self',reason:'休息一下'},{type:'QUICK_ACTION_SUGGESTION',targetId:'editor',reason:'启动软件'}],
    memoryCandidates:[{scope:'SHARED',type:'PREFERENCE',summary:'用户喜欢茶',sourceMessageIds:[currentSource(init)],confidence:.9}]})}));
  it('reject memory candidate without promoting it; subsequent user turn can independently create/delete new memory',()=>fixture(async f=>{
    configure(f,cloud);start(f);await waitTerminal(f);
    const candidate=memoryList(f).candidates[0];
    expect(f.call('memory/reject',{petId:'pet-2',candidateId:candidate.candidateId}).data.changed).toBe(false);
    expect(f.call('memory/reject',{petId:'pet-1',candidateId:candidate.candidateId}).data.changed).toBe(true);
    expect(memoryList(f)).toMatchObject({memories:[],candidates:[]});
    f.setNow(NOW+50);start(f,f.conv1,'second');await waitTerminal(f,'second');
    const next=memoryList(f).candidates[0];
    const confirmed=f.call('memory/confirm',{petId:'pet-1',candidateId:next.candidateId,decision:{kind:'CONFIRM',scope:'PRIVATE'}});
    expect(confirmed.ok).toBe(true);
    expect(f.call('memory/delete',{petId:'pet-1',memoryId:confirmed.data.memoryId}).data.changed).toBe(true);
    expect(memoryList(f).memories).toEqual([]);
  },{fetch:async(_url,init)=>jsonReply({...basic,memoryCandidates:[{scope:'PRIVATE',type:'PREFERENCE',summary:'用户喜欢茶',sourceMessageIds:[currentSource(init)],confidence:.9}]})}));
  it('trusted cancellation scope and service close persist terminal once; no start after close',()=>fixture(async f=>{
    configure(f,cloud);start(f);await vi.waitFor(()=>expect(f.credentials.resolveCredential).toHaveBeenCalledOnce());
    expect(f.service.cancelInternal(identity(f.conv2),'PET_SWITCH')).toBe(false);
    expect(f.service.cancelInternal(identity(f.conv1),'PET_SWITCH')).toBe(true);
    expect(await waitTerminal(f)).toMatchObject({kind:'cancelled',reason:'PET_SWITCH'});
    expect(start(f,f.conv1,'turn-two').ok).toBe(true);f.service.close();
    expect(await waitTerminal(f,'turn-two')).toMatchObject({kind:'cancelled',reason:'SERVICE_STOPPED'});
    expect(start(f,f.conv1,'turn-three')).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
    expect(f.service.activeCount).toBe(0);expect(f.fetch).not.toHaveBeenCalled();
  },{broker:()=>new Promise(()=>undefined)}));
  it('public USER cancel requires exact identity and is idempotent; repeated cancellation emits no duplicate event',()=>fixture(async f=>{
    configure(f,cloud);start(f);
    expect(f.call('chat/cancel',{...identity(f.conv1,'different-request'),reason:'USER'}).data.changed).toBe(false);
    expect(f.call('chat/cancel',{...identity(f.conv1),reason:'USER'}).data.changed).toBe(true);
    expect(f.call('chat/cancel',{...identity(f.conv1),reason:'USER'}).data.changed).toBe(false);
    expect(await waitTerminal(f)).toMatchObject({...identity(f.conv1),kind:'cancelled',reason:'USER'});
    expect(f.events).toHaveLength(1);expect(f.fetch).not.toHaveBeenCalled();expect(f.credentials.resolveCredential).not.toHaveBeenCalled();
  }));
});
