import { appSnapshotSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import {
  actionProposalDraftSchema, aiGameContextSchema, aiLimits, conversationSchema, personaContextSchema,
  providerConfigSchema, turnRequestSchema,
} from '@pet-desktop/contracts/ai';
import type {
  ActionProposalDraft, AiError, AiErrorCode, AiGameContext, Conversation, PersonaContext, ProviderConfig, TurnRequest,
} from '@pet-desktop/contracts/ai';
import { CHARACTER_CATALOG_VERSION, findCharacterDefinition } from '@pet-desktop/domain/character-catalog';
import { findRouteCatalogEntry } from '@pet-desktop/domain/route-catalog';
import type {
  AiChatTerminal, AiMemoryEdit, AiProviderRecord, AiStateStorage, AiTurnIdentity, AiTurnRecord,
} from './ai-state-storage.js';
import type { TrustedMemoryConfirmation } from './memory-policy.js';

/** Read-only, transaction-scoped trusted game projection. This adapter never
 * receives a renderer-supplied snapshot, coins, persona, target list or URL.
 * The application binds the projection to the same underlying transaction
 * as AiStateStorage. */
export interface AiAuthorityGameView {
  snapshot(): AppSnapshot;
  recentEvents?(petId: string): AiGameContext['recentEvents'];
}
export interface AiAuthorityServiceOptions {
  transaction<T>(run: (store: AiStateStorage, game: AiAuthorityGameView) => T): T;
  /** Supplied by the desktop runtime; production must allocate unique IDs. */
  createId: (kind: 'conversation' | 'user-message' | 'assistant-message' | 'memory' | 'consent') => string;
}

type AiUserTurnIntent = AiTurnIdentity & { trigger: 'USER'; userText: string };
type AiProactiveTurnIntent = AiTurnIdentity & { trigger: 'PROACTIVE'; userText: null };
export type AiAuthorityTurnIntent = AiUserTurnIntent | AiProactiveTurnIntent;
export type AiAuthorityBeginResult =
  | { kind: 'STARTED'; turn: TurnRequest; providerId: string; providerRevision: number }
  | { kind: 'DUPLICATE' }
  | { kind: 'REJECTED'; error: AiError };
export interface AiCreateConversationInput { petId: string; title: string }
export interface AiAssignProviderInput { petId: string; providerId: string; providerRevision: number; allowCloudContext: boolean }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MOTION_IDS = Object.freeze(['idle', 'talk', 'happy']); // safe subset of current builtin semantic actions
const MAX_PAGE = 50;
const PROPOSAL_TTL = 60_000;
const errors: Record<AiErrorCode, string> = {
  AUTH_REQUIRED: '请先为该桌宠选择 AI 服务并确认数据使用方式。',
  RATE_LIMITED: 'AI 服务暂时繁忙。', CONTEXT_LIMIT: '对话上下文超出限制。',
  TIMEOUT: 'AI 请求超时。', NETWORK: 'AI 服务暂时无法连接。',
  UNAVAILABLE: '当前无法开始此对话。', UNSUPPORTED: '不支持此操作。',
  INVALID_RESPONSE: 'AI 返回了无效内容。', REFUSED: 'AI 未能完成该回复。',
  TRUNCATED: 'AI 回复超出限制。', INTERNAL_ERROR: 'AI 服务内部错误。',
};

function rejected(code: AiErrorCode): AiAuthorityBeginResult {
  return { kind: 'REJECTED', error: { code, message: errors[code], retryable: ['UNAVAILABLE', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'INTERNAL_ERROR'].includes(code) } };
}
function id(raw: unknown): string {
  if (typeof raw !== 'string' || !ID.test(raw)) throw new Error('Invalid AI identity');
  return raw;
}
function time(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error('Invalid AI timestamp or revision');
  return raw;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid AI authority input');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record,key))) throw new Error('Invalid AI authority input fields');
  return record;
}
function identity(value: AiTurnIdentity): AiTurnIdentity {
  return { requestId: id(value.requestId), petId: id(value.petId), conversationId: id(value.conversationId) };
}
function sameIdentity(a: AiTurnIdentity,b: AiTurnIdentity): boolean {
  return a.requestId === b.requestId && a.petId === b.petId && a.conversationId === b.conversationId;
}
function parseIntent(raw: unknown): AiAuthorityTurnIntent {
  const input = closed(raw,['requestId','petId','conversationId','trigger','userText']);
  const fields = { requestId:id(input.requestId),petId:id(input.petId),conversationId:id(input.conversationId) };
  if (input.trigger === 'USER' && typeof input.userText === 'string' && input.userText.length <= aiLimits.userText && input.userText.trim().length > 0) {
    return { ...fields, trigger:'USER', userText:input.userText };
  }
  if (input.trigger === 'PROACTIVE' && input.userText === null) return { ...fields,trigger:'PROACTIVE',userText:null };
  throw new Error('Invalid AI user or internal proactive intent');
}
function getSnapshot(game: AiAuthorityGameView): AppSnapshot {
  return appSnapshotSchema.parse(game.snapshot());
}
function findPet(snapshot: AppSnapshot, petId: string): PetSnapshot | null {
  return snapshot.pets.find(pet => pet.petId === id(petId)) ?? null;
}
function requirePet(game: AiAuthorityGameView, petId: string): PetSnapshot {
  const pet = findPet(getSnapshot(game),petId);
  if (!pet) throw new Error('AI pet is not present in the authoritative save');
  return pet;
}
function personaFor(characterId: string): PersonaContext | null {
  const character = findCharacterDefinition(characterId);
  if (!character) return null;
  return personaContextSchema.parse({
    personaId:`persona-${character.characterId}`, characterId:character.characterId, revision:CHARACTER_CATALOG_VERSION,
    displayName:character.displayName, background:character.background, personality:{
      summary:character.personality.summary, traits:[...character.personality.traits], likes:[...character.personality.likes],
      speechStyle:character.personality.speechStyle,
    }, languageTag:'zh-CN', allowedMotionIds:[...MOTION_IDS],
  });
}
function gameContext(pet: PetSnapshot, view: AiAuthorityGameView, at: number): AiGameContext {
  // Only explicit projection fields enter inference; wallet, visibility,
  // other pets, OS data and save implementation keys are excluded.
  const recentEvents = view.recentEvents?.(pet.petId) ?? [];
  const context = aiGameContextSchema.parse({
    petId:pet.petId, characterId:pet.characterId, nickname:pet.nickname, petRevision:pet.revision, presence:pet.presence,
    activity:pet.activity, mood:pet.mood, healthStatus:pet.healthStatus, moodScore:pet.moodScore,
    healthPoints:pet.healthPoints, energy:pet.energy, bond:pet.bond, level:pet.level, xp:pet.xp,
    trip:pet.trip ?? null, recentEvents,
  });
  if (context.recentEvents.some(event => event.occurredAt > at)) throw new Error('AI event projection is from the future');
  return context;
}
function proactiveAllowed(snapshot: AppSnapshot, pet: PetSnapshot, config: ProviderConfig): boolean {
  // A chat-cloud assignment never implies unsolicited cloud transmission.
  // A dedicated opt-in policy would be needed for automatic remote context.
  return config.privacyBoundary !== 'CLOUD' && !snapshot.doNotDisturb && pet.visibility === 'VISIBLE'
    && pet.presence === 'HOME' && pet.activity !== 'CHAT' && pet.activity !== 'DRAG';
}
function currentPetForTurn(snapshot: AppSnapshot, turn: AiTurnRecord): PetSnapshot | null {
  const pet = findPet(snapshot,turn.petId), persona = pet ? personaFor(pet.characterId) : null;
  return pet && persona && pet.characterId === turn.characterId && persona.revision === turn.personaRevision ? pet : null;
}
function allowProposal(pet: PetSnapshot, draft: ActionProposalDraft): boolean {
  if (pet.presence !== 'HOME' || pet.activity === 'DRAG' || pet.activity === 'CHAT') return false;
  if (draft.type === 'REST') return draft.targetId === 'self';
  if (draft.type === 'TRIP_SUGGESTION') {
    const route = findRouteCatalogEntry(draft.targetId);
    // This is a suggestion, not a departure quote or entitlement. Supply
    // selection/availability and final eligibility remain the travel UI and
    // command authority's separate responsibility.
    return route !== undefined && pet.level >= route.minLevel && pet.energy * 10 + 1e-6 >= route.energyCost10
      && pet.healthStatus === 'NORMAL' && pet.healthPoints > 0;
  }
  // Workspace integration may later expose real selected IDs. Deny every
  // quick action until that separately trusted whitelist exists.
  return false;
}

/** Synchronous service. No provider network requests, credentials, effects or
 * DB transactions span an await. Renderer routes must expose only explicit
 * user operations; beginTurn PROACTIVE, lookupMessage, terminal and registry
 * resolution are internal trusted coordinator ports. */
export class AiAuthorityService {
  private readonly options: AiAuthorityServiceOptions;
  private readonly createId: AiAuthorityServiceOptions['createId'];
  constructor(options: AiAuthorityServiceOptions) {
    this.options=options; this.createId=options.createId;
  }
  private allocate(kind: Parameters<AiAuthorityServiceOptions['createId']>[0]): string {
    return id(this.createId(kind));
  }

  createConversation(raw: AiCreateConversationInput, at: number): Conversation {
    const input=closed(raw,['petId','title']), petId=id(input.petId), now=time(at);
    if(typeof input.title!=='string')throw new Error('Invalid conversation title');
    const title=input.title.trim();
    return this.options.transaction((store,game) => {
      requirePet(game,petId);
      const conversation=conversationSchema.parse({petId,conversationId:this.allocate('conversation'),title,createdAt:now,updatedAt:now});
      store.createConversation(conversation);return conversation;
    });
  }
  listConversations(petId: string,limit=MAX_PAGE,offset=0): Conversation[] {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.listConversations(petId,limit,offset);});
  }
  listMessages(petId:string,conversationId:string,limit=MAX_PAGE,offset=0) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.listMessages(petId,conversationId,limit,offset);});
  }
  editUserMessage(petId:string,conversationId:string,messageId:string,text:string,at:number):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.editUserMessage(petId,conversationId,messageId,text,at);});
  }
  deleteMessage(petId:string,conversationId:string,messageId:string,at:number):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.deleteMessage(petId,conversationId,messageId,at);});
  }
  listProviderConfigs(limit=MAX_PAGE,offset=0) {
    return this.options.transaction(store=>store.listProviderConfigs(limit,offset));
  }
  getProviderConfig(providerId:string):AiProviderRecord|null {
    return this.options.transaction(store=>store.getProviderConfig(providerId));
  }
  saveProviderConfig(config:ProviderConfig,expectedRevision:number|null,at:number):AiProviderRecord {
    return this.options.transaction(store=>store.saveProviderConfig(providerConfigSchema.parse(config),expectedRevision,time(at)));
  }
  getProviderAssignment(petId:string) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.resolveAssignedProvider(petId);});
  }
  /** Explicit trusted user setting action, never called by a model or default
   * initialization. A fresh consent identifier is generated for cloud */
  assignProvider(raw:AiAssignProviderInput,at:number) {
    const input=closed(raw,['petId','providerId','providerRevision','allowCloudContext']);
    const petId=id(input.petId),providerId=id(input.providerId),providerRevision=time(input.providerRevision),now=time(at);
    if(typeof input.allowCloudContext!=='boolean'||providerRevision<1)throw new Error('Invalid provider assignment');
    return this.options.transaction((store,game)=>{
      requirePet(game,petId);
      const record=store.getProviderConfig(providerId);
      if(!record||record.revision!==providerRevision)throw new Error('AI provider version has changed');
      if(record.config.privacyBoundary==='CLOUD'&&!input.allowCloudContext)throw new Error('Explicit cloud context consent required');
      if(record.config.privacyBoundary!=='CLOUD'&&input.allowCloudContext)throw new Error('Unexpected remote consent for local AI');
      const consentRef=record.config.privacyBoundary==='CLOUD'?`consent:${this.allocate('consent')}`:null;
      store.setPetProviderAssignment({petId,providerId,providerRevision,consentRef,assignedAt:now});
      return store.resolveAssignedProvider(petId)!;
    });
  }
  clearProviderAssignment(petId:string):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.clearPetProviderAssignment(petId);});
  }

  beginTurn(raw:AiAuthorityTurnIntent,at:number):AiAuthorityBeginResult {
    let intent:AiAuthorityTurnIntent, now:number;
    try{intent=parseIntent(raw);now=time(at);}catch{return rejected('UNSUPPORTED');}
    return this.options.transaction((store,view)=>{
      if(store.getTurn(intent.requestId))return {kind:'DUPLICATE'};
      const snapshot=getSnapshot(view), pet=findPet(snapshot,intent.petId);
      if(!pet||!store.getConversation(intent.petId,intent.conversationId))return rejected('UNAVAILABLE');
      const persona=personaFor(pet.characterId);
      if(!persona)return rejected('UNSUPPORTED');
      const assigned=store.resolveAssignedProvider(intent.petId);
      if(!assigned)return rejected('AUTH_REQUIRED');
      if(intent.trigger==='PROACTIVE'&&!proactiveAllowed(snapshot,pet,assigned.provider.config))return rejected('UNAVAILABLE');
      if(store.hasPendingTurn(intent.petId)||store.countPendingTurns()>=3)return rejected('UNAVAILABLE');
      const deadline=Math.min(Number.MAX_SAFE_INTEGER,now+assigned.provider.config.timeoutMs);
      if(deadline<=now)return rejected('TIMEOUT');
      const recentMessages=store.listRecentCompletedMessages(intent.petId,intent.conversationId)
        .map(({messageId,petId,conversationId,role,text,createdAt})=>({messageId,petId,conversationId,role,text,createdAt}));
      const authorizedMemories=intent.trigger==='USER'?store.retrieveMemories(intent.petId,intent.userText,now):[];
      const turn=turnRequestSchema.parse({...identity(intent),trigger:intent.trigger,userText:intent.userText,
        userMessageId:intent.trigger==='USER'?this.allocate('user-message'):null,
        personaRevision:persona.revision,snapshotRevision:snapshot.revision,deadline,
        context:{persona,game:gameContext(pet,view,now),recentMessages,authorizedMemories,historySummary:null}});
      const providerId=assigned.provider.config.providerId,providerRevision=assigned.provider.revision;
      const started=store.beginTurn({turn,providerId,providerRevision,assistantMessageId:this.allocate('assistant-message'),startedAt:now});
      return started==='STARTED'?{kind:'STARTED',turn,providerId,providerRevision}:{kind:'DUPLICATE'};
    });
  }

  /** Registry callback for the exact already-durable pending request. Must be
   * called before starting inference and again after the async credential
   * broker completes. No fallback to a newer revision or another provider. */
  resolveTurnProvider(raw:AiTurnIdentity,providerId:string,providerRevision:number,at:number):AiProviderRecord|null {
    const request=identity(raw),version=time(providerRevision),now=time(at);
    return this.options.transaction((store,view)=>{
      const turn=store.getTurn(request.requestId);
      if(!turn||!sameIdentity(turn,request)||turn.providerId!==id(providerId)||turn.providerRevision!==version)return null;
      const provider=store.resolvePendingTurnProvider(request,now);
      if(!provider)return null;
      const snapshot=getSnapshot(view),pet=currentPetForTurn(snapshot,turn);
      if(!pet||(turn.trigger==='PROACTIVE'&&!proactiveAllowed(snapshot,pet,provider.config)))return null;
      return provider;
    });
  }
  lookupMessage(messageId:string) {return this.options.transaction(store=>store.lookupMessage(messageId));}
  isProposalAllowed(request:AiTurnIdentity,raw:ActionProposalDraft):boolean {
    const draft=actionProposalDraftSchema.safeParse(raw);
    if(!draft.success)return false;
    return this.options.transaction((store,game)=>{
      const turn=store.getTurn(id(request.requestId));
      if(!turn||turn.status!=='PENDING'||turn.trigger!=='USER'||!sameIdentity(turn,request))return false;
      const pet=currentPetForTurn(getSnapshot(game),turn);
      return pet!==null&&allowProposal(pet,draft.data);
    });
  }
  finishTurn(terminal:AiChatTerminal):boolean {
    return this.options.transaction((store,view)=>{
      const turn=store.getTurn(id(terminal.requestId));
      if(!turn||!sameIdentity(turn,terminal)||turn.status!=='PENDING')return false;
      if(terminal.kind==='COMPLETED'){
        const snapshot=getSnapshot(view),pet=currentPetForTurn(snapshot,turn),provider=store.resolvePendingTurnProvider(terminal,terminal.completedAt);
        if(!pet||!provider||(turn.trigger==='PROACTIVE'&&!proactiveAllowed(snapshot,pet,provider.config)))throw new Error('AI terminal context no longer authorized');
        if(terminal.reply.motionIntent!==null&&!MOTION_IDS.includes(terminal.reply.motionIntent))throw new Error('AI motion not authorized');
        const keys=new Set<string>();
        for(const proposal of terminal.proposals){
          const draft=actionProposalDraftSchema.parse({type:proposal.type,targetId:proposal.targetId,reason:proposal.reason}),key=JSON.stringify([draft.type,draft.targetId]);
          if(turn.trigger!=='USER'||keys.has(key)||!allowProposal(pet,draft)||proposal.expiresAt-terminal.completedAt>PROPOSAL_TTL)throw new Error('AI proposal no longer allowed');
          keys.add(key);
        }
      }
      // The storage independently validates source eligibility, pending
      // records, exact identities and CAS; no gameplay or OS effect here.
      return store.finishTurn(terminal);
    });
  }
  recoverPendingTurns(at:number):number {
    return this.options.transaction(store=>store.recoverPendingTurns(time(at)));
  }

  listActionProposals(petId:string,at:number,limit=MAX_PAGE) {
    return this.options.transaction((store,view)=>{
      const snapshot=getSnapshot(view),pet=findPet(snapshot,petId);
      if(!pet)return [];
      return store.listActionProposals(petId,at,limit).filter(proposal=>allowProposal(pet,proposal));
    });
  }
  dismissActionProposal(petId:string,proposalId:string):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.deleteActionProposal(petId,proposalId);});
  }
  listPendingCandidates(petId:string,at:number,limit=MAX_PAGE,offset=0) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.listPendingCandidates(petId,at,limit,offset);});
  }
  confirmMemory(petId:string,candidateId:string,decision:TrustedMemoryConfirmation,at:number) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.confirmMemory(petId,candidateId,this.allocate('memory'),at,decision);});
  }
  rejectCandidate(petId:string,candidateId:string):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.rejectCandidate(petId,candidateId);});
  }
  listMemoryRecords(petId:string,limit=MAX_PAGE,offset=0) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.listMemoryRecords(petId,limit,offset);});
  }
  editMemory(petId:string,memoryId:string,decision:AiMemoryEdit,at:number) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.editMemory(petId,memoryId,decision,at);});
  }
  deleteMemory(petId:string,memoryId:string):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.deleteMemory(petId,memoryId);});
  }
  clearMemories(petId:string):number {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.clearMemories(petId);});
  }
  revokeMemoryGrant(petId:string,memoryId:string,recipientPetId:string,at:number):boolean {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.revokeMemoryGrant(petId,memoryId,recipientPetId,at);});
  }
  retrieveMemories(petId:string,query:string,at:number) {
    return this.options.transaction((store,game)=>{requirePet(game,petId);return store.retrieveMemories(petId,query,at);});
  }
}
