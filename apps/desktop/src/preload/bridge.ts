import {
  activeTravelIpcResultSchema, CONTRACT_SCHEMA_VERSION, appSnapshotSchema, charactersIpcResultSchema, galleryIpcResultSchema, inventoryIpcResultSchema, ipcRequestSchema,
  resultMatchesMethod, snapshotIpcResultSchema, travelCatalogIpcResultSchema, travelPreviewIpcResultSchema, travelReportsIpcResultSchema, eventsIpcResultSchema,
} from '@pet-desktop/contracts';
import type {
  ActiveTravelIpcResult, AppSnapshot, CharactersIpcResult, DomainCommand, GalleryIpcResult, GalleryQuery, IpcErrorCode, IpcRequest,
  IpcResult, SnapshotIpcResult, InventoryIpcResult, TravelCatalogIpcResult, TravelPreviewIpcResult, TravelReportsIpcResult, EventsIpcResult,
} from '@pet-desktop/contracts';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import { characterPackChangedSchema, characterPackRequestSchema, characterPackResultMatches, characterPackResultSchema } from '../shared/character-pack-ipc';
import type { CharacterPackChanged, CharacterPackResult } from '../shared/character-pack-ipc';
import { chatStreamEventSchema } from '@pet-desktop/contracts/ai';
import { aiIntentSchema,aiResultMatches,aiResultSchema,credentialSaveSchema,credentialRevokeSchema } from '../shared/ai-ipc';
import type { AiIntent,AiRequest,AiResult,CredentialSave,CredentialRevoke } from '../shared/ai-ipc';
import { voiceServiceRequestSchema,voiceServiceResultSchema,voiceResultMatchesRequest,voiceOwnedJobSchema,voiceMicGrantSchema,sameVoiceJob,voiceChatCancelSchema,voiceMouthNotificationSchema } from '../shared/voice-ipc';
import type { VoiceServiceRequest,VoiceServiceResult,VoiceOwnedJob,VoiceMicGrant,VoiceChatIdentity,VoiceMouthNotification } from '../shared/voice-ipc';
import type { AiCancelReason,ChatStreamEvent } from '@pet-desktop/contracts/ai';
import { z } from 'zod';
import {voiceSettingsRequestSchema,voiceSettingsResultSchema,voiceSettingsResultMatchesRequest} from '../shared/voice-settings-ipc';
import type {VoiceSettingsRequest,VoiceSettingsResult} from '../shared/voice-settings-ipc';
import {workspaceIntentSchema,workspaceResultSchema,workspaceResultMatches} from '../shared/workspace-ipc';
import type {WorkspaceIntent,WorkspaceRequest,WorkspaceResult} from '../shared/workspace-ipc';
import {
  proactiveDesktopBubbleSchema, proactiveFailure, proactiveIntentSchema, proactiveNoticeReadySchema, proactiveResultMatches, proactiveResultSchema,
} from '../shared/proactive-ipc';
import type { ProactiveDesktopBubble, ProactiveIntent, ProactiveNoticeReady, ProactiveRequest, ProactiveResult } from '../shared/proactive-ipc';
import type { TripPreparationPayload, TravelReportsQuery } from '@pet-desktop/contracts/travel';
import {
  DESKTOP_IPC, hostActionResultSchema, petVisualReadySchema, serviceStatusSchema,
} from '../shared/protocol.js';
import type {
  ControlCenterBridge, DesktopBridgeBase, HostActionResult, PetDesktopBridge, PetVisualReady, ServiceStatus,
} from '../shared/protocol.js';

import {
  backupViewResultSchema, hostPreferencesViewResultSchema, hostRendererRequestSchema, hostRenderPreferencesSchema, hostSettingsResultSchema,
  hostShortcutBindingsResultSchema,
  periodicBackupStatusSchema, petScaleDirectionSchema, restoreBackupResultSchema, restoreBackupStatusSchema,
} from '../shared/host-settings-ipc';
import type { HostPreferenceSave, HostRenderPreferences, HostShortcutBindingsEdit, PetScaleDirection } from '../shared/host-settings-ipc';
import { diagnosticsExportResultSchema } from '../shared/diagnostics-ipc';
import type { DiagnosticsExportResult } from '../shared/diagnostics-ipc';

type InvokeChannel = typeof DESKTOP_IPC.characterPackRequest | typeof DESKTOP_IPC.hostRequest | typeof DESKTOP_IPC.request | typeof DESKTOP_IPC.getStatus
  | typeof DESKTOP_IPC.openControlCenter | typeof DESKTOP_IPC.petInteractive | typeof DESKTOP_IPC.changePetScale
  | typeof DESKTOP_IPC.petVisualReady | typeof DESKTOP_IPC.aiRequest | typeof DESKTOP_IPC.credentialSave | typeof DESKTOP_IPC.credentialRevoke
  | typeof DESKTOP_IPC.voiceRequest | typeof DESKTOP_IPC.micAuthorize | typeof DESKTOP_IPC.micRequest | typeof DESKTOP_IPC.micRevoke
  | typeof DESKTOP_IPC.proactiveRequest
  | typeof DESKTOP_IPC.exportDiagnostics
  | typeof DESKTOP_IPC.voiceChatCancel | typeof DESKTOP_IPC.voiceMouth | typeof DESKTOP_IPC.voiceSettingsRequest | typeof DESKTOP_IPC.workspaceRequest;
type PushChannel = typeof DESKTOP_IPC.hostRenderPreferences | typeof DESKTOP_IPC.snapshot | typeof DESKTOP_IPC.status | typeof DESKTOP_IPC.chatEvent | typeof DESKTOP_IPC.voiceMouth | typeof DESKTOP_IPC.voiceSuspend
  | typeof DESKTOP_IPC.proactiveNotice | typeof DESKTOP_IPC.proactiveBubble;
type PushListener = (event: unknown, ...args: unknown[]) => void;

/** Internal transport seam; only the explicit bridge below crosses contextBridge. */
export interface DesktopIpcPort {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>;
  on(channel: PushChannel | typeof DESKTOP_IPC.characterPackChanged, listener: PushListener): unknown;
  removeListener(channel: PushChannel | typeof DESKTOP_IPC.characterPackChanged, listener: PushListener): unknown;
}

type Parser<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

function parse<T>(schema: Parser<T>, value: unknown): T | undefined {
  try {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** WebCrypto works in a sandboxed preload without loading a Node builtin. */
function newRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `request-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const publicMessages: Record<IpcErrorCode, string> = {
  INVALID_REQUEST: 'Invalid application request.',
  FORBIDDEN: 'This operation is not permitted.',
  NOT_FOUND: 'The requested resource does not exist.',
  REVISION_CONFLICT: 'Game state has changed. Refresh the snapshot first.',
  COMMAND_CONFLICT: 'This command ID has already been used.',
  BUSINESS_RULE: 'The operation is not allowed in the current game state.',
  SERVICE_UNAVAILABLE: 'The application service is unavailable.',
  TIMEOUT: 'The application request timed out.',
  INTERNAL_ERROR: 'The application could not complete the operation.',
};

function failure(requestId: string, code: IpcErrorCode, retryable: boolean): Extract<IpcResult, { ok: false }> {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    ok: false,
    error: { requestId, code, retryable, message: publicMessages[code] },
  };
}

/** Each subscription owns its own wrapper and can be disposed independently. */
function subscribe<T>(ipc: DesktopIpcPort, channel: PushChannel | typeof DESKTOP_IPC.characterPackChanged, schema: Parser<T>,
  listener: (value: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
  let notify: ((value: T) => void) | undefined = listener;
  const wrapped: PushListener = (_event, ...args) => {
    if (!notify || args.length !== 1) return;
    const value = parse(schema, args[0]);
    if (value === undefined) return;
    // Never forward the Electron event, and isolate renderer callback failures.
    try { notify(value); } catch { /* Other subscriptions must still receive the update. */ }
  };
  const unsubscribe = () => {
    if (!notify) return;
    notify = undefined;
    ipc.removeListener(channel, wrapped);
  };
  ipc.on(channel, wrapped);
  return unsubscribe;
}

// Intentionally exhaustive: adding another authority method requires choosing
// its exact parser, not silently defaulting to a broad union or snapshot shape.
const requestResultParsers = {
  'snapshot/get': snapshotIpcResultSchema,
  'command/dispatch': snapshotIpcResultSchema,
  'gallery/list': galleryIpcResultSchema,
  'characters/list': charactersIpcResultSchema,
  'inventory/list': inventoryIpcResultSchema,
  'travel/active': activeTravelIpcResultSchema,
  'travel/catalog': travelCatalogIpcResultSchema,
  'travel/preview': travelPreviewIpcResultSchema,
  'travel/reports': travelReportsIpcResultSchema,
  'events/list': eventsIpcResultSchema,
} satisfies Record<IpcRequest['method'], Parser<IpcResult>>;

/** Request and reply shapes are correlated by both id and closed request method.
 * Catalog replies must not enter a different catalog or ordinary snapshot/command API. */
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'gallery/list', payload: unknown): Promise<GalleryIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'characters/list', payload: unknown): Promise<CharactersIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'inventory/list', payload: unknown): Promise<InventoryIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/active', payload: unknown): Promise<ActiveTravelIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/catalog', payload: unknown): Promise<TravelCatalogIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/preview', payload: unknown): Promise<TravelPreviewIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/reports', payload: unknown): Promise<TravelReportsIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'events/list', payload: unknown): Promise<EventsIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'snapshot/get' | 'command/dispatch', payload: unknown): Promise<SnapshotIpcResult>;
async function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: IpcRequest['method'], payload: unknown): Promise<IpcResult> {
  const id = requestId();
  const request = parse(ipcRequestSchema, {
    schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: id, method, payload,
  });
  if (request === undefined) return failure(id, 'INVALID_REQUEST', false);
  try {
    const response = await ipc.invoke(DESKTOP_IPC.request, request);
    // Catalog parsers additionally require coherence with the included
    // authority snapshot (revision, and wallet for the character catalog).
    const result = parse<IpcResult>(requestResultParsers[method], response);
    if (result === undefined || (result.ok ? result.requestId : result.error.requestId) !== id
      || !resultMatchesMethod(method, result)) {
      return failure(id, 'INTERNAL_ERROR', true);
    }
    if (result.ok) {
      if (request.method === 'gallery/list' && 'gallery' in result
        && (result.gallery.offset !== request.payload.offset || result.gallery.limit !== request.payload.limit)) {
        return failure(id, 'INTERNAL_ERROR', true);
      }
      if (request.method === 'inventory/list' && 'inventory' in result
        && result.inventory.legacyStackOffset !== (request.payload.legacyOffset ?? 0)) return failure(id, 'INTERNAL_ERROR', true);
      if (request.method === 'travel/preview' && 'travelPreview' in result) {
        const quote = result.travelPreview, intent = request.payload;
        if (quote.petId !== intent.petId || quote.requestedRouteId !== intent.routeId
          || quote.selectedSupplies.length !== intent.selectedSupplies.length
          || quote.selectedSupplies.some((entry) => !intent.selectedSupplies.some((other) => other.itemId === entry.itemId && other.quantity === entry.quantity))) return failure(id, 'INTERNAL_ERROR', true);
      }
      if (request.method === 'travel/reports' && 'travelReports' in result
        && (result.travelReports.offset !== request.payload.offset || result.travelReports.limit !== request.payload.limit
          || result.travelReports.petId !== (request.payload.petId ?? null))) return failure(id, 'INTERNAL_ERROR', true);
      if (request.method === 'events/list' && 'events' in result
        && (result.events.offset !== request.payload.offset || result.events.limit !== request.payload.limit
          || result.events.petId !== (request.payload.petId ?? null) || result.events.filter !== request.payload.filter)) return failure(id, 'INTERNAL_ERROR', true);
      return result;
    }
    // The error code and retryability are contractual; free-text errors are not trusted.
    return failure(id, result.error.code, result.error.retryable);
  } catch {
    return failure(id, 'SERVICE_UNAVAILABLE', true);
  }
}

function baseBridge(ipc: DesktopIpcPort, requestId: () => string): DesktopBridgeBase {
  let lastGeneration = 0;
  const observeStatus = (status: ServiceStatus): ServiceStatus => {
    lastGeneration = Math.max(lastGeneration, status.generation);
    return status;
  };

  return {
    getSnapshot: () => sendRequest(ipc, requestId, 'snapshot/get', {}),
    dispatch: (command: DomainCommand) => sendRequest(ipc, requestId, 'command/dispatch', { command }),
    subscribeSnapshot: (listener: (snapshot: AppSnapshot) => void) =>
      subscribe(ipc, DESKTOP_IPC.snapshot, appSnapshotSchema, listener),
    async getServiceStatus() {
      try {
        const status = parse(serviceStatusSchema, await ipc.invoke(DESKTOP_IPC.getStatus));
        if (status !== undefined) return observeStatus(status);
      } catch { /* An unavailable transport has no status payload. */ }
      return { stage: 'UNAVAILABLE', generation: lastGeneration };
    },
    subscribeServiceStatus(listener) {
      if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
      return subscribe(ipc, DESKTOP_IPC.status, serviceStatusSchema, (status) => listener(observeStatus(status)));
    },
    openControlCenter: () => hostAction(ipc, DESKTOP_IPC.openControlCenter),
  };
}

type HostActionInvoke =
  | [channel: typeof DESKTOP_IPC.openControlCenter]
  | [channel: typeof DESKTOP_IPC.petInteractive, interactive: boolean]
  | [channel: typeof DESKTOP_IPC.changePetScale, direction: PetScaleDirection]
  | [channel: typeof DESKTOP_IPC.petVisualReady, report: PetVisualReady]
  | [channel:typeof DESKTOP_IPC.micAuthorize]
  | [channel:typeof DESKTOP_IPC.credentialSave,payload:CredentialSave]
  | [channel:typeof DESKTOP_IPC.credentialRevoke,payload:CredentialRevoke];

async function hostAction(ipc: DesktopIpcPort, ...call: HostActionInvoke): Promise<HostActionResult> {
  const [channel, ...args] = call;
  try {
    const result = parse(hostActionResultSchema, await ipc.invoke(channel, ...args));
    if (result !== undefined) return result;
  } catch { /* Do not expose transport exceptions or internal stack traces. */ }
  return { ok: false, code: 'SERVICE_UNAVAILABLE' };
}

async function hostRequest<T>(ipc: DesktopIpcPort, raw: unknown, schema: Parser<T>, invalid: T, unavailable: T): Promise<T> {
  const request = parse(hostRendererRequestSchema, raw);
  if (!request) return invalid;
  try { return parse(schema, await ipc.invoke(DESKTOP_IPC.hostRequest, request)) ?? unavailable; }
  catch { return unavailable; }
}

const invalidSetting = { ok: false, code: 'INVALID_REQUEST', settings: null } as const;
const unavailableSetting = { ok: false, code: 'SERVICE_UNAVAILABLE', settings: null } as const;
const invalidPreference = { ok: false, code: 'INVALID_REQUEST' } as const;
const unavailablePreference = { ok: false, code: 'SERVICE_UNAVAILABLE' } as const;

async function characterPackRequest(ipc: DesktopIpcPort, input: unknown): Promise<CharacterPackResult> {
  const request = parse(characterPackRequestSchema, input);
  if (!request) return { ok: false, code: 'INVALID_REQUEST' };
  try {
    const result = parse(characterPackResultSchema, await ipc.invoke(DESKTOP_IPC.characterPackRequest, request));
    if (result && characterPackResultMatches(request, result)) return result;
  } catch { /* An untrusted reply must not be exposed as pack data. */ }
  return { ok: false, code: 'STORAGE_ERROR' };
}

export function createPetBridge(ipc: DesktopIpcPort, requestId = newRequestId): PetDesktopBridge {
  return Object.freeze({
    role: 'pet',
    ...baseBridge(ipc, requestId),
    readCharacterPack: (characterId: string) => characterPackRequest(ipc, { kind: 'read', characterId }),
    subscribeCharacterPackChanged: (listener: (change: CharacterPackChanged) => void) =>
      subscribe(ipc, DESKTOP_IPC.characterPackChanged, characterPackChangedSchema, listener),
    subscribeHostRenderPreferences: (listener: (value: HostRenderPreferences) => void) =>
      subscribe(ipc, DESKTOP_IPC.hostRenderPreferences, hostRenderPreferencesSchema, listener),
    subscribeVoiceMouth:(listener:(event:VoiceMouthNotification)=>void)=>subscribe(ipc,DESKTOP_IPC.voiceMouth,voiceMouthNotificationSchema,listener),
    subscribeProactiveBubble: (listener: (bubble: ProactiveDesktopBubble) => void) =>
      subscribe(ipc, DESKTOP_IPC.proactiveBubble, proactiveDesktopBubbleSchema, listener),
    async setInteractive(interactive: boolean): Promise<HostActionResult> {
      if (typeof interactive !== 'boolean') return { ok: false, code: 'INVALID_REQUEST' };
      return hostAction(ipc, DESKTOP_IPC.petInteractive, interactive);
    },
    async changePetScale(...args: [direction: PetScaleDirection]): Promise<HostActionResult> {
      const direction = parse(petScaleDirectionSchema, args[0]);
      if (args.length !== 1 || direction === undefined) return { ok: false, code: 'INVALID_REQUEST' };
      return hostAction(ipc, DESKTOP_IPC.changePetScale, direction);
    },
    async reportVisualReady(report: PetVisualReady): Promise<HostActionResult> {
      const parsed = parse(petVisualReadySchema, report);
      if (parsed === undefined) return { ok: false, code: 'INVALID_REQUEST' };
      return hostAction(ipc, DESKTOP_IPC.petVisualReady, parsed);
    },
  });
}

export function createControlCenterBridge(ipc: DesktopIpcPort, requestId = newRequestId): ControlCenterBridge {
  return Object.freeze({
    role: 'control-center',
    listCharacterPacks: () => characterPackRequest(ipc, { kind: 'list' }),
    importCharacterPack: () => characterPackRequest(ipc, { kind: 'import' }),
    activateCharacterPack: (change: CharacterPackChanged) => {
      const parsed = parse(characterPackChangedSchema, change);
      return characterPackRequest(ipc, parsed ? { ...parsed, kind: 'activate' } : undefined);
    },
    getHostSettings: () => hostRequest(ipc, { kind: 'settings' }, hostSettingsResultSchema, invalidSetting, unavailableSetting),
    setHostShortcutEnabled: (enabled: boolean) => hostRequest(ipc, { kind: 'shortcuts', enabled }, hostSettingsResultSchema, invalidSetting, unavailableSetting),
    getHostShortcutBindings: () => hostRequest(ipc, { kind: 'shortcut-bindings' }, hostShortcutBindingsResultSchema, invalidPreference, unavailablePreference),
    saveHostShortcutBindings: (edit: HostShortcutBindingsEdit) => hostRequest(ipc, { kind: 'save-shortcut-bindings', edit }, hostShortcutBindingsResultSchema, invalidPreference, unavailablePreference),
    setLoginStart: (enabled: boolean) => hostRequest(ipc, { kind: 'login', enabled }, hostSettingsResultSchema, invalidSetting, unavailableSetting),
    getHostPreferences: () => hostRequest(ipc, { kind: 'preferences' }, hostPreferencesViewResultSchema, invalidPreference, unavailablePreference),
    saveHostPreferences: (payload: HostPreferenceSave) => hostRequest(ipc, { kind: 'save', edit: payload }, hostPreferencesViewResultSchema, invalidPreference, unavailablePreference),
    exportBackup: () => hostRequest(ipc, { kind: 'backup' }, backupViewResultSchema, invalidPreference, unavailablePreference),
    async exportDiagnostics(...args: unknown[]): Promise<DiagnosticsExportResult> {
      if (args.length !== 0) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        return parse(diagnosticsExportResultSchema, await ipc.invoke(DESKTOP_IPC.exportDiagnostics)) ?? { ok: false, code: 'UNAVAILABLE' };
      } catch { return { ok: false, code: 'UNAVAILABLE' }; }
    },
    restoreBackup: () => hostRequest(ipc, { kind: 'restore-backup' }, restoreBackupResultSchema, invalidPreference, unavailablePreference),
    getRestoreBackupStatus: () => hostRequest(ipc, { kind: 'restore-status' }, restoreBackupStatusSchema, invalidPreference, unavailablePreference),
    getPeriodicBackupStatus: () => hostRequest(ipc, { kind: 'periodic-backup-status' }, periodicBackupStatusSchema, invalidPreference, unavailablePreference),
    ...baseBridge(ipc, requestId),
    listGallery: (query: GalleryQuery) => sendRequest(ipc, requestId, 'gallery/list', query),
    async listCharacters(...args: unknown[]): Promise<CharactersIpcResult> {
      // This capability has no input. The rest parameter detects JS callers
      // trying to supply their own data even when bypassing TypeScript.
      if (args.length !== 0) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'characters/list', {});
    },
    async listInventory(...args: unknown[]): Promise<InventoryIpcResult> {
      if (args.length > 1 || (args.length === 1 && typeof args[0] !== 'number')) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'inventory/list', args.length === 0 ? {} : { legacyOffset: args[0] });
    },
    listActiveTravel: () => sendRequest(ipc, requestId, 'travel/active', {}),
    async listTravelCatalog(...args: unknown[]): Promise<TravelCatalogIpcResult> {
      if (args.length !== 0) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'travel/catalog', {});
    },
    previewTravel: (input: TripPreparationPayload) => sendRequest(ipc, requestId, 'travel/preview', input),
    listTravelReports: (query: TravelReportsQuery) => sendRequest(ipc, requestId, 'travel/reports', query),
    listEvents: (query: EventListQuery) => sendRequest(ipc, requestId, 'events/list', query),
    async aiRequest(raw:AiIntent):Promise<AiResult>{
      const id=requestId(),intent=parse(aiIntentSchema,raw);
      const fail=(code:'UNSUPPORTED'|'UNAVAILABLE'|'INTERNAL_ERROR',method:AiIntent['method']='settings/list'):AiResult=>({ok:false,requestId:id,method,error:{code,message:'AI 请求未能完成，请刷新后重试。',retryable:code!=='UNSUPPORTED'}});
      if(!intent)return fail('UNSUPPORTED');
      const request:AiRequest={requestId:id,intent};
      try{
        const result=parse(aiResultSchema,await ipc.invoke(DESKTOP_IPC.aiRequest,request));
        if(!result||!aiResultMatches(request,result))return fail('INTERNAL_ERROR',intent.method);
        return result.ok?result:{...result,error:{...result.error,message:'AI 操作未完成，请检查当前设置或对话。'}};
      }catch{return fail('UNAVAILABLE',intent.method);}
    },
    subscribeChatEvents:(listener:(event:ChatStreamEvent)=>void)=>subscribe(ipc,DESKTOP_IPC.chatEvent,chatStreamEventSchema,listener),
    async proactiveRequest(raw: ProactiveIntent): Promise<ProactiveResult> {
      const id = requestId(), intent = parse(proactiveIntentSchema, raw);
      if (!intent) return proactiveFailure({ requestId: id, intent: { method: 'settings/get' } }, 'INVALID_REQUEST');
      const request: ProactiveRequest = { requestId: id, intent };
      try {
        const result = parse(proactiveResultSchema, await ipc.invoke(DESKTOP_IPC.proactiveRequest, request));
        if (result && proactiveResultMatches(request, result)) return result;
      } catch { /* reader waits for the next explicit refresh */ }
      return proactiveFailure(request);
    },
    subscribeProactiveNotices: (listener: (event: ProactiveNoticeReady) => void) =>
      subscribe(ipc, DESKTOP_IPC.proactiveNotice, proactiveNoticeReadySchema, listener),
    async saveProviderCredential(payload:CredentialSave):Promise<HostActionResult>{const value=parse(credentialSaveSchema,payload);return value?hostAction(ipc,DESKTOP_IPC.credentialSave,value):{ok:false,code:'INVALID_REQUEST'};},
    async revokeProviderCredential(payload:CredentialRevoke):Promise<HostActionResult>{const value=parse(credentialRevokeSchema,payload);return value?hostAction(ipc,DESKTOP_IPC.credentialRevoke,value):{ok:false,code:'INVALID_REQUEST'};},
    async voiceRequest(raw:VoiceServiceRequest):Promise<VoiceServiceResult>{
      const request=parse(voiceServiceRequestSchema,raw);if(!request)return{ok:false,kind:'error',code:'invalid_audio'};
      const fail:VoiceServiceResult={ok:false,kind:'error',code:'unavailable',...('job'in request?{job:request.job}:{})};
      try{const result=parse(voiceServiceResultSchema,await ipc.invoke(DESKTOP_IPC.voiceRequest,request));return result&&voiceResultMatchesRequest(request,result)?result:fail;}catch{return fail;}
    },
    async voiceSettingsRequest(raw:VoiceSettingsRequest):Promise<VoiceSettingsResult>{
      const request=parse(voiceSettingsRequestSchema,raw);if(!request)return{ok:false,kind:'error',code:'INVALID_REQUEST'};
      const fail:VoiceSettingsResult={ok:false,kind:'error',code:'UNAVAILABLE',petId:request.petId};
      try{const result=parse(voiceSettingsResultSchema,await ipc.invoke(DESKTOP_IPC.voiceSettingsRequest,request));return result&&voiceSettingsResultMatchesRequest(request,result)?result:fail;}catch{return fail;}
    },
    async workspaceRequest(raw:WorkspaceIntent):Promise<WorkspaceResult>{
      const id=requestId(),intent=parse(workspaceIntentSchema,raw);
      if(!intent)return{ok:false,requestId:id,method:'workspace/list',error:{code:'INVALID_REQUEST'}};
      const request:WorkspaceRequest={requestId:id,intent};
      const fail:WorkspaceResult={ok:false,requestId:id,method:intent.method,error:{code:'SERVICE_UNAVAILABLE'}};
      try{const result=parse(workspaceResultSchema,await ipc.invoke(DESKTOP_IPC.workspaceRequest,request));return result&&workspaceResultMatches(request,result)?result:fail;}catch{return fail;}
    },
    authorizeMicrophone:(...args:unknown[])=>args.length===0?hostAction(ipc,DESKTOP_IPC.micAuthorize):Promise.resolve({ok:false,code:'INVALID_REQUEST'} as const),
    async requestMic(raw:VoiceOwnedJob):Promise<VoiceMicGrant|null>{
      const job=parse(voiceOwnedJobSchema,raw);if(!job)return null;
      try{const grant=parse(voiceMicGrantSchema,await ipc.invoke(DESKTOP_IPC.micRequest,job));return grant&&sameVoiceJob(grant.job,job)?grant:null;}catch{return null;}
    },
    async revokeMic(raw:VoiceMicGrant):Promise<void>{const grant=parse(voiceMicGrantSchema,raw);if(grant)try{await ipc.invoke(DESKTOP_IPC.micRevoke,grant);}catch{/* unavailable */}},
    async cancelVoiceChat(identity:VoiceChatIdentity,reason:AiCancelReason):Promise<boolean>{
      const request=parse(voiceChatCancelSchema,{identity,reason});if(!request)return false;
      try{return await ipc.invoke(DESKTOP_IPC.voiceChatCancel,request)===true;}catch{return false;}
    },
    async publishMouth(raw:VoiceMouthNotification):Promise<void>{const report=parse(voiceMouthNotificationSchema,raw);if(report)try{await ipc.invoke(DESKTOP_IPC.voiceMouth,report);}catch{/* unavailable */}},
    subscribeSuspend:(listener:()=>void)=>subscribe(ipc,DESKTOP_IPC.voiceSuspend,z.literal(true),()=>listener()),
  });
}
