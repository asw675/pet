import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AiAuthorityService } from '../src/ai-authority-service.ts';
import { AI_MEMORY_FTS_MIGRATION_SQL, AI_STATE_MIGRATION_SQL, AiStateStorage } from '../src/ai-state-storage.ts';
import { WORKSPACE_MIGRATION_SQL, WorkspaceStorage } from '../src/workspace-storage.ts';

const NOW=1000;
const mock={providerId:'mock-one',endpointKind:'MOCK',privacyBoundary:'MOCK',baseUrl:null,modelId:'mock',credentialRef:null,
  capabilities:{streamText:true,nativeStructured:true,jsonMode:true,usage:false,embeddings:false},maxContextTokens:8000,maxOutputTokens:400,timeoutMs:30000};
const cloud={...mock,providerId:'cloud-one',endpointKind:'OPENAI_COMPATIBLE',privacyBoundary:'CLOUD',baseUrl:'https://configured.example/v1',
  modelId:'chosen-model',credentialRef:'credential:chosen'};
const pet=(petId,characterId,nickname)=>({petId,characterId,nickname,presence:'HOME',activity:'IDLE',mood:'CALM',healthStatus:'NORMAL',visibility:'VISIBLE',
  moodScore:50,healthPoints:100,energy:90,bond:20,level:1,xp:0,revision:2});
const initialSnapshot=()=>({revision:5,primaryPetId:'pet-1',walletCoins:987,doNotDisturb:false,pausedRender:false,pets:[
  pet('pet-1','star-singer','星咏1'),pet('pet-2','fluffy-ranger','绒绒2'),pet('pet-3','nova','诺瓦3'),pet('pet-4','star-singer','角色4'),
]});
const basicReply={text:'一起喝茶吧！',emotion:'happy',motionIntent:'talk',actionProposals:[],memoryCandidates:[]};
const fields=({requestId,petId,conversationId})=>({requestId,petId,conversationId});
const terminal=(start,at=NOW+10,reply=basicReply,proposals=[],memoryCandidates=[])=>({...fields(start.turn),kind:'COMPLETED',completedAt:at,reply,usage:null,proposals,memoryCandidates});
const failed=(start,at=NOW+11)=>({...fields(start.turn),kind:'FAILED',completedAt:at,error:{code:'UNAVAILABLE',message:'Safe public error',retryable:true}});
const intent=(conversation,requestId='request-1',userText='我喜欢茶。')=>({petId:conversation.petId,conversationId:conversation.conversationId,requestId,trigger:'USER',userText});

function withFixture(action){
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE pets(pet_id TEXT PRIMARY KEY) STRICT; INSERT INTO pets VALUES('pet-1'),('pet-2'),('pet-3'),('pet-4'); CREATE TABLE wallet(coins INTEGER); INSERT INTO wallet VALUES(987);");
    db.exec(AI_STATE_MIGRATION_SQL);
    db.exec(AI_MEMORY_FTS_MIGRATION_SQL);
    db.exec(WORKSPACE_MIGRATION_SQL);
    let serial=0, active=false;
    const state={snapshot:initialSnapshot(),events:[],contextReadCount:0};
    const workspace = () => new WorkspaceStorage(db, () => active);
    const game={snapshot:()=>{if(!active)throw new Error('Game projection outside transaction');state.contextReadCount++;return structuredClone(state.snapshot);},
      quickActions: at => workspace().listAiActionBindings(at),
      recentEvents:petId=>{if(!active)throw new Error('Unsafe event lookup');return state.events.filter(event=>event.petId===petId);}};
    const transaction=fn=>{expect(active).toBe(false);db.exec('BEGIN IMMEDIATE');active=true;
      try{const value=fn(new AiStateStorage(db,()=>active),game);active=false;db.exec('COMMIT');return value;}
      catch(error){active=false;db.exec('ROLLBACK');throw error;}};
    const service=new AiAuthorityService({transaction,createId:kind=>`${kind}-${++serial}`});
    const f={service,state,db,transaction,workspace: run => transaction(() => run(workspace())),conv1:service.createConversation({petId:'pet-1',title:'对话一'},0),conv2:service.createConversation({petId:'pet-2',title:'对话二'},0)};
    return action(f);
  }finally{db.close();}
}
function assignMock(f,petId='pet-1',at=10) {
  const cfg=f.service.saveProviderConfig(mock,f.service.listProviderConfigs().find(record=>record.config.providerId===mock.providerId)?.revision??null,at);
  return f.service.assignProvider({petId,providerId:mock.providerId,providerRevision:cfg.revision,allowCloudContext:false},at);
}
function assignCloud(f,petId='pet-1',at=10) {
  const cfg=f.service.saveProviderConfig(cloud,f.service.listProviderConfigs().find(record=>record.config.providerId===cloud.providerId)?.revision??null,at);
  return f.service.assignProvider({petId,providerId:cloud.providerId,providerRevision:cfg.revision,allowCloudContext:true},at);
}
function start(f,conversation=f.conv1,requestId='request-1',at=NOW,userText='我喜欢茶。'){
  const result=f.service.beginTurn(intent(conversation,requestId,userText),at);
  expect(result.kind).toBe('STARTED');return result;
}
function proposalTerminal(start,targets,at=NOW+10){
  const proposals=targets.map((draft,index)=>({...fields(start.turn),...draft,proposalId:`proposal-${start.turn.requestId}-${index}`,confirmationRequired:true,expiresAt:at+60000}));
  return terminal(start,at,{...basicReply,actionProposals:targets},proposals);
}
function withCandidate(start,scope='PRIVATE',at=NOW+10){
  const draft={scope,type:'PREFERENCE',summary:'用户喜欢茶',sourceMessageIds:[start.turn.userMessageId],confidence:0.9};
  const bound={...draft,candidateId:`candidate-${start.turn.requestId}`,requestId:start.turn.requestId,ownerPetId:start.turn.petId,
    conversationId:start.turn.conversationId,createdAt:at,expiresAt:at+100000,consentState:'PENDING'};
  return terminal(start,at,{...basicReply,memoryCandidates:[draft]},[],[bound]);
}

describe('authoritative read-only chat projection, identity and provider selection',()=>{
  it('does not implicitly initialize or select mock/cloud without explicit trusted settings action',()=>withFixture(f=>{
    expect(f.service.listProviderConfigs()).toEqual([]);
    expect(f.service.beginTurn(intent(f.conv1),NOW)).toMatchObject({kind:'REJECTED',error:{code:'AUTH_REQUIRED'}});
    f.service.saveProviderConfig(mock,null,10);
    expect(f.service.getProviderAssignment('pet-1')).toBeNull();
    expect(f.service.beginTurn(intent(f.conv1),NOW)).toMatchObject({kind:'REJECTED',error:{code:'AUTH_REQUIRED'}});
    expect(f.service.listMessages('pet-1',f.conv1.conversationId)).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) n FROM ai_turns').get().n).toBe(0);
  }));
  it('requires current owned pet and strict conversation identity; no renderer context or provider overrides',()=>withFixture(f=>{
    assignMock(f);expect(f.service.listConversations('pet-1')).toEqual([f.conv1]);
    expect(()=>f.service.createConversation({petId:'unknown-pet',title:'非法'},20)).toThrow();
    expect(()=>f.service.createConversation({petId:'pet-1',title:' '},20)).toThrow();
    expect(f.service.beginTurn({...intent(f.conv2),petId:'pet-1'},NOW)).toMatchObject({kind:'REJECTED'});
    for(const extra of [{context:{}},{providerId:'cloud-one'},{userMessageId:'foreign'},{userText:' '},{trigger:'SUMMARY'}])
      expect(f.service.beginTurn({...intent(f.conv1),...extra},NOW)).toMatchObject({kind:'REJECTED',error:{code:'UNSUPPORTED'}});
    expect(f.service.listMessages('pet-1',f.conv1.conversationId)).toEqual([]);
  }));
  it('projects catalog persona + exact current game values, only the same pet events, no wallet or third-party raw state',()=>withFixture(f=>{
    assignMock(f);f.state.events=[{eventId:'event-1',petId:'pet-1',type:'TRIP_RETURNED',occurredAt:900,summary:'回家了'},
      {eventId:'event-2',petId:'pet-2',type:'TRIP_RETURNED',occurredAt:900,summary:'另一个角色'}];
    const result=start(f);
    expect(result).toMatchObject({kind:'STARTED',providerId:mock.providerId,providerRevision:1,turn:{snapshotRevision:5,personaRevision:1,deadline:NOW+mock.timeoutMs,
      context:{persona:{characterId:'star-singer',displayName:'星咏'},game:{petId:'pet-1',nickname:'星咏1',energy:90,bond:20,level:1,petRevision:2,recentEvents:[f.state.events[0]]}}}});
    expect(result.turn.context.game).not.toHaveProperty('walletCoins');
    expect(JSON.stringify(result.turn)).not.toContain('另一个角色');expect(JSON.stringify(result.turn)).not.toContain('绒绒2');
    expect(f.service.listMessages('pet-1',f.conv1.conversationId)).toMatchObject([{role:'USER',text:'我喜欢茶。',status:'COMPLETED'},{role:'ASSISTANT',status:'PENDING',text:''}]);
    expect(f.service.listMessages('pet-2',f.conv1.conversationId)).toEqual([]);
    expect(f.service.finishTurn(terminal(result))).toBe(true);
    expect(f.db.prepare('SELECT coins FROM wallet').get().coins).toBe(987);
  }));
  it('rejects unknown legacy character rather than fabricating personality or selecting another pet',()=>withFixture(f=>{
    assignMock(f);f.state.snapshot.pets[0].characterId='legacy-character';
    expect(f.service.beginTurn(intent(f.conv1),NOW)).toMatchObject({kind:'REJECTED',error:{code:'UNSUPPORTED'}});
  }));
  it('only permits exact cloud consent from explicit settings and refuses old config revision after edits',()=>withFixture(f=>{
    f.service.saveProviderConfig(cloud,null,10);
    expect(()=>f.service.assignProvider({petId:'pet-1',providerId:cloud.providerId,providerRevision:1,allowCloudContext:false},20)).toThrow(/consent/i);
    expect(()=>f.service.assignProvider({petId:'pet-1',providerId:cloud.providerId,providerRevision:1,allowCloudContext:true,consentRef:'forged'},20)).toThrow();
    const assigned=assignCloud(f,'pet-1',20);
    expect(assigned.assignment.consentRef).toMatch(/^consent:/);
    const begun=start(f);expect(begun.providerRevision).toBe(1);
    expect(f.service.resolveTurnProvider(begun.turn,cloud.providerId,1,NOW+1).config).toEqual(cloud);
    const changed=f.service.saveProviderConfig({...cloud,modelId:'different-model'},1,NOW+2);
    expect(changed.revision).toBe(2);expect(f.service.getProviderAssignment('pet-1')).toBeNull();
    expect(f.service.resolveTurnProvider(begun.turn,cloud.providerId,1,NOW+3)).toBeNull();
    expect(f.service.resolveTurnProvider(begun.turn,cloud.providerId,2,NOW+3)).toBeNull();
    expect(()=>f.service.finishTurn(terminal(begun))).toThrow(/no longer authorized/);
    expect(f.service.finishTurn(failed(begun))).toBe(true);
  }));
  it('revocation/reconsent with unchanged provider rev invalidates pending assignment even at same timestamp',()=>withFixture(f=>{
    const previous=assignCloud(f);const begun=start(f);expect(f.service.clearProviderAssignment('pet-1')).toBe(true);
    expect(f.service.resolveTurnProvider(begun.turn,cloud.providerId,1,NOW)).toBeNull();
    const next=assignCloud(f,'pet-1',10);
    expect(next.assignment.consentRef).not.toBe(previous.assignment.consentRef);
    expect(f.service.resolveTurnProvider(begun.turn,cloud.providerId,1,NOW)).toBeNull();
    expect(f.service.finishTurn(failed(begun))).toBe(true);
  }));
  it('blocks duplicate request, same pet parallel, global limit and never uses nonselected provider',()=>withFixture(f=>{
    for(const petId of ['pet-1','pet-2','pet-3','pet-4'])assignMock(f,petId);
    const conv3=f.service.createConversation({petId:'pet-3',title:'第三'},0),conv4=f.service.createConversation({petId:'pet-4',title:'第四'},0);
    const first=start(f);expect(f.service.beginTurn(intent(f.conv1),NOW)).toEqual({kind:'DUPLICATE'});
    expect(f.service.beginTurn(intent(f.conv2),NOW)).toEqual({kind:'DUPLICATE'});
    expect(f.service.beginTurn(intent(f.conv1,'other'),NOW)).toMatchObject({kind:'REJECTED'});
    start(f,f.conv2,'request-2');start(f,conv3,'request-3');
    expect(f.service.beginTurn(intent(conv4,'request-4'),NOW)).toMatchObject({kind:'REJECTED'});
    expect(f.service.resolveTurnProvider(first.turn,'other-provider',1,NOW)).toBeNull();
    expect(f.service.finishTurn(terminal(first))).toBe(true);expect(start(f,conv4,'request-4',NOW+20).kind).toBe('STARTED');
  }));
  it('startup recovery closes durable pending once and allows a fresh request without replaying original',()=>withFixture(f=>{
    assignMock(f);const begun=start(f);expect(f.service.recoverPendingTurns(NOW+50)).toBe(1);expect(f.service.recoverPendingTurns(NOW+51)).toBe(0);
    expect(f.service.finishTurn(terminal(begun))).toBe(false);
    expect(f.service.beginTurn(intent(f.conv1),NOW+100)).toEqual({kind:'DUPLICATE'});
    expect(start(f,f.conv1,'new-request',NOW+100).kind).toBe('STARTED');
  }));
});
describe('live authority revisions, permitted suggestions and explicit memories',()=>{
  it('keeps harmless snapshot ticks but refuses stale character identity before send/terminal',()=>withFixture(f=>{
    assignMock(f);const begun=start(f);
    f.state.snapshot.revision+=1;f.state.snapshot.pets[0].energy=88;
    expect(f.service.resolveTurnProvider(begun.turn,mock.providerId,1,NOW+1)).not.toBeNull();
    expect(f.service.finishTurn(terminal(begun))).toBe(true);
    const next=start(f,f.conv1,'next',NOW+20);f.state.snapshot.pets[0].characterId='nova';
    expect(f.service.resolveTurnProvider(next.turn,mock.providerId,1,NOW+21)).toBeNull();
    expect(()=>f.service.finishTurn(terminal(next,NOW+22))).toThrow(/no longer authorized/);
    expect(f.service.finishTurn(failed(next,NOW+23))).toBe(true);
  }));
  it('reads actual completed same-conversation history, and denies provider resolution after source edit or redaction',()=>withFixture(f=>{
    assignMock(f);assignMock(f,'pet-2');const first=start(f);
    f.service.finishTurn(terminal(first));const other=start(f,f.conv2,'other',NOW+20,'另一个人的对话');
    f.service.finishTurn(terminal(other,NOW+30));
    const next=start(f,f.conv1,'next',NOW+40);
    expect(next.turn.context.recentMessages).toMatchObject([{role:'USER',text:'我喜欢茶。'},{role:'ASSISTANT',text:basicReply.text}]);
    expect(JSON.stringify(next.turn)).not.toContain('另一个人的对话');
    expect(f.service.resolveTurnProvider(next.turn,mock.providerId,1,NOW+41)).not.toBeNull();
    expect(f.service.editUserMessage('pet-2',f.conv1.conversationId,first.turn.userMessageId,'伪造',NOW+42)).toBe(false);
    expect(f.service.editUserMessage('pet-1',f.conv1.conversationId,first.turn.userMessageId,'我喜欢咖啡',NOW+42)).toBe(true);
    expect(f.service.resolveTurnProvider(next.turn,mock.providerId,1,NOW+43)).toBeNull();
    expect(f.service.finishTurn(failed(next,NOW+44))).toBe(true);
  }));
  it('accepts inert self-rest / eligible known route proposals, denies OS quick ids and high level routes; no game effect',()=>withFixture(f=>{
    assignMock(f);const begun=start(f);
    const rest={type:'REST',targetId:'self',reason:'休息一下'},trip={type:'TRIP_SUGGESTION',targetId:'morning-dew-meadow',reason:'旅行'},
      action={type:'QUICK_ACTION_SUGGESTION',targetId:'editor',reason:'快捷启动'},high={...trip,targetId:'starfall-ruins'};
    expect(f.service.isProposalAllowed(begun.turn,rest)).toBe(true);
    expect(f.service.isProposalAllowed(begun.turn,{...rest,targetId:'pet-2'})).toBe(false);
    expect(f.service.isProposalAllowed(begun.turn,trip)).toBe(true);
    expect(f.service.isProposalAllowed(begun.turn,high)).toBe(false);
    expect(f.service.isProposalAllowed(begun.turn,action)).toBe(false);
    expect(f.service.isProposalAllowed(begun.turn,{...trip,targetId:'unknown-route'})).toBe(false);
    expect(()=>f.service.finishTurn(proposalTerminal(begun,[action]))).toThrow(/no longer allowed/);
    expect(f.service.finishTurn(proposalTerminal(begun,[rest,trip]))).toBe(true);
    expect(f.service.listActionProposals('pet-1',NOW+11)).toHaveLength(2);
    expect(f.service.listActionProposals('pet-2',NOW+11)).toEqual([]);
    expect(f.state.snapshot.pets[0].activity).toBe('IDLE');
    expect(f.state.snapshot.walletCoins).toBe(987);
    expect(f.service.dismissActionProposal('pet-2','proposal-request-1-0')).toBe(false);
    expect(f.service.dismissActionProposal('pet-1','proposal-request-1-0')).toBe(true);
    expect(f.service.listActionProposals('pet-1',NOW+60011)).toEqual([]);
  }));
  it('stores an opted-in shortcut version, rechecks revocation, and permits exactly one privileged consume', () => withFixture(f => {
    assignMock(f);
    const target = { kind: 'HTTPS', locator: 'https://example.com/tea', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://example.com/tea' } };
    f.workspace(store => store.addApprovedAction({ id: 'tea', target, label: '茶单', recommendable: true, approvedAt: 2, enabled: true }, 0));
    const draft = { type: 'QUICK_ACTION_SUGGESTION', targetId: 'tea', reason: '继续查看茶单' };
    function completeShortcut(turn, revision = 0, targetLabel = '茶单') {
      const proposal = { ...fields(turn.turn), ...draft, targetRevision: revision, targetLabel, proposalId: `proposal-${turn.turn.requestId}`,
        expiresAt: NOW + 2_000, confirmationRequired: true };
      expect(f.service.finishTurn(terminal(turn, NOW + 13, { ...basicReply, actionProposals: [draft] }, [proposal]))).toBe(true);
      return proposal;
    }
    const begun = start(f);
    const binding = { targetId: 'tea', label: '茶单', targetRevision: 0 };
    expect(begun.turn.context.quickActions).toEqual([binding]);
    expect(f.service.isProposalAllowed(begun.turn, draft, binding, NOW + 1)).toBe(true);
    expect(f.service.isProposalAllowed(begun.turn, draft, { ...binding, targetRevision: 1 }, NOW + 1)).toBe(false);
    const proposal = completeShortcut(begun);
    const at = NOW + 14;
    expect(f.service.resolveQuickProposal('pet-2', proposal.proposalId, at)).toBeNull();
    expect(f.service.resolveQuickProposal('pet-1', proposal.proposalId, proposal.expiresAt)).toBeNull();
    expect(f.service.resolveQuickProposal('pet-1', proposal.proposalId, at, { ...proposal, targetRevision: 1 })).toBeNull();
    expect(f.service.resolveQuickProposal('pet-1', proposal.proposalId, at)).toEqual(proposal);
    expect(f.service.resolveQuickProposal('pet-1', proposal.proposalId, at, proposal)).toEqual(proposal);
    expect(f.service.resolveQuickProposal('pet-1', proposal.proposalId, at, proposal)).toBeNull();

    const second = completeShortcut(start(f, f.conv1, 'revision', NOW + 11));
    f.workspace(store => store.updateActionMetadata('tea', 0, { label: '新茶单', recommendable: true, enabled: true }));
    expect(f.service.resolveQuickProposal('pet-1', second.proposalId, at)).toBeNull();
    expect(f.service.listActionProposals('pet-1', at)).toEqual([]);
    const thirdTurn = start(f, f.conv1, 'source', NOW + 12);
    const third = completeShortcut(thirdTurn, 1, '新茶单');
    expect(f.service.editUserMessage('pet-1', f.conv1.conversationId, thirdTurn.turn.userMessageId, '已经不想查看茶单。', at)).toBe(true);
    expect(f.service.resolveQuickProposal('pet-1', third.proposalId, at)).toBeNull();
    assignCloud(f, 'pet-2', NOW);
    expect(start(f, f.conv2, 'cloud-shortcut').turn.context).not.toHaveProperty('quickActions');
  }));
  it('rechecks proposal against game state at terminal and never authorizes unsupported motion or duplicate targets',()=>withFixture(f=>{
    assignMock(f);const begun=start(f),rest={type:'REST',targetId:'self',reason:'休息一下'};
    expect(f.service.isProposalAllowed(begun.turn,rest)).toBe(true);
    f.state.snapshot.pets[0].activity='DRAG';
    expect(f.service.isProposalAllowed(begun.turn,rest)).toBe(false);
    expect(()=>f.service.finishTurn(proposalTerminal(begun,[rest]))).toThrow(/no longer allowed/);
    f.state.snapshot.pets[0].activity='IDLE';
    expect(()=>f.service.finishTurn(terminal(begun,NOW+10,{...basicReply,motionIntent:'unsupported-motion'}))).toThrow(/motion/);
    expect(()=>f.service.finishTurn(proposalTerminal(begun,[rest,rest]))).toThrow(/no longer allowed/);
    expect(f.service.finishTurn(terminal(begun))).toBe(true);
    expect(f.service.listActionProposals('pet-1',NOW+11)).toEqual([]);
  }));
  it('local proactive only, requires visible HOME and DND off, never auto-cloud despite explicit user cloud consent',()=>withFixture(f=>{
    assignCloud(f);const proactive={...fields(intent(f.conv1)),trigger:'PROACTIVE',userText:null};
    expect(f.service.beginTurn(proactive,NOW)).toMatchObject({kind:'REJECTED'});
    assignMock(f,'pet-1',20);f.state.snapshot.doNotDisturb=true;
    expect(f.service.beginTurn(proactive,NOW)).toMatchObject({kind:'REJECTED'});
    f.state.snapshot.doNotDisturb=false;f.state.snapshot.pets[0].visibility='HIDDEN';
    expect(f.service.beginTurn(proactive,NOW)).toMatchObject({kind:'REJECTED'});
    f.state.snapshot.pets[0].visibility='VISIBLE';
    const begun=f.service.beginTurn(proactive,NOW);expect(begun).toMatchObject({kind:'STARTED',turn:{trigger:'PROACTIVE',userMessageId:null}});
    expect(f.service.isProposalAllowed(begun.turn,{type:'REST',targetId:'self',reason:'休息'})).toBe(false);
    f.state.snapshot.doNotDisturb=true;expect(f.service.resolveTurnProvider(begun.turn,mock.providerId,1,NOW+1)).toBeNull();
    expect(()=>f.service.finishTurn(terminal(begun))).toThrow(/no longer authorized/);
    expect(f.service.finishTurn(failed(begun))).toBe(true);
  }));
  it('only explicit owner confirmation can create a shared fact, recipient-level retrieval and revocation use actual sources',()=>withFixture(f=>{
    assignMock(f);assignMock(f,'pet-2');const begun=start(f);
    expect(f.service.finishTurn(withCandidate(begun,'SHARED'))).toBe(true);
    expect(f.service.listPendingCandidates('pet-1',NOW+11)).toHaveLength(1);
    expect(f.service.listMemoryRecords('pet-1')).toEqual([]);expect(f.service.retrieveMemories('pet-2','茶',NOW+11)).toEqual([]);
    const id='candidate-request-1';
    expect(f.service.confirmMemory('pet-2',id,{kind:'CONFIRM',scope:'PRIVATE'},NOW+20).ok).toBe(false);
    const confirmation=f.service.confirmMemory('pet-1',id,{kind:'CONFIRM',scope:'SHARED',recipientPetIds:['pet-2']},NOW+20);
    expect(confirmation.ok).toBe(true);
    const next=start(f,f.conv2,'other',NOW+30);
    expect(next.turn.context.authorizedMemories).toMatchObject([{memoryId:confirmation.record.memoryId,ownerPetId:'pet-1',recipientPetId:'pet-2',summary:'用户喜欢茶'}]);
    expect(next.turn.context.authorizedMemories[0]).not.toHaveProperty('sourceMessageIds');
    expect(f.service.revokeMemoryGrant('pet-1',confirmation.record.memoryId,'pet-2',NOW+31)).toBe(true);
    expect(f.service.resolveTurnProvider(next.turn,mock.providerId,1,NOW+32)).toBeNull();
    expect(f.service.retrieveMemories('pet-2','茶',NOW+32)).toEqual([]);
    expect(f.service.finishTurn(failed(next,NOW+33))).toBe(true);
    expect(f.service.deleteMessage('pet-1',f.conv1.conversationId,begun.turn.userMessageId,NOW+34)).toBe(true);
    expect(f.service.listMemoryRecords('pet-1')).toEqual([]);
  }));
});
