import { appSnapshotSchema } from '@pet-desktop/contracts';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { aiCancelReasonSchema, chatStreamEventSchema } from '@pet-desktop/contracts/ai';
import type { AiCancelReason, AiErrorCode, ChatStreamEvent, ProviderConfig } from '@pet-desktop/contracts/ai';
import type { AiAuthorityService } from '../../../../../packages/app-service/src/ai-authority-service.js';
import type { TrustedMemoryConfirmation } from '@pet-desktop/app-service/memory-policy';
import { aiRequestSchema, aiResultMatches, aiResultSchema, chatIdentitySchema } from '../../shared/ai-ipc';
import type { AiIntent, AiRequest, AiResult, ProviderAssignmentView } from '../../shared/ai-ipc';
import { ChatCoordinator } from './chat-coordinator';
import type { ChatCredentialBroker,ChatStartResult,ProactiveChatTurnIntent } from './chat-coordinator';
import { MockModelProvider, publicAiError } from './model-provider';
import type { TurnIdentity } from './model-provider';
import { OpenAiCompatibleProvider } from './openai-compatible-provider';
import type { OpenAiCompatibleProviderOptions } from './openai-compatible-provider';

export type AiControlAuthority = Pick<AiAuthorityService,
  'listProviderConfigs' | 'getProviderConfig' | 'saveProviderConfig' | 'getProviderAssignment' | 'assignProvider' | 'clearProviderAssignment'
  | 'createConversation' | 'listConversations' | 'listMessages' | 'editUserMessage' | 'deleteMessage'
  | 'beginTurn' | 'finishTurn' | 'lookupMessage' | 'isProposalAllowed' | 'resolveTurnProvider'
  | 'listActionProposals' | 'dismissActionProposal' | 'listPendingCandidates' | 'listMemoryRecords' | 'confirmMemory'
  | 'rejectCandidate' | 'editMemory' | 'deleteMemory' | 'revokeMemoryGrant' | 'clearMemories'>;
export interface AiControlServiceOptions {
  authority: AiControlAuthority;
  /** Trusted snapshot read in the same utility process; never renderer data. */
  readGameSnapshot: () => AppSnapshot;
  credentialBroker: ChatCredentialBroker;
  sendEvent: (event: ChatStreamEvent) => void;
  now?: () => number;
  createId?: (kind:'proposal'|'memory-candidate') => string;
  maxActiveJobs?: number;
  /** Internal durable proactive scheduler authorization. Missing means deny;
   * a renderer cannot manufacture a locally opted-in pending notice. */
  authorizeProactive?: (identity:TurnIdentity) => boolean;
  /** Transport injection for isolated provider tests; not a renderer setting. */
  openAiOptions?: Omit<OpenAiCompatibleProviderOptions,'now'>;
}

const PAGE_LIMIT=10_000;
function supportedProvider(config:ProviderConfig):boolean {
  return !config.capabilities.embeddings&&(
    config.endpointKind==='OPENAI_COMPATIBLE'||(config.endpointKind==='MOCK'&&!config.capabilities.usage));
}
function cloneIdentity(value:TurnIdentity):TurnIdentity {
  return {requestId:value.requestId,petId:value.petId,conversationId:value.conversationId};
}
function assignmentView(value:NonNullable<ReturnType<AiControlAuthority['getProviderAssignment']>>):ProviderAssignmentView {
  const {assignment,provider}=value;
  if(assignment.providerId!==provider.config.providerId||assignment.providerRevision!==provider.revision)throw new Error('Invalid provider assignment');
  return {petId:assignment.petId,providerId:assignment.providerId,providerRevision:assignment.providerRevision,
    assignedAt:assignment.assignedAt,cloudConsent:provider.config.privacyBoundary==='CLOUD'&&assignment.consentRef!==null};
}
type ConfirmPayload=Extract<AiIntent,{method:'memory/confirm'}>['payload']['decision'];
function trustedConfirmation(value:ConfirmPayload):TrustedMemoryConfirmation {
  const fields={kind:'CONFIRM' as const,...(value.editedSummary!==undefined?{editedSummary:value.editedSummary}:{}),
    ...(value.expiresAt!==undefined?{expiresAt:value.expiresAt}:{}),...(value.pinned!==undefined?{pinned:value.pinned}:{})};
  return value.scope==='PRIVATE'?{...fields,scope:'PRIVATE'}:{...fields,scope:'SHARED',recipientPetIds:[...value.recipientPetIds]};
}
function failure(request:Pick<AiRequest,'requestId'> & {intent:Pick<AiIntent,'method'>},code:AiErrorCode):AiResult {
  return aiResultSchema.parse({requestId:request.requestId,method:request.intent.method,ok:false,error:publicAiError(code)});
}
function success(request:AiRequest,data:unknown):AiResult {
  const result=aiResultSchema.parse({requestId:request.requestId,method:request.intent.method,ok:true,data});
  if(!aiResultMatches(request,result))throw new Error('Mismatched authoritative AI response');
  if(!result.ok)throw new Error('Unexpected AI result shape');
  const intent=request.intent;
  if((result.method==='memory/confirm'&&intent.method==='memory/confirm'&&result.data.ownerPetId!==intent.payload.petId)
    ||(result.method==='memory/edit'&&intent.method==='memory/edit'&&(result.data.ownerPetId!==intent.payload.petId||result.data.memoryId!==intent.payload.memoryId))
    ||(result.method==='provider/assign'&&intent.method==='provider/assign'&&result.data.cloudConsent!==intent.payload.allowCloudContext)
    ||(result.method==='provider/save'&&intent.method==='provider/save'&&JSON.stringify(result.data.config)!==JSON.stringify(intent.payload.config))
    ||(result.method==='settings/list'&&intent.method==='settings/list'&&result.data.providers.length>intent.payload.limit)
    ||((result.method==='conversations/list'||result.method==='messages/list')&&result.data.rows.length>result.data.limit)
    ||(result.method==='memory/list'&&(result.data.memories.length>result.data.limit||result.data.candidates.length>result.data.limit
      ||new Set(result.data.memories.map(row=>row.memoryId)).size!==result.data.memories.length
      ||new Set(result.data.candidates.map(row=>row.candidateId)).size!==result.data.candidates.length))){
    throw new Error('Mismatched authoritative AI response');
  }
  return result;
}
function rejectMalformed(raw:unknown):AiResult {
  // A validated renderer/utility envelope is expected. If a malformed
  // payload still has a known method and valid correlation ID, respond
  // closed. Never fabricate a method/ID or echo rejected input.
  const envelope=raw!==null&&typeof raw==='object'?raw as Record<string,unknown>:null;
  const intent=envelope?.intent!==null&&typeof envelope?.intent==='object'?envelope.intent as Record<string,unknown>:null;
  const result=aiResultSchema.safeParse({requestId:envelope?.requestId,method:intent?.method,ok:false,error:publicAiError('UNSUPPORTED')});
  if(!result.success)throw new Error('Invalid AI request envelope');
  return result.data;
}

/** Trusted utility-process routing. Only closed user intents enter from
 * renderer IPC. Actual provider transport is selected by the durable exact
 * assignment; model output never re-enters this router as an instruction. */
export class AiControlService {
  private readonly authority:AiControlAuthority;
  private readonly coordinator:ChatCoordinator;
  private readonly options:AiControlServiceOptions;
  private readonly now:()=>number;
  private readonly proactiveRequests=new Map<string,string>(); // one tracked identity per owned pet
  private closed=false;
  constructor(options:AiControlServiceOptions) {
    this.options=options;this.authority=options.authority;this.now=options.now??Date.now;
    const mock=new MockModelProvider(this.now);
    const openAi=new OpenAiCompatibleProvider({...options.openAiOptions,now:this.now});
    this.coordinator=new ChatCoordinator({
      authority:this.authority,credentialBroker:options.credentialBroker,now:this.now,
      ...(options.createId===undefined?{}:{createId:options.createId}),
      ...(options.maxActiveJobs===undefined?{}:{maxActiveJobs:options.maxActiveJobs}),
      registry:{resolve:(providerId,providerRevision,identity,at)=>{
        if(this.proactiveRequests.get(identity.petId)===identity.requestId&&!this.authorizedProactive(identity))return undefined;
        const record=this.authority.resolveTurnProvider(identity,providerId,providerRevision,at);
        if(!record||record.revision!==providerRevision||record.config.providerId!==providerId||!supportedProvider(record.config))return undefined;
        const provider=record.config.endpointKind==='MOCK'?mock:record.config.endpointKind==='OPENAI_COMPATIBLE'?openAi:null;
        return provider?{config:record.config,provider,providerRevision}:undefined;
      }},
    });
  }
  get activeCount():number{return this.coordinator.activeCount;}
  private clock():number{
    const at=this.now();
    if(!Number.isSafeInteger(at)||at<0)throw new Error('Invalid AI service clock');
    return at;
  }
  private event(event:ChatStreamEvent):void{
    const parsed=chatStreamEventSchema.safeParse(event);
    if(parsed.success)this.options.sendEvent(parsed.data);
  }
  private authorizedProactive(identity:TurnIdentity):boolean{
    try{return this.options.authorizeProactive?.(cloneIdentity(identity))===true;}catch{return false;}
  }
  /** Trusted scheduler only. No public method or renderer event path for
   * PROACTIVE, and a chat-cloud assignment never authorizes this request. */
  startProactive(intent:ProactiveChatTurnIntent,onEvent:(event:ChatStreamEvent)=>void):ChatStartResult{
    const rejected:ChatStartResult={accepted:false,reason:'AUTHORITY_REJECTED',error:publicAiError('UNAVAILABLE')};
    if(this.closed||!this.authorizedProactive(intent)||typeof onEvent!=='function')return rejected;
    try{
      const config=this.authority.getProviderAssignment(intent.petId)?.provider.config;
      if(!config||config.privacyBoundary==='CLOUD'||!supportedProvider(config))return rejected;
      const result=this.coordinator.startProactive(intent,event=>{
        if(event.kind!=='textDelta'&&this.proactiveRequests.get(event.petId)===event.requestId)this.proactiveRequests.delete(event.petId);
        onEvent(event);
      });
      if(result.accepted)this.proactiveRequests.set(result.petId,result.requestId);
      return result;
    }catch{return rejected;}
  }
  /** Trusted internal owner only (disconnect, pet switch, credential revoke).
   * Public renderer cancellation below accepts USER only. */
  cancelInternal(identity:TurnIdentity,reason:AiCancelReason):boolean{
    if(this.closed)return false;
    const checked=chatIdentitySchema.safeParse(identity),cancel=aiCancelReasonSchema.safeParse(reason);
    return checked.success&&cancel.success?this.coordinator.cancel(checked.data,cancel.data):false;
  }
  close():void {
    if(this.closed)return;
    this.closed=true;this.coordinator.close();this.proactiveRequests.clear();
  }
  handleRequest(raw:unknown):AiResult{
    const parsed=aiRequestSchema.safeParse(raw);
    if(!parsed.success)return rejectMalformed(raw);
    const request=parsed.data,intent=request.intent;
    if(this.closed)return failure(request,'UNAVAILABLE');
    const payload=intent.payload;
    if(('offset' in payload&&payload.offset>PAGE_LIMIT)||('candidateOffset' in payload&&payload.candidateOffset>PAGE_LIMIT))return failure(request,'UNSUPPORTED');
    try{
      const at=this.clock(),a=this.authority;
      switch(intent.method){
        case 'settings/list': {
          const p=intent.payload;
          const snapshot=appSnapshotSchema.parse(this.options.readGameSnapshot());
          const providers=a.listProviderConfigs(p.limit,p.offset);
          const assignments=snapshot.pets.flatMap(pet=>{
            const assigned=a.getProviderAssignment(pet.petId);
            if(!assigned)return [];
            const view=assignmentView(assigned);
            if(view.petId!==pet.petId)throw new Error('Wrong provider assignment scope');
            return [view];
          });
          return success(request,{providers,assignments});
        }
        case 'provider/save':{
          const p=intent.payload;
          if(!supportedProvider(p.config))return failure(request,'UNSUPPORTED');
          const data=a.saveProviderConfig(p.config,p.expectedRevision,at);
          this.coordinator.cancelStaleJobs();
          return success(request,data);
        }
        case 'provider/assign':{
          const p=intent.payload,record=a.getProviderConfig(p.providerId);
          if(!record||record.revision!==p.providerRevision)return failure(request,'UNAVAILABLE');
          if(!supportedProvider(record.config))return failure(request,'UNSUPPORTED');
          if(record.config.privacyBoundary==='CLOUD'&&!p.allowCloudContext)return failure(request,'AUTH_REQUIRED');
          if(record.config.privacyBoundary!=='CLOUD'&&p.allowCloudContext)return failure(request,'UNSUPPORTED');
          const assigned=a.assignProvider(p,at);
          this.coordinator.cancelStaleJobs();
          return success(request,assignmentView(assigned));
        }
        case 'provider/clear':{
          const changed=a.clearProviderAssignment(intent.payload.petId);
          this.coordinator.cancelStaleJobs();
          return success(request,{changed});
        }
        case 'conversations/list':{
          const p=intent.payload;return success(request,{...p,rows:a.listConversations(p.petId,p.limit,p.offset)});
        }
        case 'conversation/create':return success(request,a.createConversation(intent.payload,at));
        case 'messages/list':{
          const p=intent.payload;return success(request,{...p,rows:a.listMessages(p.petId,p.conversationId,p.limit,p.offset)});
        }
        case 'message/edit':{
          const p=intent.payload,changed=a.editUserMessage(p.petId,p.conversationId,p.messageId,p.text,at);
          if(changed)this.coordinator.cancelStaleJobs();
          return success(request,{changed});
        }
        case 'message/delete':{
          const p=intent.payload,changed=a.deleteMessage(p.petId,p.conversationId,p.messageId,at);
          if(changed)this.coordinator.cancelStaleJobs();
          return success(request,{changed});
        }
        case 'chat/start':{
          for (const petId of this.proactiveRequests.keys()) this.coordinator.cancelProactiveForPet(petId);
          const started=this.coordinator.start(intent.payload,event=>this.event(event));
          return started.accepted?success(request,cloneIdentity(started)):failure(request,started.error.code);
        }
        case 'chat/cancel':return success(request,{changed:this.coordinator.cancel(cloneIdentity(intent.payload),intent.payload.reason)});
        case 'proposals/list':{
          const {petId}=intent.payload;return success(request,{petId,rows:a.listActionProposals(petId,at)});
        }
        case 'proposal/dismiss':{
          const p=intent.payload;return success(request,{changed:a.dismissActionProposal(p.petId,p.proposalId)});
        }
        case 'memory/list':{
          const p=intent.payload;return success(request,{...p,memories:a.listMemoryRecords(p.petId,p.limit,p.offset),
            candidates:a.listPendingCandidates(p.petId,at,p.limit,p.candidateOffset)});
        }
        case 'memory/confirm':{
          const p=intent.payload,result=a.confirmMemory(p.petId,p.candidateId,trustedConfirmation(p.decision),at);
          return result.ok?success(request,result.record):failure(request,'UNAVAILABLE');
        }
        case 'memory/reject':{
          const p=intent.payload;return success(request,{changed:a.rejectCandidate(p.petId,p.candidateId)});
        }
        case 'memory/edit':{
          const p=intent.payload,result=a.editMemory(p.petId,p.memoryId,p.decision,at);
          if(!result)return failure(request,'UNAVAILABLE');
          this.coordinator.cancelStaleJobs();return success(request,result);
        }
        case 'memory/delete':{
          const p=intent.payload,changed=a.deleteMemory(p.petId,p.memoryId);
          if(changed)this.coordinator.cancelStaleJobs();return success(request,{changed});
        }
        case 'memory/revoke':{
          const p=intent.payload,changed=a.revokeMemoryGrant(p.petId,p.memoryId,p.recipientPetId,at);
          if(changed)this.coordinator.cancelStaleJobs();return success(request,{changed});
        }
        case 'memory/clear':{
          const count=a.clearMemories(intent.payload.petId);
          if(count>0)this.coordinator.cancelStaleJobs();return success(request,{count});
        }
      }
    }catch{ return failure(request,'UNAVAILABLE'); }
  }
}
