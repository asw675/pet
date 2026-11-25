import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_MEMORY_FTS_MIGRATION_SQL, AI_STATE_MIGRATION_SQL, AiStateStorage, verifyMemorySearchIndex } from '../src/ai-state-storage.ts';
import { memoryPolicyLimits } from '../src/memory-policy.ts';

const NOW = 1000;
const config = { providerId:'provider-mock', endpointKind:'MOCK', privacyBoundary:'MOCK', baseUrl:null, modelId:'mock',credentialRef:null,
  capabilities:{streamText:true,nativeStructured:true,jsonMode:true,usage:false,embeddings:false},maxContextTokens:8000,maxOutputTokens:400,timeoutMs:30000 };
const cloud = { ...config, providerId:'provider-cloud', endpointKind:'OPENAI_COMPATIBLE',privacyBoundary:'CLOUD',baseUrl:'https://provider.example/v1',
  modelId:'demo/cloud', credentialRef:'credential:cloud-one' };
const ident = (requestId='turn-1',petId='pet-1') => ({requestId,petId,conversationId:`conv-${petId}`});
const candidateDraft = { scope:'PRIVATE',type:'PREFERENCE',summary:'用户喜欢茶',sourceMessageIds:['user-turn-1'],confidence:.9 };
const basicReply = { text:'一起喝茶。',emotion:'calm',motionIntent:'talk',actionProposals:[],memoryCandidates:[] };

function beginInput(requestId='turn-1',petId='pet-1',startedAt=NOW,changes={}) {
  const identity=ident(requestId,petId), characterId=petId==='pet-2'?'fluffy-ranger':'star-singer';
  const turn={...identity,trigger:'USER',personaRevision:1,snapshotRevision:3,deadline:startedAt+30000,userText:'我喜欢茶。',userMessageId:`user-${requestId}`,
    context:{persona:{personaId:`persona-${characterId}`,characterId,revision:1,displayName:'角色',background:'原创角色',personality:{summary:'温柔',traits:[],likes:[],speechStyle:'温柔'},languageTag:'zh-CN',allowedMotionIds:['idle','talk']},
      game:{petId,characterId,nickname:'角色',petRevision:1,presence:'HOME',activity:'IDLE',mood:'CALM',healthStatus:'NORMAL',moodScore:50,healthPoints:100,energy:90,bond:0,level:1,xp:0,trip:null,recentEvents:[]},
      recentMessages:[],authorizedMemories:[],historySummary:null}};
  return {turn,...{providerId:config.providerId,providerRevision:1,assistantMessageId:`assistant-${requestId}`,startedAt},...changes};
}
function complete(requestId='turn-1',petId='pet-1',completedAt=NOW+10,reply=basicReply,proposals=[],memoryCandidates=[]) {
  return {...ident(requestId,petId),kind:'COMPLETED',completedAt,reply,usage:null,proposals,memoryCandidates};
}
function failed(requestId='turn-1',petId='pet-1',at=NOW+10) {return {...ident(requestId,petId),kind:'FAILED',completedAt:at,error:{code:'NETWORK',message:'private upstream detail',retryable:true}};}
function cancelled(requestId='turn-1',petId='pet-1',at=NOW+10) {return {...ident(requestId,petId),kind:'CANCELLED',completedAt:at,reason:'USER'};}
function candidate(requestId='turn-1',petId='pet-1',at=NOW+10,changes={}) {
  return {...candidateDraft,sourceMessageIds:[`user-${requestId}`],candidateId:`candidate-${requestId}`,ownerPetId:petId,conversationId:`conv-${petId}`,requestId,
    consentState:'PENDING',createdAt:at,expiresAt:at+100000,...changes};
}
function proposal(requestId='turn-1',petId='pet-1',at=NOW+10,changes={}) {
  return {...ident(requestId,petId),proposalId:`proposal-${requestId}`,type:'REST',targetId:'self',reason:'先休息',expiresAt:at+60000,confirmationRequired:true,...changes};
}
function terminalWithCandidate(requestId='turn-1',petId='pet-1',at=NOW+10,candidateChanges={}) {
  const value=candidate(requestId,petId,at,candidateChanges), suggestion=proposal(requestId,petId,at);
  const {scope,type,summary,sourceMessageIds,confidence}=value;
  return complete(requestId,petId,at,{...basicReply,actionProposals:[{type:suggestion.type,targetId:suggestion.targetId,reason:suggestion.reason}],memoryCandidates:[{scope,type,summary,sourceMessageIds,confidence}]},[suggestion],[value]);
}

function wrap(db) {
  let active=false;
  const tx=(action)=>{db.exec('BEGIN IMMEDIATE');active=true;const store=new AiStateStorage(db,()=>active);
    try{const result=action(store);if(result&&typeof result.then==='function')throw new Error('test does not permit async transaction');active=false;db.exec('COMMIT');return result;}
    catch(error){active=false;db.exec('ROLLBACK');throw error;}};
  return {db,tx};
}
function prepare(db, withSearch = true) {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; CREATE TABLE pets(pet_id TEXT PRIMARY KEY) STRICT;
    INSERT INTO pets VALUES('pet-1'),('pet-2'),('pet-3');
    CREATE TABLE wallet(coins INTEGER NOT NULL) STRICT; INSERT INTO wallet VALUES(21);
    CREATE TABLE preferences(revision INTEGER NOT NULL) STRICT; INSERT INTO preferences VALUES(9);`);
  db.exec('BEGIN IMMEDIATE');try{db.exec(AI_STATE_MIGRATION_SQL);if(withSearch)db.exec(AI_MEMORY_FTS_MIGRATION_SQL);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  const fixture=wrap(db);
  fixture.tx(store=>{store.saveProviderConfig(config,null,0);for(const petId of ['pet-1','pet-2','pet-3']){
    store.setPetProviderAssignment({petId,providerId:config.providerId,providerRevision:1,consentRef:null,assignedAt:0});
    store.createConversation({petId,conversationId:`conv-${petId}`,title:`聊天 ${petId}`,createdAt:0,updatedAt:0});}});
  return fixture;
}
function withMemory(action) {const db=new DatabaseSync(':memory:');try{return action(prepare(db));}finally{db.close();}}
function createCandidate(f,requestId='turn-1',petId='pet-1',at=NOW) {
  f.tx(store=>{expect(store.beginTurn(beginInput(requestId,petId,at))).toBe('STARTED');expect(store.finishTurn(terminalWithCandidate(requestId,petId,at+10))).toBe(true);});
}

describe('additive AI storage: single connection, explicit provider and consent revisions',()=>{
  it('does not create a second writer or modify game rows; scopes escaped transaction objects',()=>withMemory(f=>{
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM wallet').get().coins).toBe(21);
    let escaped;f.tx(store=>{escaped=store;expect(store.listProviderConfigs()).toHaveLength(1);});
    expect(()=>escaped.listProviderConfigs()).toThrow(/no longer active/);
    expect(f.db.prepare('SELECT * FROM preferences').get().revision).toBe(9);
  }));

  it('stores only the closed provider configuration and no actual credential field',()=>withMemory(f=>{
    f.tx(store=>{expect(store.saveProviderConfig(cloud,null,100)).toEqual({config:cloud,revision:1,updatedAt:100});
      expect(()=>store.saveProviderConfig({...config,providerId:'wrong',apiKey:'test-private-key'},null,100)).toThrow();
      expect(store.getProviderConfig('wrong')).toBeNull();
      expect(store.getProviderConfig(cloud.providerId).config.credentialRef).toBe('credential:cloud-one');});
    const persisted=f.db.prepare('SELECT config_json FROM ai_provider_configs').all().map(row=>row.config_json).join('');
    expect(persisted).not.toContain('test-private-key');expect(persisted).not.toContain('apiKey');
  }));

  it('requires explicit cloud consent reference and current settings version, invalidates silently edited provider assignments',()=>withMemory(f=>{
    f.tx(store=>{store.saveProviderConfig(cloud,null,10);
      expect(()=>store.setPetProviderAssignment({petId:'pet-1',providerId:cloud.providerId,providerRevision:1,consentRef:null,assignedAt:20})).toThrow(/consent/i);
      store.setPetProviderAssignment({petId:'pet-1',providerId:cloud.providerId,providerRevision:1,consentRef:'consent:cloud-one',assignedAt:20});
      expect(store.resolveAssignedProvider('pet-1').provider.config).toEqual(cloud);
      expect(()=>store.saveProviderConfig({...cloud,modelId:'other'},0,30)).toThrow(/revision/);
      const updated=store.saveProviderConfig({...cloud,modelId:'other'},1,30);expect(updated.revision).toBe(2);
      expect(store.resolveAssignedProvider('pet-1')).toBeNull(); // no implicit fallback / old consent
      expect(()=>store.setPetProviderAssignment({petId:'pet-1',providerId:cloud.providerId,providerRevision:1,consentRef:'consent:old',assignedAt:40})).toThrow();
      store.setPetProviderAssignment({petId:'pet-1',providerId:cloud.providerId,providerRevision:2,consentRef:'consent:new',assignedAt:40});
      expect(store.resolveAssignedProvider('pet-1').provider.revision).toBe(2);
      expect(store.clearPetProviderAssignment('pet-1')).toBe(true);expect(store.resolveAssignedProvider('pet-1')).toBeNull();});
  }));
});

describe('durable conversation turns and exact terminal compare-and-set',()=>{
  it('atomically persists user completed+pending assistant and owns exact request/pet/conversation identity',()=>withMemory(f=>{
    f.tx(store=>{expect(store.beginTurn(beginInput())).toBe('STARTED');expect(store.beginTurn(beginInput())).toBe('DUPLICATE');
      expect(store.beginTurn(beginInput('turn-1','pet-2'))).toBe('DUPLICATE');
      expect(store.getTurn('turn-1')).toMatchObject({status:'PENDING',petId:'pet-1',conversationId:'conv-pet-1',providerRevision:1});
      expect(store.listMessages('pet-1','conv-pet-1')).toMatchObject([{role:'USER',status:'COMPLETED',text:'我喜欢茶。'},{role:'ASSISTANT',status:'PENDING',text:''}]);
      expect(store.listMessages('pet-2','conv-pet-1')).toEqual([]);expect(store.getMessage('pet-2','conv-pet-2','user-turn-1')).toBeNull();});
    expect(()=>f.tx(store=>store.beginTurn(beginInput('same-pet')))).toThrow(/constraint/i);
    f.tx(store=>expect(store.beginTurn(beginInput('other-pet','pet-2'))).toBe('STARTED'));
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_turns').get().n).toBe(2);
  }));

  it('commits only exact one terminal with validated assistant data and does not duplicate candidate/proposal effects',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());const result=terminalWithCandidate();
      expect(store.finishTurn({...result,petId:'pet-2'})).toBe(false);
      expect(store.finishTurn(result)).toBe(true);expect(store.finishTurn(result)).toBe(false);expect(store.finishTurn(failed())).toBe(false);
      expect(store.getTurn('turn-1')).toMatchObject({status:'COMPLETED',terminalAt:NOW+10,emotion:'calm',motionIntent:'talk'});
      expect(store.lookupMessage('assistant-turn-1')).toMatchObject({status:'COMPLETED',text:'一起喝茶。'});
      expect(store.listPendingCandidates('pet-1',NOW+10)).toHaveLength(1);expect(store.listActionProposals('pet-1',NOW+10)).toHaveLength(1);
      expect(store.listMemoryRecords('pet-1')).toEqual([]); // no automatic confirmation
      expect(store.listPendingCandidates('pet-2',NOW+10)).toEqual([]);expect(store.listActionProposals('pet-2',NOW+10)).toEqual([]);});
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_proposal_ids').get().n).toBe(1);
  }));

  it('failed and cancelled terminal preserve user history and store only normalized error code, not provider detail',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());expect(store.finishTurn(failed())).toBe(true);
      expect(store.lookupMessage('assistant-turn-1')).toMatchObject({status:'FAILED',text:''});
      expect(store.getTurn('turn-1')).toMatchObject({status:'FAILED',errorCode:'NETWORK',emotion:null,usage:null});
      store.beginTurn(beginInput('turn-2','pet-1',NOW+20));expect(store.finishTurn(cancelled('turn-2','pet-1',NOW+30))).toBe(true);
      expect(store.lookupMessage('assistant-turn-2')).toMatchObject({status:'CANCELLED',text:''});
      expect(store.listRecentCompletedMessages('pet-1','conv-pet-1').map(msg=>msg.role)).toEqual(['USER','USER']);});
    expect(JSON.stringify(f.db.prepare('SELECT * FROM ai_turns').all())).not.toContain('private upstream detail');
  }));

  it('rolls back an invalid terminal that attempts to forge proposal/candidate identity or content',()=>withMemory(f=>{
    f.tx(store=>store.beginTurn(beginInput()));
    const mismatched=terminalWithCandidate();mismatched.proposals[0].petId='pet-2';
    expect(()=>f.tx(store=>store.finishTurn(mismatched))).toThrow();
    expect(()=>f.tx(store=>store.finishTurn(terminalWithCandidate('turn-1','pet-1',NOW+10,{sourceMessageIds:['assistant-turn-1']})))).toThrow(/source/i);
    expect(()=>f.tx(store=>store.finishTurn(terminalWithCandidate('turn-1','pet-1',NOW+10,{summary:'用户密码是秘密'})))).toThrow(/content/i);
    f.tx(store=>{expect(store.getTurn('turn-1').status).toBe('PENDING');expect(store.lookupMessage('assistant-turn-1').text).toBe('');expect(store.listPendingCandidates('pet-1',NOW+10)).toEqual([]);expect(store.finishTurn(failed())).toBe(true);});
  }));

  it('reopens real file with pending turn and marks it failed once, without re-playing a request',()=>{
    const directory=mkdtempSync(join(tmpdir(),'pet-ai-recovery-')),path=join(directory,'state.sqlite');let db=new DatabaseSync(path);
    try{db.exec('PRAGMA journal_mode=WAL');const f=prepare(db);f.tx(store=>store.beginTurn(beginInput()));db.close();
      db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');const reopened=wrap(db);
      reopened.tx(store=>{expect(store.getTurn('turn-1').status).toBe('PENDING');expect(store.recoverPendingTurns(NOW+100)).toBe(1);expect(store.recoverPendingTurns(NOW+101)).toBe(0);
        expect(store.lookupMessage('assistant-turn-1').status).toBe('FAILED');expect(store.beginTurn(beginInput())).toBe('DUPLICATE');
        expect(store.beginTurn(beginInput('fresh','pet-1',NOW+200))).toBe('STARTED');expect(store.finishTurn(failed('fresh','pet-1',NOW+201))).toBe(true);});
      expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    }finally{db.close();rmSync(directory,{recursive:true,force:true});}
  });

  it('prevents completing an in-flight turn after explicit provider reassignment/revocation',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());store.clearPetProviderAssignment('pet-1');});
    expect(()=>f.tx(store=>store.finishTurn(complete()))).toThrow(/consent changed/);
    f.tx(store=>expect(store.finishTurn(cancelled())).toBe(true));
  }));

  it('rejects invented recent history and obsolete text; uses immutable source revision after an accepted start',()=>withMemory(f=>{
    createCandidate(f);const input=beginInput('turn-2','pet-1',NOW+100);
    const history=f.tx(store=>store.listRecentCompletedMessages('pet-1','conv-pet-1'));
    input.turn.context.recentMessages=[{messageId:'invented',petId:'pet-1',conversationId:'conv-pet-1',role:'USER',text:'假历史',createdAt:NOW}];
    expect(()=>f.tx(store=>store.beginTurn(input))).toThrow(/history projection is stale/);
    input.turn.context.recentMessages=history.map(({messageId,petId,conversationId,role,text,createdAt})=>({messageId,petId,conversationId,role,text,createdAt}));
    input.turn.context.recentMessages[0].text='假的';
    expect(()=>f.tx(store=>store.beginTurn(input))).toThrow(/history projection is stale/);
    input.turn.context.recentMessages[0].text=history[0].text;
    f.tx(store=>{expect(store.beginTurn(input)).toBe('STARTED');store.editUserMessage('pet-1','conv-pet-1','user-turn-1','改为咖啡',NOW+101);});
    expect(()=>f.db.exec("UPDATE ai_turn_sources SET source_revision=1 WHERE request_id='turn-2' AND message_id='user-turn-1'")).toThrow(/immutable/);
    expect(()=>f.tx(store=>store.finishTurn(complete('turn-2','pet-1',NOW+102)))).toThrow(/source changed/);
    f.tx(store=>expect(store.finishTurn(failed('turn-2','pet-1',NOW+103))).toBe(true));
  }));

  it('internal proactive turns have no synthetic user message and may not create pending actions or memories',()=>withMemory(f=>{
    const input=beginInput();Object.assign(input.turn,{trigger:'PROACTIVE',userMessageId:null,userText:null});
    f.tx(store=>{expect(store.beginTurn(input)).toBe('STARTED');
      expect(store.listMessages('pet-1','conv-pet-1')).toMatchObject([{role:'ASSISTANT',status:'PENDING'}]);});
    expect(()=>f.tx(store=>store.finishTurn(terminalWithCandidate()))).toThrow(/contradicts validated pending records/);
    f.tx(store=>{expect(store.finishTurn(complete())).toBe(true);expect(store.lookupMessage('user-turn-1')).toBeNull();
      expect(store.listPendingCandidates('pet-1',NOW+11)).toEqual([]);expect(store.listActionProposals('pet-1',NOW+11)).toEqual([]);});
  }));

  it('cannot rewrite a terminal or move a message and protects globally unique request/message identity',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());expect(store.finishTurn(complete())).toBe(true);});
    expect(()=>f.db.exec("UPDATE ai_turns SET motion_intent='idle' WHERE request_id='turn-1'")).toThrow(/immutable/);
    expect(()=>f.db.exec("DELETE FROM ai_turns WHERE request_id='turn-1'")).toThrow(/immutable/);
    expect(()=>f.db.exec("UPDATE ai_messages SET pet_id='pet-2' WHERE message_id='user-turn-1'")).toThrow(/identity/);
    const input=beginInput('new-turn','pet-2',NOW+100,{assistantMessageId:'assistant-turn-1'});
    expect(()=>f.tx(store=>store.beginTurn(input))).toThrow(/constraint/i);
    f.tx(store=>{expect(store.getTurn('new-turn')).toBeNull();expect(store.listMessages('pet-2','conv-pet-2')).toEqual([]);});
  }));
});

describe('pending candidates, confirmed memories and explicit per-pet grants',()=>{
  it('indexes only confirmed memory, backfills existing rows and synchronizes edits and source revocation transactionally', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const f = prepare(db, false);
      createCandidate(f);
      f.tx(store => {
        expect(store.confirmMemory('pet-1', 'candidate-turn-1', 'memory-tea', NOW + 10, {
          kind: 'CONFIRM', scope: 'SHARED', recipientPetIds: ['pet-2'], editedSummary: '用户喜欢茉莉花茶',
        }).ok).toBe(true);
      });
      createCandidate(f, 'turn-pending', 'pet-1', NOW + 100);
      db.exec(AI_MEMORY_FTS_MIGRATION_SQL);
      verifyMemorySearchIndex(db, true);
      const matches = text => db.prepare('SELECT rowid,search_text FROM ai_memory_fts WHERE ai_memory_fts MATCH ?').all(`"${text}"`);
      expect(matches('茉莉花')).toMatchObject([{ search_text: null }]);
      expect(db.prepare('SELECT count(*) AS n FROM ai_memory_search_keys').get().n).toBe(1);
      f.tx(store => {
        const at = NOW + 105;
        expect(store.retrieveMemories('pet-1', '茉莉花茶', at)).toMatchObject([{ memoryId: 'memory-tea' }]);
        expect(store.retrieveMemories('pet-2', '花茶', at)).toMatchObject([{ memoryId: 'memory-tea' }]);
        expect(store.retrieveMemories('pet-3', '茉莉花茶', at)).toEqual([]);
        expect(store.retrieveMemories('pet-3', '" OR NEAR(茉莉花茶)', at)).toEqual([]);
        expect(store.editMemory('pet-1', 'memory-tea', {
          kind: 'EDIT', scope: 'SHARED', recipientPetIds: ['pet-2'], summary: '用户喜欢乌龙岩茶', expiresAt: null, pinned: false,
        }, at)).toMatchObject({ summary: '用户喜欢乌龙岩茶' });
        expect(matches('茉莉花')).toEqual([]);
        expect(matches('乌龙岩')).toHaveLength(1);
        expect(store.revokeMemoryGrant('pet-1', 'memory-tea', 'pet-2', at + 1)).toBe(true);
        expect(store.retrieveMemories('pet-2', '乌龙岩茶', at + 1)).toEqual([]);
        expect(store.editUserMessage('pet-1', 'conv-pet-1', 'user-turn-1', '我改变了偏好', at + 2)).toBe(true);
        expect(matches('乌龙岩')).toEqual([]);
      });
      verifyMemorySearchIndex(db, true);
      expect(db.prepare('SELECT count(*) AS n FROM ai_memory_search_keys').get().n).toBe(0);
    } finally { db.close(); }
  });

  it('recalls a matching authorized older fact beyond the bounded recent-candidate window', () => withMemory(f => {
    createCandidate(f);
    f.tx(store => {
      expect(store.confirmMemory('pet-1', 'candidate-turn-1', 'older-tea', NOW + 10, {
        kind: 'CONFIRM', scope: 'PRIVATE', editedSummary: '用户喜欢茉莉花茶',
      }).ok).toBe(true);
      const cap = memoryPolicyLimits.recordsToConsider;
      f.db.prepare(`WITH RECURSIVE fixtures(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixtures WHERE n<?)
        INSERT INTO ai_memory_ids(memory_id) SELECT 'search-fixture-'||n FROM fixtures`).run(cap);
      f.db.prepare(`INSERT INTO ai_memories(memory_id,owner_pet_id,source_conversation_id,scope,type,summary,confidence,created_at,updated_at,pinned)
        SELECT memory_id,'pet-1','conv-pet-1','PRIVATE','HISTORY','阅读训练记录',1,?,?,0
        FROM ai_memory_ids WHERE memory_id LIKE 'search-fixture-%'`).run(NOW + 11, NOW + 11);
      f.db.exec(`INSERT INTO ai_memory_sources(memory_id,message_id,source_revision)
        SELECT memory_id,'user-turn-1',0 FROM ai_memories WHERE memory_id LIKE 'search-fixture-%'`);
      expect(store.retrieveMemories('pet-1', '茉莉花茶', NOW + 12)).toMatchObject([{ memoryId: 'older-tea' }]);
      expect(store.retrieveMemories('pet-2', '茉莉花茶', NOW + 12)).toEqual([]);
    });
  }));

  it('only accepts actual USER source; confirmation creates private fact only via explicit operation',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>{expect(store.getPendingCandidate('pet-2','candidate-turn-1')).toBeNull();
      expect(store.confirmMemory('pet-2','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'PRIVATE'})).toEqual({ok:false,reason:'NOT_FOUND'});
      const result=store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'PRIVATE',pinned:true});expect(result.ok).toBe(true);
      expect(store.listMemoryRecords('pet-1')).toMatchObject([{memoryId:'memory-a',scope:'PRIVATE',consentState:'CONFIRMED',pinned:true}]);
      expect(store.retrieveMemories('pet-1','茶',NOW+101)).toMatchObject([{memoryId:'memory-a',scope:'PRIVATE',ownerPetId:'pet-1',recipientPetId:'pet-1'}]);
      expect(store.retrieveMemories('pet-2','茶',NOW+101)).toEqual([]);expect(store.listPendingCandidates('pet-1',NOW+101)).toEqual([]);
      expect(store.confirmMemory('pet-1','candidate-turn-1','memory-duplicate',NOW+101,{kind:'CONFIRM',scope:'PRIVATE'})).toEqual({ok:false,reason:'NOT_FOUND'});});
  }));

  it('shared model suggestion never grants until explicit recipient list and no raw source leaks across pets',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());store.finishTurn(terminalWithCandidate('turn-1','pet-1',NOW+10,{scope:'SHARED'}));
      expect(store.retrieveMemories('pet-2','茶',NOW+20)).toEqual([]);
      expect(store.confirmMemory('pet-1','candidate-turn-1','memory-shared',NOW+100,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-99']}).ok).toBe(false);
      const result=store.confirmMemory('pet-1','candidate-turn-1','memory-shared',NOW+100,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']});expect(result.ok).toBe(true);
      const projected=store.retrieveMemories('pet-2','茶',NOW+101);expect(projected).toHaveLength(1);
      expect(projected[0]).toEqual({memoryId:'memory-shared',ownerPetId:'pet-1',recipientPetId:'pet-2',scope:'SHARED',type:'PREFERENCE',summary:'用户喜欢茶',consentState:'CONFIRMED'});
      expect(projected[0]).not.toHaveProperty('sourceMessageIds');expect(store.retrieveMemories('pet-3','茶',NOW+101)).toEqual([]);
      expect(store.listMemoryRecords('pet-2')).toEqual([]); // management owner-only
      expect(store.revokeMemoryGrant('pet-2','memory-shared','pet-2',NOW+102)).toBe(false);
      expect(store.revokeMemoryGrant('pet-1','memory-shared','pet-2',NOW+102)).toBe(true);
      expect(store.retrieveMemories('pet-2','茶',NOW+103)).toEqual([]);expect(store.getMemoryRecord('pet-1','memory-shared').scope).toBe('PRIVATE');});
  }));

  it('memory edit uses owner-only explicit scope and rejects sensitive content; deleting cascades grants and preserves identity tombstone',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>{store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'PRIVATE'});
      expect(store.editMemory('pet-2','memory-a',{kind:'EDIT',scope:'PRIVATE',summary:'偷改',expiresAt:null,pinned:false},NOW+110)).toBeNull();
      expect(()=>store.editMemory('pet-1','memory-a',{kind:'EDIT',scope:'PRIVATE',summary:'用户密码',expiresAt:null,pinned:false},NOW+110)).toThrow();
      expect(store.editMemory('pet-1','memory-a',{kind:'EDIT',scope:'SHARED',summary:'用户喜欢红茶',expiresAt:NOW+1000,pinned:true,recipientPetIds:['pet-2','pet-3']},NOW+110)).toMatchObject({scope:'SHARED',recipientPetIds:['pet-2','pet-3'],summary:'用户喜欢红茶'});
      expect(store.retrieveMemories('pet-3','红茶',NOW+111)).toHaveLength(1);expect(store.retrieveMemories('pet-3','红茶',NOW+1000)).toEqual([]);
      expect(store.deleteMemory('pet-1','memory-a')).toBe(true);expect(store.retrieveMemories('pet-2','茶',NOW+120)).toEqual([]);});
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_memory_grants').get().n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_memory_ids').get().n).toBe(1);
  }));

  it('rejects expired candidates, mismatched permissions and malformed confirmations without promoting them',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>{
      expect(store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100010,{kind:'CONFIRM',scope:'PRIVATE'}).ok).toBe(false);
      expect(store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-1']}).ok).toBe(false);
      expect(store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'PRIVATE',editedSummary:'用户电话号码'}).ok).toBe(false);
      expect(store.listMemoryRecords('pet-1')).toEqual([]);expect(store.rejectCandidate('pet-2','candidate-turn-1')).toBe(false);expect(store.rejectCandidate('pet-1','candidate-turn-1')).toBe(true);});
  }));

  it('source edit/delete immediately invalidates pending and confirmed memory plus granted retrieval; message/turn identity remains',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>{store.confirmMemory('pet-1','candidate-turn-1','memory-a',NOW+100,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']});});
    createCandidate(f,'turn-2','pet-1',NOW+200);
    f.tx(store=>{expect(store.editUserMessage('pet-2','conv-pet-2','user-turn-1','篡改',NOW+300)).toBe(false);
      expect(store.editUserMessage('pet-1','conv-pet-1','user-turn-1','我喜欢咖啡',NOW+300)).toBe(true);
      expect(store.getMemoryRecord('pet-1','memory-a')).toBeNull();expect(store.retrieveMemories('pet-2','茶',NOW+301)).toEqual([]);
      expect(store.deleteMessage('pet-1','conv-pet-1','user-turn-2',NOW+301)).toBe(true);
      expect(store.getPendingCandidate('pet-1','candidate-turn-2')).toBeNull();expect(store.lookupMessage('user-turn-2')).toBeNull();
      expect(store.getTurn('turn-2').status).toBe('COMPLETED');expect(store.beginTurn(beginInput('turn-2'))).toBe('DUPLICATE');});
    expect(f.db.prepare("SELECT text,deleted_at FROM ai_messages WHERE message_id='user-turn-2'").get()).toEqual({text:'',deleted_at:NOW+301});
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_memory_grants').get().n).toBe(0);
  }));

  it('late successful output from edited/deleted in-flight source is refused, then failure can close pending',()=>withMemory(f=>{
    f.tx(store=>{store.beginTurn(beginInput());store.editUserMessage('pet-1','conv-pet-1','user-turn-1','我改主意了',NOW+5);});
    expect(()=>f.tx(store=>store.finishTurn(complete()))).toThrow(/source changed/);
    f.tx(store=>{expect(store.finishTurn(failed())).toBe(true);store.beginTurn(beginInput('turn-2','pet-1',NOW+20));store.deleteMessage('pet-1','conv-pet-1','user-turn-2',NOW+21);});
    expect(()=>f.tx(store=>store.finishTurn(complete('turn-2','pet-1',NOW+30)))).toThrow(/source changed/);
    f.tx(store=>expect(store.finishTurn(cancelled('turn-2','pet-1',NOW+31))).toBe(true));
  }));

  it('authorized memories projected into a turn are true exact records with current grants; revocation while generating invalidates terminal',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>store.confirmMemory('pet-1','candidate-turn-1','mem-shared',NOW+100,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']}));
    const turn=beginInput('turn-2','pet-2',NOW+200);const actual=f.tx(store=>store.retrieveMemories('pet-2','茶',NOW+200));
    turn.turn.context.authorizedMemories=actual.map(value=>({...value,summary:'伪造偏好'}));
    expect(()=>f.tx(store=>store.beginTurn(turn))).toThrow(/projection is stale/);
    f.tx(store=>{turn.turn.context.authorizedMemories=actual;expect(store.beginTurn(turn)).toBe('STARTED');store.revokeMemoryGrant('pet-1','mem-shared','pet-2',NOW+201);});
    expect(()=>f.tx(store=>store.finishTurn(complete('turn-2','pet-2',NOW+210)))).toThrow(/grant changed/);
    f.tx(store=>expect(store.finishTurn(failed('turn-2','pet-2',NOW+211))).toBe(true));
  }));

  it('cannot resurrect forgotten memory using the same ID; reissued candidate and proposal IDs rollback whole terminal',()=>withMemory(f=>{
    createCandidate(f);f.tx(store=>{store.confirmMemory('pet-1','candidate-turn-1','same-memory',NOW+10,{kind:'CONFIRM',scope:'PRIVATE'});
      expect(store.deleteMemory('pet-1','same-memory')).toBe(true);expect(store.deleteActionProposal('pet-1','proposal-turn-1')).toBe(true);});
    expect(()=>f.db.exec("DELETE FROM ai_memory_ids WHERE memory_id='same-memory'")).toThrow(/immutable/);
    const input=beginInput('turn-2','pet-1',NOW+100);f.tx(store=>store.beginTurn(input));
    const repeated=terminalWithCandidate('turn-2','pet-1',NOW+110,{candidateId:'candidate-turn-1'});
    expect(()=>f.tx(store=>store.finishTurn(repeated))).toThrow(/constraint/i);
    const next=terminalWithCandidate('turn-2','pet-1',NOW+110);next.proposals[0].proposalId='proposal-turn-1';
    expect(()=>f.tx(store=>store.finishTurn(next))).toThrow(/constraint/i);
    f.tx(store=>expect(store.finishTurn(terminalWithCandidate('turn-2','pet-1',NOW+110))).toBe(true));
    expect(()=>f.tx(store=>store.confirmMemory('pet-1','candidate-turn-2','same-memory',NOW+120,{kind:'CONFIRM',scope:'PRIVATE'}))).toThrow(/constraint/i);
    f.tx(store=>expect(store.confirmMemory('pet-1','candidate-turn-2','fresh-memory',NOW+120,{kind:'CONFIRM',scope:'PRIVATE'}).ok).toBe(true));
  }));

  it('clear owner memories/candidates cascades only those grants, not other pet conversations or records',()=>withMemory(f=>{
    createCandidate(f);createCandidate(f,'turn-2','pet-2',NOW+100);createCandidate(f,'turn-3','pet-1',NOW+200);
    f.tx(store=>{
      store.confirmMemory('pet-1','candidate-turn-1','mem-a',NOW+300,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']});
      store.confirmMemory('pet-2','candidate-turn-2','mem-b',NOW+300,{kind:'CONFIRM',scope:'PRIVATE',editedSummary:'用户喜欢喝绿茶'});
      expect(store.retrieveMemories('pet-2','茶',NOW+301)).toHaveLength(2);
      expect(store.clearMemories('pet-1')).toBe(2);expect(store.clearMemories('pet-1')).toBe(0);
      expect(store.retrieveMemories('pet-2','茶',NOW+302)).toMatchObject([{memoryId:'mem-b'}]);
      expect(store.listMessages('pet-1','conv-pet-1')).toHaveLength(4);expect(store.listMessages('pet-2','conv-pet-2')).toHaveLength(2);
      expect(()=>store.listMemoryRecords('pet-2',101)).toThrow(/page/);expect(()=>store.retrieveMemories('pet-2','茶',NOW+302,100)).toThrow(/bounded/);
    });
  }));
});
