import { randomUUID } from 'node:crypto';
import type { ChatIdentity } from '../shared/ai-ipc';
import type { AiCancelReason } from '@pet-desktop/contracts/ai';
import { aiResultMatches, aiResultSchema, credentialLookupReplySchema, credentialLookupSchema } from '../shared/ai-ipc';
import type { FeatureInput, FeatureOutput } from '../shared/feature-protocol';
import { featureInputSchema, featureOutputSchema } from '../shared/feature-protocol';
import { voiceResultMatchesRequest, voiceServiceResultSchema } from '../shared/voice-ipc';
import type { VoiceServiceResult } from '../shared/voice-ipc';
import type { AiControlService } from './ai/ai-control-service';
import type { VoiceService } from './voice/voice-service';
import type { WorkspaceControl } from './workspace/workspace-control';
import { workspaceAuthorityResultSchema,workspaceAuthorityResultMatches } from '../shared/workspace-ipc';
import type {VoiceSettingsService} from './voice/voice-settings-service';
import {voiceSettingsResultSchema,voiceSettingsResultMatchesRequest} from '../shared/voice-settings-ipc';

/** Utility-side pending credential lookups. Never directly read the OS vault
 * or keep a secret after resolving this bounded, exact job request. */
export class UtilityCredentialBroker {
  private closed=false;
  private readonly pending=new Map<string,{finish:(secret:string|null)=>void}>();
  constructor(private readonly send:(value:FeatureOutput)=>void,private readonly timeoutMs=10_000){}
  resolveCredential(providerId:string,credentialRef:string,signal:AbortSignal,identity:ChatIdentity):Promise<string|null>{
    if(this.closed||signal.aborted||this.pending.size>=3)return Promise.resolve(null);
    const lookup=credentialLookupSchema.safeParse({lookupId:`lookup-${randomUUID()}`,providerId,credentialRef,identity});
    if(!lookup.success)return Promise.resolve(null);
    const lookupId=lookup.data.lookupId;
    return new Promise(resolve=>{
      let done=false;let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(secret:string|null)=>{if(done)return;done=true;this.pending.delete(lookupId);clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(secret);};
      const abort=()=>finish(null);
      this.pending.set(lookupId,{finish});signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,this.timeoutMs);
      if(signal.aborted){abort();return;}
      try{this.send({kind:'credential-lookup',lookup:lookup.data});}catch{finish(null);}
    });
  }
  receive(raw:unknown):void{const parsed=credentialLookupReplySchema.safeParse(raw);if(!this.closed&&parsed.success)this.pending.get(parsed.data.lookupId)?.finish(parsed.data.secret);}
  close():void{if(this.closed)return;this.closed=true;for(const pending of [...this.pending.values()])pending.finish(null);}
}

export interface UtilityFeatures {
  receive(input:FeatureInput):void;
  close():void;
}

/** Same utility process as the SQLite writer. Async provider completions are
 * awaited outside transactions, then authority performs short CAS writes. */
export function createUtilityFeatureRouter(options:{ai:Pick<AiControlService,'handleRequest'|'cancelInternal'|'close'>;
  voice:Pick<VoiceService,'handle'|'dispose'>;voiceSettings:Pick<VoiceSettingsService,'handle'|'dispose'>;workspace:Pick<WorkspaceControl,'handleAuthority'>;broker:UtilityCredentialBroker;send:(value:FeatureOutput)=>void;fault:()=>void}):UtilityFeatures {
  let closed=false;
  const send=(message:FeatureOutput)=>{if(!closed)options.send(featureOutputSchema.parse(message));};
  return{
    receive(raw){
      if(closed)return;
      const input=featureInputSchema.parse(raw);
      switch(input.kind){
        case 'credential-reply':options.broker.receive(input.reply);break;
        case 'internal-chat-cancel':{
          const {reason,...identity}=input.cancel;
          options.ai.cancelInternal(identity,reason as AiCancelReason);break;
        }
        case 'ai-request':{
          const result=aiResultSchema.parse(options.ai.handleRequest(input.request));
          if(!aiResultMatches(input.request,result)){options.fault();return;}
          send({kind:'ai-result',result});break;
        }
        case 'workspace-authority-request':{
          const result=workspaceAuthorityResultSchema.parse(options.workspace.handleAuthority(input.request));
          if(!workspaceAuthorityResultMatches(input.request,result)){options.fault();return;}
          send({kind:'workspace-authority-result',result});break;
        }
        case 'voice-request':{
          const {request,requestId}=input;
          void Promise.resolve(options.voice.handle(request)).then(rawResult=>{
            if(closed)return;
            const result=voiceServiceResultSchema.safeParse(rawResult);
            if(!result.success||!voiceResultMatchesRequest(request,result.data)){options.fault();return;}
            send({kind:'voice-result',requestId,result:result.data});
          }).catch(()=>{
            if(closed)return;
            const result:VoiceServiceResult={ok:false,kind:'error',code:'unavailable',...('job'in request?{job:request.job}:{})};
            try{send({kind:'voice-result',requestId,result});}catch{options.fault();}
          });break;
        }
        case 'voice-settings-request':{
          const {request,requestId}=input;
          void Promise.resolve(options.voiceSettings.handle(request)).then(raw=>{if(closed)return;
            const result=voiceSettingsResultSchema.safeParse(raw);if(!result.success||!voiceSettingsResultMatchesRequest(request,result.data)){options.fault();return;}
            send({kind:'voice-settings-result',requestId,result:result.data});
          }).catch(()=>{if(!closed)try{send({kind:'voice-settings-result',requestId,result:{ok:false,kind:'error',code:'UNAVAILABLE',petId:request.petId}});}catch{options.fault();}});break;
        }
      }
    },
    close(){if(closed)return;closed=true;options.broker.close();try{options.ai.close();}finally{try{options.voiceSettings.dispose();}finally{options.voice.dispose();}}},
  };
}
