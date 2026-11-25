import { randomUUID } from 'node:crypto';
import type { AiCancelReason, ChatStreamEvent } from '@pet-desktop/contracts/ai';
import { aiRequestSchema, aiResultMatches, credentialLookupReplySchema } from '../shared/ai-ipc';
import type { AiRequest, AiResult, ChatIdentity } from '../shared/ai-ipc';
import { sameVoiceJob, voiceResultMatchesRequest, voiceServiceRequestSchema } from '../shared/voice-ipc';
import type { VoiceOwnedJob, VoiceServiceRequest, VoiceServiceResult } from '../shared/voice-ipc';
import { featureInputSchema, featureOutputSchema } from '../shared/feature-protocol';
import type { FeatureInput, FeatureOutput } from '../shared/feature-protocol';
import { workspaceAuthorityRequestSchema,workspaceAuthorityResultMatches } from '../shared/workspace-ipc';
import type { WorkspaceAuthorityRequest,WorkspaceAuthorityResult } from '../shared/workspace-ipc';
import { voiceSettingsRequestSchema,voiceSettingsResultMatchesRequest } from '../shared/voice-settings-ipc';
import type { VoiceSettingsRequest,VoiceSettingsResult } from '../shared/voice-settings-ipc';

import { hostAuthorityRequestSchema, hostAuthorityFailure } from '../shared/host-settings-ipc';
import type { HostAuthorityRequest, HostAuthorityResult } from '../shared/host-settings-ipc';

const sameChat=(a:ChatIdentity,b:ChatIdentity)=>a.petId===b.petId&&a.conversationId===b.conversationId&&a.requestId===b.requestId;
const aiFailure=(request:AiRequest,code:'UNAVAILABLE'|'TIMEOUT'|'UNSUPPORTED'='UNAVAILABLE'):AiResult=>({requestId:request.requestId,method:request.intent.method,ok:false,
  error:{code,message:code==='TIMEOUT'?'AI 请求结果尚未确认，请刷新对话。':'AI 服务暂不可用。',retryable:code!=='UNSUPPORTED'}});
const voiceFailure=(request:VoiceServiceRequest,code:'unavailable'|'timeout'='unavailable'):VoiceServiceResult=>({ok:false,kind:'error',code,...('job'in request?{job:request.job}:{})});
const workspaceFailure=(request:WorkspaceAuthorityRequest):WorkspaceAuthorityResult=>({ok:false,requestId:request.requestId,method:request.intent.method,error:{code:'SERVICE_UNAVAILABLE'}});
const voiceSettingsFailure=(request:VoiceSettingsRequest):VoiceSettingsResult=>({ok:false,kind:'error',code:'UNAVAILABLE',petId:request.petId});
type Pending = {kind:'host',request:HostAuthorityRequest,resolve:(result:HostAuthorityResult)=>void,timer:ReturnType<typeof setTimeout>}
  | {kind:'ai',request:AiRequest,resolve:(result:AiResult)=>void,timer:ReturnType<typeof setTimeout>}
  |{kind:'voice',request:VoiceServiceRequest,resolve:(result:VoiceServiceResult)=>void,timer:ReturnType<typeof setTimeout>}
  |{kind:'workspace',request:WorkspaceAuthorityRequest,resolve:(result:WorkspaceAuthorityResult)=>void,timer:ReturnType<typeof setTimeout>}
  |{kind:'voice-settings',request:VoiceSettingsRequest,resolve:(result:VoiceSettingsResult)=>void,timer:ReturnType<typeof setTimeout>};
interface ChatJob{identity:ChatIdentity;nextSequence:number;terminal:boolean}

/** One instance per actual utility process generation. Exact transport IDs,
 * voice jobs, chat identities and pending credentials cannot cross restart. */
export class FeatureClient {
  private closed=false;
  private readonly pending=new Map<string,Pending>();
  private readonly chats=new Map<string,ChatJob>();
  private readonly used=new Set<string>();
  private readonly credentialLookups=new Set<string>();
  private activeVoice:VoiceOwnedJob|null=null;
  private voiceReserved=false;
  constructor(private readonly options:{post(message:FeatureInput):void;onChat(event:ChatStreamEvent):void;
    credential?(providerId:string,ref:string):Promise<string|null>;fault():void;aiTimeoutMs?:number;voiceTimeoutMs?:number}){}
  private send(message:FeatureInput):boolean{
    if(this.closed)return false;
    try{this.options.post(featureInputSchema.parse(message));return true;}catch{this.options.fault();return false;}
  }
  requestHost(raw: HostAuthorityRequest): Promise<HostAuthorityResult> {
    const request = hostAuthorityRequestSchema.parse(raw);
    if (this.closed || this.pending.size >= 64 || this.used.size >= 30_000) return Promise.resolve(hostAuthorityFailure(request));
    const requestId = `host-${randomUUID()}`;
    this.used.add(requestId);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) resolve(hostAuthorityFailure(request));
      }, request.kind === 'backup' ? 180_000 : this.options.aiTimeoutMs ?? 15_000);
      this.pending.set(requestId, { kind: 'host', request, resolve, timer });
      if (!this.send({ kind: 'host-authority-request', requestId, request })) this.close();
    });
  }
  requestAi(raw:AiRequest):Promise<AiResult>{
    const request=aiRequestSchema.parse(raw);
    if(this.closed||this.used.has(request.requestId)||this.used.size>=30_000||this.pending.size>=64)return Promise.resolve(aiFailure(request));
    if(request.intent.method==='chat/start'){
      const identity:ChatIdentity={petId:request.intent.payload.petId,conversationId:request.intent.payload.conversationId,requestId:request.intent.payload.requestId};
      if(this.chats.has(identity.requestId)||this.chats.size>=3)return Promise.resolve(aiFailure(request));
      this.chats.set(identity.requestId,{identity,nextSequence:0,terminal:false});
    }
    this.used.add(request.requestId);
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{
        if(!this.pending.delete(request.requestId))return;
        if(request.intent.method==='chat/start')this.cancelChat(request.intent.payload,'TIMEOUT');
        resolve(aiFailure(request,'TIMEOUT'));
      },this.options.aiTimeoutMs??15_000);
      this.pending.set(request.requestId,{kind:'ai',request,resolve,timer});
      if(!this.send({kind:'ai-request',request}))this.close();
    });
  }
  requestVoice(raw:VoiceServiceRequest):Promise<VoiceServiceResult>{
    const request=voiceServiceRequestSchema.parse(raw);
    if(this.closed||this.pending.size>=64||this.used.size>=30_000)return Promise.resolve(voiceFailure(request));
    const requestId=`voice-${randomUUID()}`;this.used.add(requestId);
    // Track the reserved job from the request, not a renderer-selected stale
    // state. If pending begin fails, ownership is cleared in result handler.
    if(request.kind==='begin'&&!this.activeVoice){this.activeVoice=request.job;this.voiceReserved=false;}
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{
        if(!this.pending.delete(requestId))return;
        if('job'in request&&this.activeVoice&&sameVoiceJob(request.job,this.activeVoice))this.cancelVoice('SUSPEND');
        resolve(voiceFailure(request,'timeout'));
      },this.options.voiceTimeoutMs??180_000);
      this.pending.set(requestId,{kind:'voice',request,resolve,timer});
      if(!this.send({kind:'voice-request',requestId,request}))this.close();
    });
  }
  requestWorkspace(raw:WorkspaceAuthorityRequest):Promise<WorkspaceAuthorityResult>{
    const request=workspaceAuthorityRequestSchema.parse(raw);
    if(this.closed||this.used.has(request.requestId)||this.used.size>=30_000||this.pending.size>=64)return Promise.resolve(workspaceFailure(request));
    this.used.add(request.requestId);
    return new Promise(resolve=>{const timer=setTimeout(()=>{if(this.pending.delete(request.requestId))resolve(workspaceFailure(request));},this.options.aiTimeoutMs??15_000);
      this.pending.set(request.requestId,{kind:'workspace',request,resolve,timer});if(!this.send({kind:'workspace-authority-request',request}))this.close();});
  }
  requestVoiceSettings(raw:VoiceSettingsRequest):Promise<VoiceSettingsResult>{
    const request=voiceSettingsRequestSchema.parse(raw);
    if(this.closed||this.pending.size>=64||this.used.size>=30_000)return Promise.resolve(voiceSettingsFailure(request));
    const requestId=`voice-settings-${randomUUID()}`;this.used.add(requestId);
    return new Promise(resolve=>{const timer=setTimeout(()=>{if(this.pending.delete(requestId))resolve(voiceSettingsFailure(request));},this.options.voiceTimeoutMs??180_000);
      this.pending.set(requestId,{kind:'voice-settings',request,resolve,timer});if(!this.send({kind:'voice-settings-request',requestId,request}))this.close();});
  }
  cancelChat(raw:ChatIdentity,reason:AiCancelReason):void{
    const active=this.chats.get(raw.requestId);
    if(!active||!sameChat(raw,active.identity))return;
    this.chats.delete(raw.requestId);
    this.send({kind:'internal-chat-cancel',cancel:{...active.identity,reason}});
  }
  private cancelVoice(reason:'SUSPEND'|'PET_SWITCH'|'USER'):void{
    const job=this.activeVoice;this.activeVoice=null;this.voiceReserved=false;
    if(job)void this.requestVoice({kind:'cancel',job,reason}).catch(()=>undefined);
  }
  /** Call on trusted document reload/hide/suspend. No old stream or pending
   * credential is subsequently sent to a replacement renderer. */
  revokeDocument():void{for(const active of [...this.chats.values()])this.cancelChat(active.identity,'SERVICE_STOPPED');this.cancelVoice('SUSPEND');}
  ownsVoice(job:VoiceOwnedJob):boolean{return this.voiceReserved&&this.activeVoice!==null&&sameVoiceJob(this.activeVoice,job);}
  receive(raw:FeatureOutput):void{
    if(this.closed)return;
    const parsed=featureOutputSchema.safeParse(raw);
    if(!parsed.success){this.options.fault();return;}
    const output=parsed.data;
    switch(output.kind){
      case 'host-authority-result': {
        const p = this.pending.get(output.requestId);
        if (!p) return;
        if (p.kind !== 'host' || output.result.kind !== (p.request.kind === 'backup' ? 'backup' : 'preferences')) {
          this.options.fault(); return;
        }
        this.pending.delete(output.requestId);
        clearTimeout(p.timer);
        p.resolve(output.result);
        break;
      }
      case 'ai-result':{
        const result=output.result,p=this.pending.get(result.requestId);
        if(!p)return;
        if(p.kind!=='ai'||!aiResultMatches(p.request,result)){this.options.fault();return;}
        this.pending.delete(result.requestId);clearTimeout(p.timer);
        if(!result.ok&&p.request.intent.method==='chat/start')this.chats.delete(p.request.intent.payload.requestId);
        p.resolve(result);break;
      }
      case 'voice-result':{
        const p=this.pending.get(output.requestId);if(!p)return;
        if(p.kind!=='voice'||!voiceResultMatchesRequest(p.request,output.result)){this.options.fault();return;}
        this.pending.delete(output.requestId);clearTimeout(p.timer);
        if(p.request.kind==='begin'&&this.activeVoice&&sameVoiceJob(this.activeVoice,p.request.job)){
          if(output.result.ok&&output.result.kind==='begun')this.voiceReserved=true;else{this.activeVoice=null;this.voiceReserved=false;}
        }
        if((p.request.kind==='cancel'||p.request.kind==='finish')&&output.result.ok&&this.activeVoice&&sameVoiceJob(this.activeVoice,p.request.job)){this.activeVoice=null;this.voiceReserved=false;}
        p.resolve(output.result);break;
      }
      case 'chat-event':{
        const event=output.event,job=this.chats.get(event.requestId);
        if(!job||!sameChat(event,job.identity)||job.terminal)return;
        if(event.sequence!==job.nextSequence){this.cancelChat(job.identity,'SERVICE_STOPPED');return;}
        job.nextSequence++;
        if(event.kind!=='textDelta'){job.terminal=true;this.chats.delete(event.requestId);}
        try{this.options.onChat(event);}catch{/* renderer replacement */}
        break;
      }
      case 'workspace-authority-result':{
        const result=output.result,p=this.pending.get(result.requestId);if(!p)return;
        if(p.kind!=='workspace'||!workspaceAuthorityResultMatches(p.request,result)){this.options.fault();return;}
        this.pending.delete(result.requestId);clearTimeout(p.timer);p.resolve(result);break;
      }
      case 'voice-settings-result':{
        const p=this.pending.get(output.requestId);if(!p)return;
        if(p.kind!=='voice-settings'||!voiceSettingsResultMatchesRequest(p.request,output.result)){this.options.fault();return;}
        this.pending.delete(output.requestId);clearTimeout(p.timer);p.resolve(output.result);break;
      }
      case 'credential-lookup':{
        const lookup=output.lookup,job=this.chats.get(lookup.identity.requestId);
        if(!job||!sameChat(lookup.identity,job.identity)||this.credentialLookups.has(lookup.lookupId)||this.credentialLookups.size>=30_000)return;
        this.credentialLookups.add(lookup.lookupId);
        void(async()=>{
          let secret:string|null=null;
          try{secret=await this.options.credential?.(lookup.providerId,lookup.credentialRef)??null;}catch{/* no raw error */}
          if(this.closed||this.chats.get(lookup.identity.requestId)!==job)return;
          const reply=credentialLookupReplySchema.safeParse({lookupId:lookup.lookupId,secret});
          this.send({kind:'credential-reply',reply:reply.success?reply.data:{lookupId:lookup.lookupId,secret:null}});
        })();break;
      }
    }
  }
  close():void{
    if(this.closed)return;this.closed=true;this.chats.clear();this.activeVoice=null;this.voiceReserved=false;this.credentialLookups.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);if(p.kind==='host')p.resolve(hostAuthorityFailure(p.request));else if(p.kind==='ai')p.resolve(aiFailure(p.request));else if(p.kind==='voice')p.resolve(voiceFailure(p.request));else if(p.kind==='workspace')p.resolve(workspaceFailure(p.request));else p.resolve(voiceSettingsFailure(p.request));}
    this.pending.clear();
  }
}
