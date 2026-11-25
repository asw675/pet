import { z } from 'zod';
import { appSnapshotSchema, idSchema, ipcRequestSchema, ipcResultSchema, nonnegativeIntegerSchema } from '@pet-desktop/contracts';
import type { ActiveTravelIpcResult, AppBridge, AppSnapshot, CharactersIpcResult, GalleryIpcResult, GalleryQuery, InventoryIpcResult,
  TravelCatalogIpcResult, TravelPreviewIpcResult, TravelReportsIpcResult, EventsIpcResult } from '@pet-desktop/contracts';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import type { CharacterPackChanged, CharacterPackResult } from './character-pack-ipc';
import type { DiagnosticsExportResult } from './diagnostics-ipc';
import type { TripPreparationPayload, TravelReportsQuery } from '@pet-desktop/contracts/travel';
import { featureInputSchema, featureOutputSchema } from './feature-protocol';
import type { AiIntent, AiResult, CredentialSave, CredentialRevoke } from './ai-ipc';
import type { AiCancelReason,ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { VoiceChatIdentity, VoiceMicGrant, VoiceMouthNotification, VoiceOwnedJob, VoiceServiceRequest, VoiceServiceResult } from './voice-ipc';
import type {VoiceSettingsRequest,VoiceSettingsResult} from './voice-settings-ipc';
import type {WorkspaceIntent,WorkspaceResult} from './workspace-ipc';
import type { ProactiveDesktopBubble, ProactiveIntent, ProactiveNoticeReady, ProactiveResult } from './proactive-ipc';

import type { BackupViewResult, HostPreferenceSave, HostPreferencesViewResult, HostRenderPreferences, HostSettingsResult, PeriodicBackupStatus, RestoreBackupResult, RestoreBackupStatus } from './host-settings-ipc';
import type { HostShortcutBindingsEdit, HostShortcutBindingsResult, PetScaleDirection } from './host-settings-ipc';

export const DESKTOP_IPC = Object.freeze({
  exportDiagnostics: 'pet-desktop:export-diagnostics:v1',
  characterPackRequest: 'pet-desktop:character-pack-request:v1',
  characterPackChanged: 'pet-desktop:character-pack-changed:v1',
  hostRequest: 'pet-desktop:host-settings:v1',
  hostRenderPreferences: 'pet-desktop:host-render-preferences:v1',
  request: 'pet-desktop:request:v1',
  snapshot: 'pet-desktop:snapshot:v1',
  getStatus: 'pet-desktop:get-status:v1',
  status: 'pet-desktop:status:v1',
  openControlCenter: 'pet-desktop:open-control-center:v1',
  petInteractive: 'pet-desktop:pet-interactive:v1',
  petDrag: 'pet-desktop:pet-drag:v1',
  changePetScale: 'pet-desktop:change-pet-scale:v1',
  petVisualReady: 'pet-desktop:pet-visual-ready:v1',
  aiRequest:'pet-desktop:ai-request:v1',chatEvent:'pet-desktop:chat-event:v1',credentialSave:'pet-desktop:credential-save:v1',credentialRevoke:'pet-desktop:credential-revoke:v1',
  voiceRequest:'pet-desktop:voice-request:v1',micAuthorize:'pet-desktop:mic-authorize:v1',micRequest:'pet-desktop:mic-request:v1',micRevoke:'pet-desktop:mic-revoke:v1',
  voiceChatCancel:'pet-desktop:voice-chat-cancel:v1',voiceMouth:'pet-desktop:voice-mouth:v1',voiceSuspend:'pet-desktop:voice-suspend:v1',
  voiceSettingsRequest:'pet-desktop:voice-settings:v1',workspaceRequest:'pet-desktop:workspace:v1',
  proactiveRequest: 'pet-desktop:proactive:v1',
  proactiveNotice: 'pet-desktop:proactive-notice:v1',
  proactiveBubble: 'pet-desktop:proactive-bubble:v1',
});

export const serviceStatusSchema = z.strictObject({
  stage: z.enum(['STARTING', 'READY', 'RESTARTING', 'UNAVAILABLE', 'STOPPING']),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const hostActionResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['FORBIDDEN', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE']) }),
]);
export type HostActionResult = z.infer<typeof hostActionResultSchema>;

export const petDragRequestSchema = z.strictObject({
  phase: z.enum(['begin', 'move', 'end', 'cancel']),
  gestureId: z.uuid(),
});
export type PetDragRequest = z.infer<typeof petDragRequestSchema>;

/** A visual completion signal, not a domain action or arbitrary resource reference.
 * The host derives the pet identity from the sending pet window. */
export const petVisualReadySchema = z.strictObject({
  characterId: idSchema,
  generation: nonnegativeIntegerSchema,
  result: z.enum(['READY', 'FALLBACK']),
});
export type PetVisualReady = z.infer<typeof petVisualReadySchema>;

export type DesktopRole = 'pet' | 'control-center';
export interface DesktopBridgeBase extends AppBridge {
  getServiceStatus(): Promise<ServiceStatus>;
  subscribeServiceStatus(listener: (status: ServiceStatus) => void): () => void;
  openControlCenter(): Promise<HostActionResult>;
}

export interface PetDesktopBridge extends DesktopBridgeBase {
  readonly role: 'pet';
  readCharacterPack(characterId: string): Promise<CharacterPackResult>;
  subscribeCharacterPackChanged(listener: (change: CharacterPackChanged) => void): () => void;
  setInteractive(interactive: boolean): Promise<HostActionResult>;
  dragPetWindow(request: PetDragRequest): Promise<HostActionResult>;
  changePetScale(direction: PetScaleDirection): Promise<HostActionResult>;
  reportVisualReady(report: PetVisualReady): Promise<HostActionResult>;
  subscribeHostRenderPreferences(listener: (value: HostRenderPreferences) => void): () => void;
  subscribeVoiceMouth(listener:(event:VoiceMouthNotification)=>void):()=>void;
  subscribeProactiveBubble(listener: (bubble: ProactiveDesktopBubble) => void): () => void;
}
export interface ControlCenterBridge extends DesktopBridgeBase {
  readonly role: 'control-center';
  listCharacterPacks(): Promise<CharacterPackResult>;
  importCharacterPack(): Promise<CharacterPackResult>;
  activateCharacterPack(change: CharacterPackChanged): Promise<CharacterPackResult>;
  getHostSettings(): Promise<HostSettingsResult>;
  setHostShortcutEnabled(enabled: boolean): Promise<HostSettingsResult>;
  getHostShortcutBindings(): Promise<HostShortcutBindingsResult>;
  saveHostShortcutBindings(edit: HostShortcutBindingsEdit): Promise<HostShortcutBindingsResult>;
  setLoginStart(enabled: boolean): Promise<HostSettingsResult>;
  getHostPreferences(): Promise<HostPreferencesViewResult>;
  saveHostPreferences(edit: HostPreferenceSave): Promise<HostPreferencesViewResult>;
  exportBackup(): Promise<BackupViewResult>;
  exportDiagnostics(): Promise<DiagnosticsExportResult>;
  restoreBackup(): Promise<RestoreBackupResult>;
  getRestoreBackupStatus(): Promise<RestoreBackupStatus>;
  getPeriodicBackupStatus(): Promise<PeriodicBackupStatus>;
  listGallery(query: GalleryQuery): Promise<GalleryIpcResult>;
  listCharacters(): Promise<CharactersIpcResult>;
  listInventory(legacyOffset?: number): Promise<InventoryIpcResult>;
  listActiveTravel(): Promise<ActiveTravelIpcResult>;
  listTravelCatalog(): Promise<TravelCatalogIpcResult>;
  previewTravel(input: TripPreparationPayload): Promise<TravelPreviewIpcResult>;
  listTravelReports(query: TravelReportsQuery): Promise<TravelReportsIpcResult>;
  listEvents(query: EventListQuery): Promise<EventsIpcResult>;
  aiRequest(intent:AiIntent):Promise<AiResult>;
  subscribeChatEvents(listener:(event:ChatStreamEvent)=>void):()=>void;
  saveProviderCredential(payload:CredentialSave):Promise<HostActionResult>;
  revokeProviderCredential(payload:CredentialRevoke):Promise<HostActionResult>;
  voiceRequest(request:VoiceServiceRequest):Promise<VoiceServiceResult>;
  voiceSettingsRequest(request:VoiceSettingsRequest):Promise<VoiceSettingsResult>;
  workspaceRequest(intent:WorkspaceIntent):Promise<WorkspaceResult>;
  proactiveRequest(intent: ProactiveIntent): Promise<ProactiveResult>;
  subscribeProactiveNotices(listener: (notice: ProactiveNoticeReady) => void): () => void;
  authorizeMicrophone():Promise<HostActionResult>;
  requestMic(job:VoiceOwnedJob):Promise<VoiceMicGrant|null>;
  revokeMic(grant:VoiceMicGrant):Promise<void>;
  cancelVoiceChat(identity:VoiceChatIdentity,reason:AiCancelReason):Promise<boolean>;
  publishMouth(event:VoiceMouthNotification):Promise<void>;
  subscribeSuspend(listener:()=>void):()=>void;
}
export type DesktopBridge = PetDesktopBridge | ControlCenterBridge;

export const serviceInputSchema = z.union([z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), request: ipcRequestSchema }),
  z.strictObject({ kind: z.literal('shutdown') }),
]),featureInputSchema]);
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const serviceOutputSchema = z.union([z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), schemaVersion: z.literal(1),
    sqliteVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), driver: z.literal('better-sqlite3') }),
  z.strictObject({ kind: z.literal('result'), result: ipcResultSchema }),
  z.strictObject({ kind: z.literal('snapshot'), snapshot: appSnapshotSchema }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({ kind: z.literal('fatal'), code: z.enum([
    'INVALID_STARTUP', 'STARTUP_FAILED', 'PROTOCOL_ERROR', 'SERVICE_FAILED', 'CLOSE_FAILED',
  ]) }),
]),featureOutputSchema]);
export type ServiceOutput = z.infer<typeof serviceOutputSchema>;

export type SnapshotListener = (snapshot: AppSnapshot) => void;
export type StatusListener = (status: ServiceStatus) => void;
