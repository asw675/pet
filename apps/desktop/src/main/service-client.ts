import { randomUUID } from 'node:crypto';
import { CONTRACT_SCHEMA_VERSION, idSchema, ipcRequestSchema, resultMatchesMethod } from '@pet-desktop/contracts';
import type { AppSnapshot, IpcErrorCode, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import { serviceInputSchema, serviceOutputSchema } from '../shared/protocol.js';
import type { ServiceInput, ServiceStatus, SnapshotListener, StatusListener } from '../shared/protocol.js';
import { hostAuthorityFailure } from '../shared/host-settings-ipc';
import type { HostAuthorityRequest, HostAuthorityResult } from '../shared/host-settings-ipc';
import { FeatureClient } from './feature-client';
import type { AiRequest,AiResult,ChatIdentity } from '../shared/ai-ipc';
import type { AiCancelReason,ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { VoiceOwnedJob,VoiceServiceRequest,VoiceServiceResult } from '../shared/voice-ipc';
import type { WorkspaceAuthorityRequest,WorkspaceAuthorityResult } from '../shared/workspace-ipc';
import type {VoiceSettingsRequest,VoiceSettingsResult} from '../shared/voice-settings-ipc';

/** Narrow adapter over Electron UtilityProcess; no Electron APIs needed in tests. */
export interface ServiceChild {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface ServiceClientOptions {
  spawn: () => ServiceChild;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
  credential?: (providerId:string,credentialRef:string)=>Promise<string|null>;
}

type Timer = ReturnType<typeof setTimeout>;
type Phase = 'handshake' | 'bootstrap' | 'online' | 'closing';

interface Pending {
  timer: Timer;
  method: IpcRequest['method'];
  resolve(result: IpcResult): void;
}

interface Session {
  child: ServiceChild;
  phase: Phase;
  bootstrapId: string;
  startupTimer: Timer | undefined;
  shutdownTimer: Timer | undefined;
  pending: Map<string, Pending>;
  usedIds: Set<string>;
  lastRevision: number;
  features: FeatureClient|undefined;
}

function errorResult(requestId: string, code: IpcErrorCode, message: string, retryable: boolean): IpcResult {
  return { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: false, error: { requestId, code, message, retryable } };
}

function unavailable(requestId: string): IpcResult {
  return errorResult(requestId, 'SERVICE_UNAVAILABLE', 'The application service is unavailable.', true);
}

function requestIdOf(result: IpcResult): string {
  return result.ok ? result.requestId : result.error.requestId;
}

function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError('Invalid service timeout.');
  }
  return value;
}

/** Main's only app-service connection. A closing session retains ownership until
 * the actual child exit event, even if shutdown acknowledgement or kill arrives. */
export class ServiceClient {
  private readonly spawn: () => ServiceChild;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly chatListeners = new Set<(event:ChatStreamEvent)=>void>();
  private readonly credential: ServiceClientOptions['credential'];
  private status: ServiceStatus = { stage: 'UNAVAILABLE', generation: 0 };
  private current: Session | undefined;
  private restartTimer: Timer | undefined;
  private restartCount = 0;
  private started = false;
  private spawning = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;

  constructor(options: ServiceClientOptions) {
    this.spawn = options.spawn;
    this.credential=options.credential;
    this.requestTimeoutMs = duration(options.requestTimeoutMs, 10_000);
    this.startupTimeoutMs = duration(options.startupTimeoutMs, 15_000);
    this.shutdownTimeoutMs = duration(options.shutdownTimeoutMs, 5_000);
    this.restartDelayMs = duration(options.restartDelayMs, 500);
    this.maxRestarts = duration(options.maxRestarts, 3);
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.spawnNext();
  }

  getStatus(): ServiceStatus {
    return { ...this.status };
  }

  subscribeSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  subscribeChat(listener:(event:ChatStreamEvent)=>void):()=>void{this.chatListeners.add(listener);return()=>{this.chatListeners.delete(listener);};}
  requestAi(request:AiRequest):Promise<AiResult>{
    const session=this.current;
    if(!session||session.phase!=='online'||this.stopping||!session.features)return Promise.resolve({ok:false,requestId:request.requestId,method:request.intent.method,error:{code:'UNAVAILABLE',message:'AI 服务暂不可用。',retryable:true}});
    return session.features.requestAi(request);
  }
  requestVoice(request:VoiceServiceRequest):Promise<VoiceServiceResult>{
    const session=this.current;
    if(!session||session.phase!=='online'||this.stopping||!session.features)return Promise.resolve({ok:false,kind:'error',code:'unavailable',...('job'in request?{job:request.job}:{})});
    return session.features.requestVoice(request);
  }
  cancelVoiceChat(identity:ChatIdentity,reason:AiCancelReason):void{this.current?.features?.cancelChat(identity,reason);}
  revokeFeatureDocument():void{this.current?.features?.revokeDocument();}
  ownsVoice(job:VoiceOwnedJob):boolean{return this.current?.phase==='online'&&this.current.features?.ownsVoice(job)===true;}
  requestWorkspace(request:WorkspaceAuthorityRequest):Promise<WorkspaceAuthorityResult>{
    const session=this.current;if(!session||session.phase!=='online'||this.stopping||!session.features)return Promise.resolve({ok:false,requestId:request.requestId,method:request.intent.method,error:{code:'SERVICE_UNAVAILABLE'}});
    return session.features.requestWorkspace(request);
  }
  requestHost(request: HostAuthorityRequest): Promise<HostAuthorityResult> {
    const session = this.current;
    if (!session || session.phase !== 'online' || this.stopping || !session.features) return Promise.resolve(hostAuthorityFailure(request));
    return session.features.requestHost(request);
  }
  requestVoiceSettings(request:VoiceSettingsRequest):Promise<VoiceSettingsResult>{
    const session=this.current;if(!session||session.phase!=='online'||this.stopping||!session.features)return Promise.resolve({ok:false,kind:'error',code:'UNAVAILABLE',petId:request.petId});
    return session.features.requestVoiceSettings(request);
  }

  request(request: IpcRequest): Promise<IpcResult> {
    const parsed = ipcRequestSchema.safeParse(request);
    if (!parsed.success) {
      const candidate = request !== null && typeof request === 'object'
        ? idSchema.safeParse(request.requestId) : undefined;
      return Promise.resolve(errorResult(candidate?.success ? candidate.data : 'invalid-request',
        'INVALID_REQUEST', 'Invalid application request.', false));
    }
    const session = this.current;
    const requestId = parsed.data.requestId;
    if (this.stopping || !session || session.phase !== 'online') {
      return Promise.resolve(unavailable(requestId));
    }
    // Retain used IDs for this generation, not just pending IDs: there is no way
    // to distinguish a duplicate or late response from one for a reused ID.
    if (session.usedIds.has(requestId)) {
      return Promise.resolve(errorResult(requestId, 'INVALID_REQUEST', 'The request ID was already used.', false));
    }
    session.usedIds.add(requestId);
    return new Promise<IpcResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!session.pending.delete(requestId)) return;
        resolve(errorResult(requestId, 'TIMEOUT', 'The application request timed out.', true));
      }, this.requestTimeoutMs);
      session.pending.set(requestId, { timer, resolve, method: parsed.data.method });
      try {
        this.post(session, { kind: 'request', request: parsed.data });
      } catch {
        this.failSession(session);
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<void>((resolve) => { this.resolveStop = resolve; });
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.setStatus('STOPPING');
    if (this.current) this.closeSession(this.current);
    else if (!this.spawning) this.finishStop();
    return this.stopPromise;
  }

  private setStatus(stage: ServiceStatus['stage'], generation = this.status.generation): void {
    if (this.status.stage === stage && this.status.generation === generation) return;
    this.status = { stage, generation };
    for (const listener of [...this.statusListeners]) {
      // Subscriber failure (e.g. a destroyed renderer) must not interrupt cleanup.
      try { listener(this.getStatus()); } catch { /* isolated subscriber */ }
    }
  }

  private publishSnapshot(session: Session, snapshot: AppSnapshot): void {
    if (this.current !== session || session.phase !== 'online' || snapshot.revision <= session.lastRevision) return;
    session.lastRevision = snapshot.revision;
    for (const listener of [...this.snapshotListeners]) {
      try { listener(snapshot); } catch { /* isolated subscriber */ }
    }
  }

  private spawnNext(): void {
    if (this.current || this.spawning || this.stopping) return;
    const generation = this.status.generation + 1;
    this.setStatus(generation === 1 ? 'STARTING' : 'RESTARTING', generation);
    if (this.stopping) return;

    this.spawning = true;
    let child: ServiceChild;
    try {
      child = this.spawn();
    } catch {
      this.spawning = false;
      if (this.stopping) this.finishStop();
      else this.scheduleRestart();
      return;
    }
    this.spawning = false;
    const bootstrapId = `service-snapshot-${randomUUID()}`;
    const session: Session = {
      child, phase: 'handshake', bootstrapId, startupTimer: undefined, shutdownTimer: undefined,
      pending: new Map(), usedIds: new Set([bootstrapId]), lastRevision: -1,features:undefined,
    };
    session.features=new FeatureClient({post:message=>this.post(session,message),onChat:event=>{
      if(this.current===session&&session.phase==='online')for(const listener of [...this.chatListeners])try{listener(event);}catch{/* isolated */}
    },...(this.credential?{credential:this.credential}:{}),fault:()=>this.failSession(session)});
    this.current = session;
    session.startupTimer = setTimeout(() => { this.failSession(session); }, this.startupTimeoutMs);
    child.on('exit', () => { this.onExit(session); });
    child.on('message', (message) => { this.onMessage(session, message); });
    if (this.stopping) this.closeSession(session);
  }

  private post(session: Session, input: ServiceInput): void {
    session.child.postMessage(serviceInputSchema.parse(input));
  }

  private onMessage(session: Session, raw: unknown): void {
    // Old listeners can fire after restart. Do not let them resolve current
    // requests, change health, or publish projections from a former writer.
    if (this.current !== session || session.phase === 'closing' || this.stopping) return;
    const output = serviceOutputSchema.safeParse(raw);
    if (!output.success) {
      this.failSession(session);
      return;
    }
    const message = output.data;
    switch (message.kind) {
      case 'ready': {
        if (session.phase !== 'handshake') {
          this.failSession(session);
          return;
        }
        session.phase = 'bootstrap';
        // Re-read authoritative data after each spawn before admitting new
        // business commands. A new generation starts with no revision waterline.
        try {
          this.post(session, { kind: 'request', request: {
            schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: session.bootstrapId, method: 'snapshot/get', payload: {},
          } });
        } catch {
          this.failSession(session);
        }
        break;
      }
      case 'result':
        this.onResult(session, message.result);
        break;
      case 'snapshot':
        this.publishSnapshot(session, message.snapshot);
        break;
      case 'ai-result':case 'voice-result':case 'chat-event':case 'credential-lookup':case 'workspace-authority-result':case 'voice-settings-result':case 'host-authority-result':
        if(session.phase==='online')session.features?.receive(message);
        break;
      case 'fatal':
      case 'stopped':
        this.failSession(session);
        break;
    }
  }

  private onResult(session: Session, result: IpcResult): void {
    const requestId = requestIdOf(result);
    if (session.phase === 'bootstrap' && requestId === session.bootstrapId) {
      if (!result.ok || !resultMatchesMethod('snapshot/get', result)) {
        this.failSession(session);
        return;
      }
      clearTimeout(session.startupTimer);
      session.startupTimer = undefined;
      session.phase = 'online';
      this.publishSnapshot(session, result.snapshot);
      if (this.current === session && session.phase === 'online' && !this.stopping) this.setStatus('READY');
      return;
    }
    if (session.phase !== 'online') return;
    const pending = session.pending.get(requestId);
    if (!pending) return; // Unknown, duplicate, or timed-out result: no side effects.
    if (!resultMatchesMethod(pending.method, result)) {
      this.failSession(session);
      return;
    }
    session.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (!result.ok && result.error.code === 'SERVICE_UNAVAILABLE' && !result.error.retryable) {
      // A permanent storage failure requires a fresh writer, not a retry in
      // the same process. Surface the original closed DTO to its caller.
      this.failSession(session);
    } else if (result.ok) {
      this.publishSnapshot(session, result.snapshot);
    }
    pending.resolve(result);
  }

  private failPending(session: Session): void {
    for (const [requestId, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.resolve(unavailable(requestId));
    }
    session.pending.clear();
  }

  private failSession(session: Session): void {
    if (this.current !== session || session.phase === 'closing') return;
    this.closeSession(session);
    if (this.current === session && !this.stopping) {
      this.setStatus(this.restartCount < this.maxRestarts ? 'RESTARTING' : 'UNAVAILABLE');
    }
    // Only onExit may clear this.current and arrange a replacement.
  }

  private closeSession(session: Session): void {
    if (this.current !== session || session.phase === 'closing') return;
    session.phase = 'closing';
    clearTimeout(session.startupTimer);
    session.startupTimer = undefined;
    this.failPending(session);
    session.features?.close();
    session.shutdownTimer = setTimeout(() => { this.kill(session); }, this.shutdownTimeoutMs);
    try {
      this.post(session, { kind: 'shutdown' });
    } catch {
      this.kill(session);
    }
  }

  private kill(session: Session): void {
    if (this.current !== session) return;
    // A returned boolean (or a thrown error) isn't proof of exit. In either
    // case wait for the exit event; it is unsafe to replace a potential writer.
    try { session.child.kill(); } catch { /* wait for confirmed exit */ }
  }

  private onExit(session: Session): void {
    if (this.current !== session) return;
    clearTimeout(session.startupTimer);
    clearTimeout(session.shutdownTimer);
    this.failPending(session);
    session.features?.close();
    this.current = undefined;
    if (this.stopping) this.finishStop();
    else this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.current || this.restartTimer) return;
    if (this.restartCount >= this.maxRestarts) {
      this.setStatus('UNAVAILABLE');
      return;
    }
    this.restartCount += 1;
    // Lifetime budget prevents a tight crash loop even if every spawn briefly
    // becomes healthy. Cap the exponential delay to a reasonable bound.
    const delay = Math.min(this.restartDelayMs * 2 ** Math.min(this.restartCount - 1, 30), 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnNext();
    }, delay);
    this.setStatus('RESTARTING');
  }

  private finishStop(): void {
    this.setStatus('UNAVAILABLE');
    this.resolveStop?.();
    this.resolveStop = undefined;
  }
}
