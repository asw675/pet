import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, screen, session, shell, Tray, utilityProcess,
} from 'electron';
import type { IpcMainInvokeEvent, PermissionRequest, Rectangle, WebContents } from 'electron';
import type { AppSnapshot, IpcErrorCode } from '@pet-desktop/contracts';
import { hostShortcutIds } from '@pet-desktop/contracts/host-shortcuts';
import { inspectVoiceAudio } from '@pet-desktop/contracts/voice';
import { version as appVersion } from '../../package.json';
import { characterPackRequestSchema } from '../shared/character-pack-ipc';
import type { CharacterPackChanged, CharacterPackResult } from '../shared/character-pack-ipc';
import { CharacterPackStoreError, InstalledCharacterPacks } from './installed-character-packs';
import { DESKTOP_IPC, petVisualReadySchema } from '../shared/protocol';
import type { HostActionResult, PetVisualReady, ServiceStatus } from '../shared/protocol';
import { authorizeSender, isTrustedDocument, routeRequest } from './boundary';
import type { SenderContext, WindowBinding } from './boundary';
import { ServiceClient } from './service-client';
import type { ServiceChild } from './service-client';
import { clampBounds, InputLease, rendererUrl } from './window-policy';
import { desiredPetSurface, isCurrentVisualReport, planPetHandover, samePetSurface } from './pet-handover';
import type { PetSurfaceIdentity, PetSurfaceInfo, PetSurfacePhase } from './pet-handover';
import { canContinueWindowWalk, createWindowWalkPlan, walkPositionAt } from './walk-window-policy';
import type { WindowWalkPlan } from './walk-window-policy';
import { aiRequestSchema, aiResultSchema, aiResultMatches, credentialSaveSchema, credentialRevokeSchema } from '../shared/ai-ipc';
import type { AiRequest, AiResult } from '../shared/ai-ipc';
import { sameVoiceJob, voiceChatCancelSchema, voiceMicGrantSchema, voiceMouthNotificationSchema, voiceOwnedJobSchema,
  voiceResultMatchesRequest, voiceServiceRequestSchema, voiceServiceResultSchema } from '../shared/voice-ipc';
import type { VoiceMicGrant, VoiceMouthNotification, VoiceOwnedJob, VoiceServiceRequest, VoiceServiceResult } from '../shared/voice-ipc';
import { CredentialVault } from './credential-vault';
import { MicrophoneGrantPolicy } from './microphone-grant';
import { ForegroundFullscreenMonitor, fullscreenHides, fullscreenQuiets } from './fullscreen-policy';
import type { FullscreenState } from './fullscreen-policy';
import { WindowsFullscreenProbe } from './windows-fullscreen-probe';
import { TravelReturnNotices } from './travel-return-notices';
import {WorkspaceHost} from './workspace-host';
import {nativeArtifactPins} from '../shared/native-artifact-pins';
import {workspaceRequestSchema,workspaceResultMatches} from '../shared/workspace-ipc';
import { PROACTIVE_PULSE_MS, proactiveFailure, proactiveRequestSchema, proactiveResultMatches } from '../shared/proactive-ipc';
import type { ProactiveNoticeReady, ProactiveResult } from '../shared/proactive-ipc';
import type {WorkspaceResult} from '../shared/workspace-ipc';
import type {QuickLaunchSender} from './quick-launch-policy';
import { voiceSettingsRequestSchema, voiceSettingsResultSchema, voiceSettingsResultMatchesRequest } from '../shared/voice-settings-ipc';
import type { VoiceSettingsResult } from '../shared/voice-settings-ipc';

import { HostShortcutController } from './host-shortcuts';
import { hostRendererRequestSchema, hostScalePercents, hostWindowAnchorSchema, managedBackupDirectory, petScaleDirectionSchema } from '../shared/host-settings-ipc';
import type { BackupViewResult, HostPreferencesView, HostPreferencesViewResult, HostSettingsResult, PeriodicBackupStatus, RestoreBackupResult, RestoreBackupStatus } from '../shared/host-settings-ipc';
import type { HostShortcutBindingsResult, HostShortcutBindingsView, HostWindowAnchor } from '../shared/host-settings-ipc';
import type { DiagnosticsExportResult } from '../shared/diagnostics-ipc';
import { DesktopDiagnostics, diagnosticExitReason, recordRequestDiagnostic } from './desktop-diagnostics';

const CENTER_KEY = 'control-center';
const PET_SIZE = { width: 260, height: 295 };
const MAX_WINDOW_FAILURES = 3;
const WINDOW_FAILURE_INTERVAL = 60_000;
const TEMP_INTERACTION_MS = 20_000;
const PET_VISUAL_TIMEOUT_MS = 10_000;
const MIC_PENDING_MS = 15_000;
const MIC_CAPTURE_MS = 35_000;
const MIC_STOP_GRACE_MS = 1_000;
const MOUTH_SAMPLE_INTERVAL_MS = 25;
const devLog = (...messages: string[]) => { if (!app.isPackaged) console.info('[desktop]', ...messages); };

interface PetWindowState {
  readonly identity: PetSurfaceIdentity;
  phase: PetSurfacePhase;
  documentReady: boolean;
  visualResult: PetVisualReady['result'] | undefined;
  stagingTimer: ReturnType<typeof setTimeout> | undefined;
  retirementTimer: ReturnType<typeof setTimeout> | undefined;
  retirementDeadline: number | undefined;
}
interface WindowRecord {
  readonly key: string;
  readonly window: BrowserWindow;
  readonly binding: WindowBinding;
  readonly pet: PetWindowState | undefined;
  ready: boolean;
  readonly inputLease: InputLease;
  responsive: boolean;
  focusOnReady: boolean;
  documentReady: boolean;
  documentEpoch: number;
  featureEpoch: number;
}
type FeatureStamp = { record: WindowRecord; documentEpoch: number; featureEpoch: number; serviceGeneration: number };
interface VoiceOwner { stamp: FeatureStamp; job: VoiceOwnedJob; reserved: boolean; micUsed: boolean; durationMs?: number; mouthStarted: boolean }
interface MicLease { stamp: FeatureStamp; grant: VoiceMicGrant; consumed: boolean; revoking: boolean; timer: ReturnType<typeof setTimeout> }
interface MouthRun { owner: VoiceOwner; target: WindowRecord; durationMs: number; lastAtMs: number; lastHostAt: number; timer: ReturnType<typeof setTimeout> }
type HostService = Pick<ServiceClient, 'getStatus'|'start'|'stop'|'restart'|'recover'|'request'|'subscribeStatus'|'subscribeSnapshot'|'subscribeChat'|'requestAi'|'requestVoice'|'requestVoiceSettings'|'ownsVoice'|'cancelVoiceChat'|'revokeFeatureDocument'|'requestWorkspace'|'requestHost'>;
type ProactiveHostService = Pick<ServiceClient, 'setProactiveHost' | 'subscribeProactive' | 'requestProactive'>;
type HostVault = Pick<CredentialVault,'save'|'resolve'|'revoke'>;
type HostDiagnostics = Pick<DesktopDiagnostics, 'record' | 'publish' | 'stop'>;
interface NativeWalkRun {
  readonly senderId: number;
  readonly displayId: number;
  readonly plan: WindowWalkPlan;
  expected: { x: number; y: number };
  timer: ReturnType<typeof setInterval>;
}

function makeTrayIcon() {
  // A tiny self-contained paw silhouette, not a file loaded from the working directory.
  const size = 24;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ellipses = [[12, 15.5, 6, 5], [4.5, 9, 3, 3.6], [9, 5, 2.8, 3.7], [15, 5, 2.8, 3.7], [19.5, 9, 3, 3.6]];
      const filled = ellipses.some(([cx, cy, rx, ry]) => ((x - cx!) / rx!) ** 2 + ((y - cy!) / ry!) ** 2 <= 1);
      if (!filled) continue;
      const i = 4 * (y * size + x);
      bitmap[i] = process.platform === 'darwin' ? 0 : 230;
      bitmap[i + 1] = process.platform === 'darwin' ? 0 : 140;
      bitmap[i + 2] = process.platform === 'darwin' ? 0 : 122;
      bitmap[i + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function spawnService(databasePath: string, recoverySource?: string): ServiceChild {
  const args = recoverySource ? [databasePath, '--recover-from-backup', recoverySource] : [databasePath];
  const child = utilityProcess.fork(join(__dirname, 'app-service.cjs'), args, {
    serviceName: 'pet-desktop-app-service',
  });
  return {
    postMessage: (message) => { child.postMessage(message); },
    on: (event: 'message' | 'exit', listener: ((message: unknown) => void) | ((code: number) => void)) => {
      if (event === 'message') return child.on('message', listener as (message: unknown) => void);
      return child.on('exit', listener as (code: number) => void);
    },
    kill: () => child.kill(),
  };
}

export class DesktopHost {
  private readonly characterPacks = new InstalledCharacterPacks(app.getPath('userData'), appVersion);
  private changingCharacterPack = false;
  private readonly service: HostService & ProactiveHostService;
  private readonly credentialVault: HostVault;
  private readonly diagnostics: HostDiagnostics | undefined;
  private exportingDiagnostics = false;
  private status: ServiceStatus;
  private snapshot: AppSnapshot | undefined;
  private pendingSnapshot: AppSnapshot | undefined;
  private readonly windows = new Map<string, WindowRecord>();
  private readonly senders = new Map<number, WindowRecord>();
  private readonly anchors = new Map<string, HostWindowAnchor>();
  private readonly anchorWrites = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number[]>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly blocked = new Set<string>();
  private tray: Tray | undefined;
  private stopping = false;
  private manuallyHidden = false;
  private suspended = false;
  private locked = false;
  private readonly fullscreenMonitor: ForegroundFullscreenMonitor | undefined;
  private fullscreenEveryDisplay = false;
  private readonly travelReturnNotices = new TravelReturnNotices();
  private travelNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private travelBalloon = false;
  private inputMode: 'auto' | 'through' | 'temporary-interactive' = 'auto';
  private interactionTimer: ReturnType<typeof setTimeout> | undefined;
  private walkingAttempt: string | undefined;
  private walkingRun: NativeWalkRun | undefined;
  private readonly microphone = new MicrophoneGrantPolicy(() => randomUUID(), () => performance.now(), MIC_PENDING_MS);
  private micConsent: FeatureStamp | undefined;
  private proactiveTimer: ReturnType<typeof setInterval> | undefined;
  private proactiveTarget: WindowRecord | undefined;
  private proactivePetId: string | null | undefined;
  private micLease: MicLease | undefined;
  private voiceOwner: VoiceOwner | undefined;
  private mouthRun: MouthRun | undefined;
  private hostPreferences: HostPreferencesView | undefined;
  private changingPetScale = false;
  private shortcutBindings: HostShortcutBindingsView | undefined;
  private changingShortcutBindings = false;
  private shortcuts: HostShortcutController | undefined;
  private backupInProgress = false;
  private nativePrompt = false;
  private workspaceHost:WorkspaceHost|undefined;
  private voiceSettingsMutation: FeatureStamp | undefined;
  private readonly rendererDir = join(__dirname, '../renderer');
  private readonly devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

  constructor(databasePath: string, dependencies: {
    service?: HostService & ProactiveHostService; vault?: HostVault; diagnostics?: HostDiagnostics;
    fullscreenProbe?: Pick<WindowsFullscreenProbe, 'available' | 'sample' | 'stop'>;
  } = {}) {
    this.diagnostics = dependencies.diagnostics;
    this.credentialVault = dependencies.vault ?? new CredentialVault(join(app.getPath('userData'), 'credentials'), safeStorage);
    this.service = dependencies.service ?? new ServiceClient({ spawn: source => spawnService(databasePath, source),
      credential: (providerId, ref) => this.credentialVault.resolve(providerId, ref) });
    this.status = this.service.getStatus();
    const probe = dependencies.fullscreenProbe ?? new WindowsFullscreenProbe({
      resourcesDirectory: process.resourcesPath ?? '', expectedSha256: nativeArtifactPins.fullscreenProbeSha256,
    });
    if (probe.available) {
      this.fullscreenMonitor = new ForegroundFullscreenMonitor({
        sample: signal => probe.sample(signal), stopProbe: () => probe.stop(),
        displayForPoint: point => {
          try {
            const dip = screen.screenToDipPoint({ x: point.x, y: point.y });
            return screen.getAllDisplays().find(({ bounds }) => dip.x >= bounds.x && dip.y >= bounds.y
              && dip.x < bounds.x + bounds.width && dip.y < bounds.y + bounds.height)?.id;
          } catch { return undefined; }
        },
        onChange: () => this.applyFullscreenState(),
      });
    }
  }

  start(): void {
    this.registerIpc();
    // All generic checks and devices are denied. Only an exact audio-only
    // request from the current trusted CC document can consume one mic lease.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      let allowed = false;
      try { allowed = this.consumeMicrophonePermission(contents, permission, details); } catch { /* deny */ }
      callback(allowed);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setDevicePermissionHandler(() => false);

    this.tray = new Tray(makeTrayIcon());
    this.tray.setToolTip('Pet Desktop');
    this.tray.on('click', () => { this.openControlCenter(); });
    this.tray.on('balloon-click', () => this.openTravelReturnSummary());
    this.tray.on('balloon-closed', () => { this.travelBalloon = false; });
    this.updateTray();

    screen.on('display-added', () => this.reflowWindows());
    screen.on('display-removed', () => this.reflowWindows());
    screen.on('display-metrics-changed', () => this.reflowWindows());
    powerMonitor.on('suspend', () => { this.suspended = true; this.syncFullscreenMonitor(); this.invalidateFeatures(); this.reconcilePets(); });
    powerMonitor.on('resume', () => { this.suspended = false; this.syncFullscreenMonitor(); this.reflowWindows(); });
    powerMonitor.on('lock-screen', () => { this.locked = true; this.syncFullscreenMonitor(); this.invalidateFeatures(); this.reconcilePets(); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.syncFullscreenMonitor(); this.reflowWindows(); });
    this.syncFullscreenMonitor();

    this.service.subscribeSnapshot((snapshot) => {
      if (this.stopping) return;
      if (this.status.stage !== 'READY') { this.pendingSnapshot = snapshot; return; }
      this.acceptSnapshot(snapshot);
    });
    this.service.subscribeStatus((status) => {
      const refreshPreferences = status.stage === 'READY'
        && (this.status.stage !== 'READY' || this.status.generation !== status.generation);
      if (status.stage !== 'READY' || this.status.generation !== status.generation) {
        this.shortcuts?.close();
        this.shortcuts = undefined;
        this.hostPreferences = undefined;
        this.shortcutBindings = undefined;
      }
      if (status.generation !== this.status.generation || status.stage !== 'READY') {
        this.proactivePetId = undefined;
        this.invalidateFeatures();
        this.micConsent = undefined;
        this.snapshot = undefined;
        // A new generation cannot use an earlier generation's projection.
        this.pendingSnapshot = undefined;
      }
      this.status = status;
      this.broadcastStatus();
      if (refreshPreferences) {
        void this.refreshWindowAnchors(status.generation);
        void this.refreshHostPreferences(status.generation);
      }
      devLog('service', status.stage, `generation=${status.generation}`);
      this.diagnostics?.record({ event: 'service-stage', stage: status.stage, generation: status.generation });
      if (status.stage === 'READY' && this.pendingSnapshot) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        this.acceptSnapshot(snapshot);
      } else {
        this.reconcilePets();
      }
    });
    this.service.subscribeChat(event => {
      const record = this.windows.get(CENTER_KEY);
      if (record && this.featureCurrent(this.featureStamp(record))) this.send(record, DESKTOP_IPC.chatEvent, event);
    });
    this.service.subscribeProactive(event => this.deliverProactive(event));
    this.proactiveTimer = setInterval(() => this.syncProactive(true), PROACTIVE_PULSE_MS);
    this.proactiveTimer.unref();

    this.openControlCenter();
    this.service.start();
  }

  openControlCenter(): void {
    this.resetFailures(CENTER_KEY);
    const current = this.windows.get(CENTER_KEY);
    if (current && !current.window.isDestroyed()) {
      current.focusOnReady = true;
      if (current.ready) {
        if (current.window.isMinimized()) current.window.restore();
        current.window.show();
        current.window.focus();
      }
    } else {
      this.createWindow(CENTER_KEY, undefined, true);
    }
  }

  private registerIpc(): void {
    ipcMain.handle(DESKTOP_IPC.characterPackRequest, (event, ...args: unknown[]) => this.handleCharacterPack(event, args));
    ipcMain.handle(DESKTOP_IPC.request, (event, ...args: unknown[]) => {
      const { record, sender } = this.senderOf(event);
      const activePetRevision = record !== undefined && this.isActivePet(record) && record.window.isVisible()
        ? this.snapshot?.revision : undefined;
      return routeRequest(record?.binding, sender, args, async request => {
        const started = performance.now();
        let outcome: IpcErrorCode | 'OK' = 'SERVICE_UNAVAILABLE';
        try {
          const result = await this.service.request(request);
          outcome = result.ok ? 'OK' : result.error.code;
          return result;
        } finally {
          if (record) recordRequestDiagnostic(this.diagnostics, 'game', record.binding.role, request.requestId, outcome, started);
        }
      }, activePetRevision);
    });
    ipcMain.handle(DESKTOP_IPC.getStatus, (event, ...args: unknown[]) => {
      const { record, sender } = this.senderOf(event);
      if (!authorizeSender(record?.binding, sender)) throw new Error('FORBIDDEN');
      if (args.length !== 0) throw new Error('INVALID_REQUEST');
      return this.service.getStatus();
    });
    ipcMain.handle(DESKTOP_IPC.openControlCenter, (event, ...args: unknown[]): HostActionResult => {
      const { record, sender } = this.senderOf(event);
      if (!authorizeSender(record?.binding, sender)) return { ok: false, code: 'FORBIDDEN' };
      if (args.length !== 0) return { ok: false, code: 'INVALID_REQUEST' };
      try { this.openControlCenter(); return { ok: true }; }
      catch { return { ok: false, code: 'SERVICE_UNAVAILABLE' }; }
    });
    ipcMain.handle(DESKTOP_IPC.petInteractive, (event, ...args: unknown[]): HostActionResult => {
      const { record, sender } = this.senderOf(event);
      if (!record || !authorizeSender(record.binding, sender, 'pet')) return { ok: false, code: 'FORBIDDEN' };
      if (args.length !== 1 || typeof args[0] !== 'boolean') return { ok: false, code: 'INVALID_REQUEST' };
      if (!args[0]) {
        record.inputLease.clear();
        return this.updatePetInput(record) ? { ok: true } : { ok: false, code: 'SERVICE_UNAVAILABLE' };
      }
      if (!this.isActivePet(record) || !record.window.isVisible()) {
        record.inputLease.clear();
        this.updatePetInput(record);
        return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      }
      try {
        if (!record.inputLease.renew(screen.getCursorScreenPoint(), record.window.getBounds())) {
          this.updatePetInput(record);
          return { ok: false, code: 'INVALID_REQUEST' };
        }
        // Explicit tray modes never depend on a renderer lease.
        if (this.inputMode !== 'auto') record.inputLease.clear();
        return this.updatePetInput(record) ? { ok: true } : { ok: false, code: 'SERVICE_UNAVAILABLE' };
      } catch {
        record.inputLease.clear();
        this.updatePetInput(record);
        return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      }
    });
    ipcMain.handle(DESKTOP_IPC.changePetScale, (event, ...args: unknown[]) => this.changePetScale(event, args));
    ipcMain.handle(DESKTOP_IPC.petVisualReady, (event, ...args: unknown[]): HostActionResult => {
      const { record, sender } = this.senderOf(event);
      if (!record?.pet || !authorizeSender(record.binding, sender, 'pet')) return { ok: false, code: 'FORBIDDEN' };
      const parsed = petVisualReadySchema.safeParse(args[0]);
      if (args.length !== 1 || !parsed.success) return { ok: false, code: 'INVALID_REQUEST' };
      // Own bound sender, current desired character and current service generation only.
      if (!isCurrentVisualReport(record.pet.identity, this.getDesiredPet(), parsed.data)) {
        return { ok: false, code: 'FORBIDDEN' };
      }
      // A loading/reloading document cannot reuse a queued report from the
      // previous document; the renderer retries until did-finish-load.
      if (!record.responsive || !record.pet.documentReady) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      record.pet.visualResult = parsed.data.result;
      this.reconcilePets();
      return { ok: true };
    });
    ipcMain.handle(DESKTOP_IPC.hostRequest, (event, ...args: unknown[]) => this.handleHostRequest(event, args));
    ipcMain.handle(DESKTOP_IPC.exportDiagnostics, (event, ...args: unknown[]) => this.exportDiagnostics(event, args));
    ipcMain.handle(DESKTOP_IPC.aiRequest, (event, ...args: unknown[]) => this.handleAiRequest(event, args));
    ipcMain.handle(DESKTOP_IPC.proactiveRequest, (event, ...args: unknown[]) => this.handleProactiveRequest(event, args));
    ipcMain.handle(DESKTOP_IPC.credentialSave, (event, ...args: unknown[]) => this.handleCredential(event, args, true));
    ipcMain.handle(DESKTOP_IPC.credentialRevoke, (event, ...args: unknown[]) => this.handleCredential(event, args, false));
    ipcMain.handle(DESKTOP_IPC.voiceRequest, (event, ...args: unknown[]) => this.handleVoiceRequest(event, args));
    ipcMain.handle(DESKTOP_IPC.voiceSettingsRequest, (event, ...args: unknown[]) => this.handleVoiceSettings(event, args));
    ipcMain.handle(DESKTOP_IPC.workspaceRequest,(event,...args:unknown[])=>this.handleWorkspace(event,args));
    ipcMain.handle(DESKTOP_IPC.micAuthorize, (event, ...args: unknown[]) => this.authorizeMicrophone(event, args));
    ipcMain.handle(DESKTOP_IPC.micRequest, (event, ...args: unknown[]) => this.requestMicrophone(event, args));
    ipcMain.handle(DESKTOP_IPC.micRevoke, (event, ...args: unknown[]) => this.revokeMicrophone(event, args));
    ipcMain.handle(DESKTOP_IPC.voiceChatCancel, (event, ...args: unknown[]): boolean => {
      const stamp = this.authorizedFeature(event), owner = this.voiceOwner, parsed = voiceChatCancelSchema.safeParse(args[0]);
      if (args.length !== 1 || !stamp || !owner || !parsed.success || !this.sameFeature(stamp, owner.stamp)) return false;
      const { identity, reason } = parsed.data;
      if (identity.petId !== owner.job.petId || identity.conversationId !== owner.job.conversationId || identity.requestId !== owner.job.requestId) return false;
      this.service.cancelVoiceChat(identity, reason);
      return true;
    });
    ipcMain.handle(DESKTOP_IPC.voiceMouth, (event, ...args: unknown[]) => {
      const stamp = this.authorizedFeature(event), parsed = voiceMouthNotificationSchema.safeParse(args[0]);
      if (args.length === 1 && stamp && parsed.success) this.publishMouth(stamp, parsed.data);
    });
  }

  private featureStamp(record: WindowRecord): FeatureStamp {
    return { record, documentEpoch: record.documentEpoch, featureEpoch: record.featureEpoch, serviceGeneration: this.status.generation };
  }

  private quickSender(stamp:FeatureStamp):QuickLaunchSender{
    return{role:'control-center',senderId:stamp.record.binding.senderId,
      documentId:`document-${stamp.documentEpoch}:${stamp.featureEpoch}:${stamp.serviceGeneration}`};
  }
  private currentQuickSender(sender:QuickLaunchSender):WindowRecord|null{
    const record=this.senders.get(sender.senderId);if(!record||record.binding.role!=='control-center')return null;
    const stamp=this.featureStamp(record);
    return this.featureCurrent(stamp)&&this.quickSender(stamp).documentId===sender.documentId?record:null;
  }
  private getWorkspaceHost():WorkspaceHost{
    if(this.workspaceHost)return this.workspaceHost;
    this.workspaceHost=new WorkspaceHost({resourcesDirectory:process.resourcesPath??join(app.getPath('userData'),'native-development-unavailable'),
      expectedInspectorSha256:nativeArtifactPins.launchInspectorSha256,senderIsCurrent:sender=>this.currentQuickSender(sender)!==null,
      parentFor:sender=>this.currentQuickSender(sender)?.window??null,
      requestAuthority:async(request,signal)=>{if(signal.aborted)throw new Error('Cancelled');const result=await this.service.requestWorkspace(request);if(signal.aborted)throw new Error('Cancelled');return result;},
      nativeDialog:{showOpenDialog:async(parent,options)=>{if(this.nativePrompt||this.voiceOwner||this.micLease)return{canceled:true,filePaths:[]};this.nativePrompt=true;
        try{return await dialog.showOpenDialog(parent,options);}finally{this.nativePrompt=false;}},
        showMessageBox:async(parent,options)=>{if(this.nativePrompt||this.voiceOwner||this.micLease)return{response:options.cancelId??0};this.nativePrompt=true;
          try{return await dialog.showMessageBox(parent,options);}finally{this.nativePrompt=false;}}},
      nativeShell:{openPath:path=>shell.openPath(path),openExternal:url=>shell.openExternal(url)}});
    return this.workspaceHost;
  }
  private async handleWorkspace(event:IpcMainInvokeEvent,args:readonly unknown[]):Promise<WorkspaceResult|null>{
    const parsed=workspaceRequestSchema.safeParse(args[0]);if(args.length!==1||!parsed.success)return null;
    const request=parsed.data,stamp=this.authorizedFeature(event, parsed.data.intent.method === 'suggestion/run');
    const fail=(code:'FORBIDDEN'|'SERVICE_UNAVAILABLE'):WorkspaceResult=>({ok:false,requestId:request.requestId,method:request.intent.method,error:{code}});
    if(!stamp)return fail('FORBIDDEN');
    try{const result=await this.getWorkspaceHost().handle(request,this.quickSender(stamp));
      if(!result||!this.featureCurrent(stamp)||!workspaceResultMatches(request,result))return fail('SERVICE_UNAVAILABLE');return result;
    }catch{return fail('SERVICE_UNAVAILABLE');}
  }

  private async handleCharacterPack(event: IpcMainInvokeEvent, args: unknown[]): Promise<CharacterPackResult> {
    const parsed = characterPackRequestSchema.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) return { ok: false, code: 'INVALID_REQUEST' };
    const request = parsed.data;
    try {
      if (request.kind === 'read') {
        const { record, sender } = this.senderOf(event);
        if (!record?.pet || !authorizeSender(record.binding, sender, 'pet') || record.pet.identity.characterId !== request.characterId) {
          return { ok: false, code: 'FORBIDDEN' };
        }
        const epoch = record.documentEpoch;
        const pack = await this.characterPacks.readActive(request.characterId);
        const current = this.senderOf(event);
        if (current.record !== record || record.documentEpoch !== epoch || !authorizeSender(record.binding, current.sender, 'pet')) {
          return { ok: false, code: 'FORBIDDEN' };
        }
        return { ok: true, kind: 'read', pack };
      }

      const stamp = this.authorizedFeature(event, request.kind !== 'list');
      if (!stamp) return { ok: false, code: 'FORBIDDEN' };
      if (request.kind === 'list') {
        const rows = await this.characterPacks.list();
        return this.recheckFeature(event, stamp) ? { ok: true, kind: 'list', rows } : { ok: false, code: 'FORBIDDEN' };
      }
      if (this.changingCharacterPack || this.nativePrompt || this.backupInProgress || this.voiceOwner || this.micLease) {
        return { ok: false, code: 'BUSY' };
      }
      this.changingCharacterPack = true;
      try {
        if (request.kind === 'activate') {
          const change = await this.characterPacks.activate({ characterId: request.characterId, packVersion: request.packVersion });
          this.notifyCharacterPack(change);
          return { ok: true, kind: 'change', change };
        }
        this.nativePrompt = true;
        let selected;
        try {
          selected = await dialog.showOpenDialog(stamp.record.window, {
            title: '选择包含 manifest.json 的角色资源包目录', properties: ['openDirectory'],
          });
        } finally { this.nativePrompt = false; }
        const folder = selected.filePaths[0];
        if (selected.canceled || !folder || selected.filePaths.length !== 1) return { ok: false, code: 'CANCELLED' };
        if (!this.recheckFeature(event, stamp)) return { ok: false, code: 'FORBIDDEN' };
        const pack = await this.characterPacks.prepare(folder);
        if (!this.recheckFeature(event, stamp)) return { ok: false, code: 'FORBIDDEN' };
        const accepted = await this.confirmNative(stamp, '安装角色资源包',
          `安装并启用 ${pack.manifest.characterId} 的资源包 ${pack.manifest.packVersion}？请确认你有权使用所选素材。`, '安装');
        if (!accepted || !this.recheckFeature(event, stamp)) return { ok: false, code: 'CANCELLED' };
        const change = await this.characterPacks.install(pack);
        this.notifyCharacterPack(change);
        return { ok: true, kind: 'change', change };
      } finally { this.changingCharacterPack = false; }
    } catch (error) {
      return { ok: false, code: error instanceof CharacterPackStoreError ? error.code : 'STORAGE_ERROR' };
    }
  }

  private notifyCharacterPack(change: CharacterPackChanged): void {
    for (const record of this.windows.values()) {
      if (record.pet?.identity.characterId === change.characterId) this.send(record, DESKTOP_IPC.characterPackChanged, change);
    }
  }

  private sameFeature(left: FeatureStamp, right: FeatureStamp): boolean {
    return left.record === right.record && left.documentEpoch === right.documentEpoch
      && left.featureEpoch === right.featureEpoch && left.serviceGeneration === right.serviceGeneration;
  }

  private featureCurrent(stamp: FeatureStamp, focus = false, recover = false): boolean {
    const { record } = stamp;
    if (this.stopping || this.suspended || this.locked || (this.status.stage !== 'READY' && !(recover && this.status.stage === 'UNAVAILABLE'))
      || record.binding.role !== 'control-center'
      || !this.isCurrent(record) || !record.documentReady || !record.responsive || !this.sameFeature(stamp, this.featureStamp(record))) return false;
    try {
      const contents = record.window.webContents;
      return record.window.isVisible() && (!focus || record.window.isFocused()) && !contents.isDestroyed()
        && isTrustedDocument(record.binding, contents.getURL()) && isTrustedDocument(record.binding, contents.mainFrame.url);
    } catch { return false; }
  }

  private authorizedFeature(event: IpcMainInvokeEvent, focus = false, recover = false): FeatureStamp | null {
    const { record, sender } = this.senderOf(event);
    if (!record || !authorizeSender(record.binding, sender, 'control-center')) return null;
    const stamp = this.featureStamp(record);
    return this.featureCurrent(stamp, focus, recover) ? stamp : null;
  }

  private recheckFeature(event: IpcMainInvokeEvent, stamp: FeatureStamp, recover = false): boolean {
    const current = this.authorizedFeature(event, false, recover);
    return current !== null && this.sameFeature(stamp, current);
  }

  private async refreshHostPreferences(generation: number): Promise<void> {
    try {
      const [response, shortcuts] = await Promise.all([
        this.service.requestHost({ kind: 'preferences' }), this.service.requestHost({ kind: 'shortcut-bindings' }),
      ]);
      if (this.stopping || this.status.stage !== 'READY' || this.status.generation !== generation) return;
      if (shortcuts.kind === 'shortcut-bindings' && shortcuts.result.ok) this.cacheShortcutBindings(shortcuts.result.preferences);
      if (response.kind === 'preferences' && response.result.ok) this.applyHostPreferences(response.result.preferences);
    } catch { /* a later explicit settings read may retry */ }
  }

  private cacheShortcutBindings(preferences: HostShortcutBindingsView, applied = false): void {
    if (preferences.revision <= (this.shortcutBindings?.revision ?? -1)
      || (this.shortcuts && this.changingShortcutBindings && !applied)) return;
    this.shortcutBindings = preferences;
    if (!applied) this.shortcuts?.applyStoredBindings(preferences.bindings);
    if (this.hostPreferences && !this.shortcuts) this.applyHostPreferences(this.hostPreferences);
  }

  private petSize(): { width: number; height: number } {
    const scale = (this.hostPreferences?.values.scalePercent ?? 100) / 100;
    return { width: Math.round(PET_SIZE.width * scale), height: Math.round(PET_SIZE.height * scale) };
  }

  private async changePetScale(event: IpcMainInvokeEvent, args: unknown[]): Promise<HostActionResult> {
    const { record, sender } = this.senderOf(event);
    const forbidden = { ok: false, code: 'FORBIDDEN' } as const;
    const unavailable = { ok: false, code: 'SERVICE_UNAVAILABLE' } as const;
    if (!record || !authorizeSender(record.binding, sender, 'pet') || !this.isActivePet(record) || !record.window.isVisible()) return forbidden;
    const direction = petScaleDirectionSchema.safeParse(args[0]);
    if (args.length !== 1 || !direction.success) return { ok: false, code: 'INVALID_REQUEST' };
    if (this.changingPetScale) return unavailable;

    const stamp = this.featureStamp(record);
    const currentPet = () => this.sameFeature(stamp, this.featureStamp(record)) && this.isActivePet(record) && record.window.isVisible();
    this.changingPetScale = true;
    try {
      if (!this.hostPreferences) await this.refreshHostPreferences(stamp.serviceGeneration);
      if (!currentPet()) return forbidden;
      const previous = this.hostPreferences;
      if (!previous) return unavailable;
      const step = direction.data === 'increase' ? 1 : -1;
      const scalePercent = hostScalePercents[hostScalePercents.indexOf(previous.values.scalePercent) + step];
      if (scalePercent === undefined) return { ok: true };

      const reply = await this.service.requestHost({ kind: 'save', edit: {
        expectedRevision: previous.revision, reducedMotion: previous.values.reducedMotion, scalePercent,
      } });
      if (this.stopping || this.status.stage !== 'READY' || this.status.generation !== stamp.serviceGeneration
        || reply.kind !== 'preferences') return unavailable;
      if (!reply.result.ok) {
        if (reply.result.code === 'REVISION_CONFLICT') await this.refreshHostPreferences(stamp.serviceGeneration);
        return unavailable;
      }
      // A confirmed global preference also belongs to a newly selected pet.
      this.applyHostPreferences(reply.result.preferences);
      return currentPet() ? { ok: true } : forbidden;
    } catch { return unavailable; }
    finally { this.changingPetScale = false; }
  }

  private applyHostPreferences(preferences: HostPreferencesView): void {
    const previous = this.hostPreferences;
    if (previous && preferences.revision < previous.revision) return;
    this.hostPreferences = preferences;
    if (!this.shortcuts && this.shortcutBindings) {
      this.shortcuts = new HostShortcutController({
        globalShortcut, loginApp: app, initialShortcutEnabled: preferences.values.hotkeysEnabled, shortcutPreferenceScope: 'PERSISTED',
        initialShortcutBindings: this.shortcutBindings.bindings,
        actions: {
          openControlCenter: () => this.openControlCenter(),
          togglePetVisibility: () => this.togglePetVisibility(),
          rescueInteraction: () => this.setInputMode('temporary-interactive'),
        },
      });
      this.shortcuts.start();
    } else if (previous?.values.hotkeysEnabled !== preferences.values.hotkeysEnabled) {
      this.shortcuts?.setHostShortcutEnabled(preferences.values.hotkeysEnabled);
    }
    if (previous?.revision === preferences.revision) return;
    const { scalePercent, reducedMotion } = preferences.values;
    const scaleChanged = previous?.values.scalePercent !== scalePercent;
    if (scaleChanged) this.stopWalkMotion();
    for (const record of this.windows.values()) {
      if (!record.pet || !this.isCurrent(record)) continue;
      if (scaleChanged) {
        const bounds = record.window.getBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        const size = this.petSize();
        const x = previous ? bounds.x + Math.floor(bounds.width / 2) - Math.floor(size.width / 2) : bounds.x;
        const y = previous ? bounds.y + Math.floor(bounds.height / 2) - Math.floor(size.height / 2) : bounds.y;
        record.window.setBounds(clampBounds({ x, y, ...size }, area));
      }
      this.send(record, DESKTOP_IPC.hostRenderPreferences, { reducedMotion, scalePercent });
    }
  }

  private async handleHostRequest(event: IpcMainInvokeEvent, args: readonly unknown[]):
    Promise<HostSettingsResult | HostPreferencesViewResult | HostShortcutBindingsResult | BackupViewResult | RestoreBackupResult | RestoreBackupStatus | PeriodicBackupStatus> {
    const parsed = hostRendererRequestSchema.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) throw new Error('INVALID_REQUEST');
    const request = parsed.data;
    const restore = request.kind === 'restore-backup';
    const stamp = this.authorizedFeature(event, request.kind === 'backup' || restore || request.kind === 'login'
      || request.kind === 'save-shortcut-bindings', restore);
    if (!stamp) throw new Error('FORBIDDEN');
    const unavailable = { ok: false, code: 'SERVICE_UNAVAILABLE' } as const;
    const settingsUnavailable = { ...unavailable, settings: null };
    if (request.kind === 'backup') return this.exportBackup(event, stamp);
    if (request.kind === 'restore-backup') return this.prepareRestore(event, stamp);
    if (request.kind === 'shortcut-bindings') {
      const reply = await this.service.requestHost(request);
      if (!this.recheckFeature(event, stamp) || reply.kind !== request.kind) return unavailable;
      if (reply.result.ok) this.cacheShortcutBindings(reply.result.preferences);
      return reply.result;
    }
    if (request.kind === 'save-shortcut-bindings') {
      const controller = this.shortcuts;
      if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED' };
      if (!controller || !this.shortcutBindings) return unavailable;
      if (this.changingShortcutBindings) return { ok: false, code: 'BUSY' };
      if (request.edit.expectedRevision !== this.shortcutBindings.revision) return { ok: false, code: 'REVISION_CONFLICT' };
      const prepared = controller.prepareBindings(request.edit.bindings);
      if (!prepared.ok) return prepared;
      this.changingShortcutBindings = true;
      let refresh = false;
      try {
        const reply = await this.service.requestHost(request);
        if (this.stopping || this.status.generation !== stamp.serviceGeneration || this.shortcuts !== controller
          || reply.kind !== 'shortcut-bindings') return unavailable;
        if (reply.result.ok) {
          const authoritative = reply.result.preferences;
          if (authoritative.revision < request.edit.expectedRevision
            || hostShortcutIds.some(id => authoritative.bindings[id] !== request.edit.bindings[id])) {
            refresh = true;
            return unavailable;
          }
          prepared.apply();
          this.cacheShortcutBindings(authoritative, true);
        } else refresh = reply.result.code === 'SERVICE_UNAVAILABLE' || reply.result.code === 'REVISION_CONFLICT';
        return this.recheckFeature(event, stamp) ? reply.result : unavailable;
      } catch {
        refresh = true;
        return unavailable;
      } finally {
        prepared.discard();
        this.changingShortcutBindings = false;
        if (refresh && this.status.stage === 'READY' && this.status.generation === stamp.serviceGeneration) {
          void this.refreshHostPreferences(stamp.serviceGeneration);
        }
      }
    }
    if (request.kind === 'restore-status' || request.kind === 'periodic-backup-status') {
      const reply = await this.service.requestHost(request);
      return this.recheckFeature(event, stamp) && reply.kind === request.kind ? reply.result : unavailable;
    }
    if (request.kind === 'login') {
      const before = this.shortcuts?.getHostSettings();
      if (!before?.ok) return settingsUnavailable;
      if (before.settings.loginStart.availability !== 'READY') return { ok: false, code: 'UNSUPPORTED', settings: before.settings };
      const confirmed = await this.confirmNative(stamp, '登录时启动', request.enabled ? '允许 Pet Desktop 在登录 Windows 时启动？' : '关闭 Pet Desktop 的登录启动？', '确认');
      return confirmed && this.recheckFeature(event, stamp) ? this.shortcuts?.setLoginStart(request.enabled) ?? settingsUnavailable : settingsUnavailable;
    }
    const previous = this.hostPreferences;
    if (request.kind === 'shortcuts') {
      const controller = this.shortcuts;
      if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED', settings: null };
      if (!previous || !controller || this.changingShortcutBindings) return settingsUnavailable;
      this.changingShortcutBindings = true;
      try {
        const reply = await this.service.requestHost({ ...request, expectedRevision: previous.revision });
        if (this.stopping || this.status.stage !== 'READY' || this.status.generation !== stamp.serviceGeneration
          || this.shortcuts !== controller || reply.kind !== 'preferences' || !reply.result.ok) return settingsUnavailable;
        this.applyHostPreferences(reply.result.preferences);
        if (!this.recheckFeature(event, stamp)) return settingsUnavailable;
        return previous.values.hotkeysEnabled === request.enabled ? controller.setHostShortcutEnabled(request.enabled) : controller.getHostSettings();
      } catch {
        return settingsUnavailable;
      } finally { this.changingShortcutBindings = false; }
    }
    if (request.kind === 'settings') {
      if (!this.shortcuts) await this.refreshHostPreferences(stamp.serviceGeneration);
      return this.recheckFeature(event, stamp) ? this.shortcuts?.getHostSettings() ?? settingsUnavailable : settingsUnavailable;
    }
    const result = await this.service.requestHost(request);
    if (result.kind !== 'preferences') return unavailable;
    const response = result.result;
    if (response.ok && !this.stopping && this.status.stage === 'READY' && this.status.generation === stamp.serviceGeneration) {
      this.applyHostPreferences(response.preferences);
    }
    if (!this.recheckFeature(event, stamp)) return unavailable;
    return response;
  }

  private async exportDiagnostics(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<DiagnosticsExportResult> {
    if (args.length !== 0) return { ok: false, code: 'INVALID_REQUEST' };
    const { record, sender } = this.senderOf(event);
    if (!record || !authorizeSender(record.binding, sender, 'control-center') || !record.window.isFocused()) return { ok: false, code: 'FORBIDDEN' };
    const epoch = record.documentEpoch;
    const isCurrent = (): boolean => {
      if (this.stopping || this.suspended || this.locked || !this.isCurrent(record) || !record.responsive
        || !record.documentReady || record.documentEpoch !== epoch || !record.window.isVisible()) return false;
      const fresh = this.senderOf(event);
      return fresh.record === record && authorizeSender(record.binding, fresh.sender, 'control-center');
    };
    if (!isCurrent()) return { ok: false, code: 'FORBIDDEN' };
    if (!this.diagnostics) return { ok: false, code: 'UNAVAILABLE' };
    if (this.nativePrompt || this.exportingDiagnostics || this.backupInProgress || this.voiceOwner || this.micLease) {
      return { ok: false, code: 'BUSY' };
    }
    this.exportingDiagnostics = true;
    try {
      this.nativePrompt = true;
      let selected;
      try {
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        selected = await dialog.showSaveDialog(record.window, {
          title: '导出 Pet Desktop 诊断报告',
          defaultPath: `pet-desktop-diagnostics-${timestamp}.json`,
          filters: [{ name: '诊断报告', extensions: ['json'] }],
        });
      } finally { this.nativePrompt = false; }
      if (selected.canceled || !selected.filePath) return { ok: false, code: 'CANCELLED' };
      if (!isCurrent()) return { ok: false, code: 'FORBIDDEN' };
      const published = await this.diagnostics.publish(selected.filePath, isCurrent);
      if (published === 'destination-exists') return { ok: false, code: 'DESTINATION_EXISTS' };
      if (published === 'cancelled') return { ok: false, code: 'FORBIDDEN' };
      return { ok: true, entries: published.entries };
    } catch {
      return { ok: false, code: 'EXPORT_FAILED' };
    } finally { this.exportingDiagnostics = false; }
  }

  private async exportBackup(event: IpcMainInvokeEvent, stamp: FeatureStamp): Promise<BackupViewResult> {
    if (this.nativePrompt || this.backupInProgress || this.voiceOwner || this.micLease) return { ok: false, code: 'BUSY' };
    this.backupInProgress = true;
    try {
      this.nativePrompt = true;
      let selected;
      try {
        const date = new Date().toISOString().slice(0, 10);
        selected = await dialog.showSaveDialog(stamp.record.window, {
          title: '导出 Pet Desktop 本地存档', defaultPath: `pet-desktop-${date}.sqlite3`,
          filters: [{ name: 'SQLite 存档', extensions: ['sqlite3'] }],
        });
      } finally { this.nativePrompt = false; }
      if (selected.canceled || !selected.filePath) return { ok: false, code: 'CANCELLED' };
      if (!this.recheckFeature(event, stamp)) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      const reply = await this.service.requestHost({ kind: 'backup', destination: selected.filePath });
      if (!this.recheckFeature(event, stamp) || reply.kind !== 'backup') return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      return reply.result;
    } catch {
      return { ok: false, code: 'EXPORT_FAILED' };
    } finally { this.backupInProgress = false; }
  }

  private async prepareRestore(event: IpcMainInvokeEvent, stamp: FeatureStamp): Promise<RestoreBackupResult> {
    if (this.nativePrompt || this.backupInProgress || this.voiceOwner || this.micLease) return { ok: false, code: 'BUSY' };
    this.backupInProgress = true;
    try {
      this.nativePrompt = true;
      let selected;
      try {
        const automaticBackups = join(app.getPath('userData'), managedBackupDirectory);
        selected = await dialog.showOpenDialog(stamp.record.window, {
          title: '选择 Pet Desktop 存档备份', properties: ['openFile'],
          filters: [{ name: 'SQLite 存档', extensions: ['sqlite3'] }],
          ...(existsSync(automaticBackups) ? { defaultPath: automaticBackups } : {}),
        });
      } finally { this.nativePrompt = false; }
      const source = selected.filePaths[0];
      if (selected.canceled || !source || selected.filePaths.length !== 1) return { ok: false, code: 'CANCELLED' };
      if (!this.recheckFeature(event, stamp, true)) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      const confirmed = await this.confirmNative(stamp, '恢复本地存档',
        '恢复会用所选备份替换当前宠物、旅行、图鉴和偏好，并重启本地服务。替换前会保留当前存档。', '恢复存档', true);
      if (!confirmed) return { ok: false, code: 'CANCELLED' };
      if (!this.recheckFeature(event, stamp, true)) return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      if (this.status.stage === 'UNAVAILABLE') return this.service.recover(source) ? { ok: true } : { ok: false, code: 'BUSY' };
      const reply = await this.service.requestHost({ kind: 'restore-backup', source });
      if (reply.kind !== 'restore-backup') return { ok: false, code: 'SERVICE_UNAVAILABLE' };
      if (reply.result.ok && !this.service.restart()) return { ok: false, code: 'RESTART_REQUIRED' };
      return reply.result;
    } catch {
      return { ok: false, code: 'SERVICE_UNAVAILABLE' };
    } finally { this.backupInProgress = false; }
  }

  private async handleAiRequest(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<AiResult> {
    const stamp = this.authorizedFeature(event);
    if (!stamp) throw new Error('FORBIDDEN');
    const parsed = aiRequestSchema.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) throw new Error('INVALID_REQUEST');
    const original = parsed.data, request: AiRequest = { ...original, requestId: randomUUID() };
    const failed = (): AiResult => ({ requestId: original.requestId, method: original.intent.method, ok: false,
      error: { code: 'UNAVAILABLE', message: 'AI 请求结果尚未确认，请刷新。', retryable: true } });
    const started = performance.now();
    let outcome: 'OK' | 'AI_ERROR' | 'AI_UNAVAILABLE' = 'AI_UNAVAILABLE';
    try {
      const result = aiResultSchema.safeParse(await this.service.requestAi(request));
      if (!this.recheckFeature(event, stamp) || !result.success || !aiResultMatches(request, result.data)) return failed();
      outcome = result.data.ok ? 'OK' : result.data.error.code === 'UNAVAILABLE' ? 'AI_UNAVAILABLE' : 'AI_ERROR';
      return { ...result.data, requestId: original.requestId };
    } catch { return failed(); }
    finally { recordRequestDiagnostic(this.diagnostics, 'ai', 'control-center', request.requestId, outcome, started); }
  }

  private async handleProactiveRequest(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<ProactiveResult | null> {
    const parsed = proactiveRequestSchema.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) return null;
    const request = parsed.data;
    const method = request.intent.method;
    const mutation = method !== 'settings/get' && method !== 'notices/list';
    const stamp = this.authorizedFeature(event, mutation);
    if (!stamp || !this.hasPet(request.intent.payload.petId)) return proactiveFailure(request, 'INVALID_REQUEST');
    const trusted = { ...request, requestId: `proactive-${randomUUID()}` };
    const result = await this.service.requestProactive(trusted);
    if (!this.recheckFeature(event, stamp) || !proactiveResultMatches(trusted, result)) return proactiveFailure(request);
    if (result.ok && result.method === 'settings/set' && !result.data.enabled
      && this.proactiveTarget?.pet?.identity.petId === result.data.petId) this.clearProactiveBubble();
    return { ...result, requestId: request.requestId };
  }

  /** Native dialogs contain no credentials, prompts or transcript. A modal
   * focus change is not permission to start a capture. */
  private async confirmNative(stamp: FeatureStamp, title: string, message: string, accept: string, recover = false): Promise<boolean> {
    if (this.nativePrompt || !this.featureCurrent(stamp, true, recover) || this.voiceOwner || this.micLease) return false;
    this.nativePrompt = true;
    try {
      const result = await dialog.showMessageBox(stamp.record.window, { type: 'question', title, message,
        buttons: ['取消', accept], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1 && this.featureCurrent(stamp, false, recover);
    } catch { return false; }
    finally { this.nativePrompt = false; }
  }

  private async handleCredential(event: IpcMainInvokeEvent, args: readonly unknown[], save: boolean): Promise<HostActionResult> {
    const stamp = this.authorizedFeature(event, true);
    if (!stamp) return { ok: false, code: 'FORBIDDEN' };
    const parsed = (save ? credentialSaveSchema : credentialRevokeSchema).safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) return { ok: false, code: 'INVALID_REQUEST' };
    const data = parsed.data;
    const provider = data.providerId;
    const confirmed = await this.confirmNative(stamp, 'AI 凭据', save
      ? `为 AI 提供方 ${provider} 保存加密凭据？` : `撤销 AI 提供方 ${provider} 的本机凭据？`, save ? '保存' : '撤销');
    if (!confirmed || !this.recheckFeature(event, stamp)) return { ok: false, code: 'FORBIDDEN' };
    try {
      const ok = save && 'secret' in data ? await this.credentialVault.save(provider, data.credentialRef, data.secret)
        : !save && await this.credentialVault.revoke(provider, data.credentialRef);
      return ok && this.recheckFeature(event, stamp) ? { ok: true } : { ok: false, code: 'SERVICE_UNAVAILABLE' };
    } catch { return { ok: false, code: 'SERVICE_UNAVAILABLE' }; }
  }

  private hasPet(petId: string): boolean { return this.snapshot?.pets.some(pet => pet.petId === petId) === true; }

  private consentCurrent(stamp: FeatureStamp): boolean {
    const consent = this.micConsent;
    return consent !== undefined && consent.record === stamp.record && consent.documentEpoch === stamp.documentEpoch
      && consent.serviceGeneration === stamp.serviceGeneration;
  }

  private async authorizeMicrophone(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<HostActionResult> {
    const stamp = this.authorizedFeature(event, true);
    if (!stamp) return { ok: false, code: 'FORBIDDEN' };
    if (args.length !== 0) return { ok: false, code: 'INVALID_REQUEST' };
    if (this.consentCurrent(stamp)) return { ok: true };
    const confirmed = await this.confirmNative(stamp, '麦克风权限', '允许当前控制中心在你按住说话时使用本机麦克风？松开即停止，不会后台录音。', '允许');
    if (!confirmed || !this.recheckFeature(event, stamp)) return { ok: false, code: 'FORBIDDEN' };
    this.micConsent = stamp;
    return { ok: true };
  }

  private async handleVoiceSettings(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<VoiceSettingsResult> {
    const stamp = this.authorizedFeature(event), parsed = voiceSettingsRequestSchema.safeParse(args[0]);
    if (args.length !== 1 || !parsed.success) return { ok: false, kind: 'error', code: 'INVALID_REQUEST' };
    const request = parsed.data;
    const failure = (code: 'UNAVAILABLE'|'NOT_FOUND'|'BUSY' = 'UNAVAILABLE'): VoiceSettingsResult => ({ ok: false, kind: 'error', code, petId: request.petId });
    if (!stamp) return failure();
    if (!this.hasPet(request.petId)) return failure('NOT_FOUND');
    const mutation = request.kind === 'save' || request.kind === 'reset';
    // Mutating the frozen settings of a reserved voice session is forbidden.
    // No new capture may race the completion of a settings change.
    if (mutation) {
      if (this.voiceOwner || this.micLease || this.voiceSettingsMutation || this.nativePrompt) return failure('BUSY');
      this.voiceSettingsMutation = stamp;
    }
    try {
      const result = voiceSettingsResultSchema.safeParse(await this.service.requestVoiceSettings(request));
      return this.recheckFeature(event, stamp) && result.success && voiceSettingsResultMatchesRequest(request, result.data) ? result.data : failure();
    } catch { return failure(); }
    finally { if (mutation && this.voiceSettingsMutation === stamp) this.voiceSettingsMutation = undefined; }
  }

  private async handleVoiceRequest(event: IpcMainInvokeEvent, args: readonly unknown[]): Promise<VoiceServiceResult> {
    const stamp = this.authorizedFeature(event), parsed = voiceServiceRequestSchema.safeParse(args[0]);
    if (!stamp) throw new Error('FORBIDDEN');
    if (args.length !== 1 || !parsed.success) throw new Error('INVALID_REQUEST');
    const request = parsed.data;
    const failure = (code: 'unavailable'|'permission_denied'|'canceled' = 'unavailable'): VoiceServiceResult => ({ ok: false, kind: 'error', code,
      ...('job' in request ? { job: request.job } : {}) });
    if (!this.hasPet(request.kind === 'status' ? request.scope.petId : request.job.petId)) return failure();
    let owner = this.voiceOwner;
    if (request.kind === 'begin') {
      if (owner || this.micLease || this.nativePrompt || this.voiceSettingsMutation || this.windowQuietsInFullscreen(stamp.record)
        || !this.featureCurrent(stamp, true) || !this.consentCurrent(stamp)) return failure('permission_denied');
      owner = { stamp, job: request.job, reserved: false, micUsed: false, mouthStarted: false };
      this.voiceOwner = owner;
      this.syncProactive();
    } else if (request.kind !== 'status') {
      if (!owner || !this.sameFeature(stamp, owner.stamp) || !sameVoiceJob(owner.job, request.job)
        || (request.kind !== 'cancel' && (!owner.reserved || !this.service.ownsVoice(request.job)))) return failure('canceled');
    }
    try {
      const result = voiceServiceResultSchema.safeParse(await this.service.requestVoice(request));
      const current = this.recheckFeature(event, stamp) && (request.kind === 'status' || this.voiceOwner === owner);
      if (!current || !result.success || !voiceResultMatchesRequest(request, result.data)) {
        if (owner && this.voiceOwner === owner && request.kind !== 'status') this.invalidateVoice(stamp.record);
        return failure('canceled');
      }
      const response = result.data;
      if (request.kind === 'begin' && owner) {
        if (response.kind === 'begun' && this.service.ownsVoice(owner.job)) owner.reserved = true;
        else { this.voiceOwner = undefined; return response.kind === 'error' ? response : failure(); }
      }
      if (response.kind === 'synthesized' && owner) owner.durationMs = inspectVoiceAudio(response.audio).durationMs;
      if (request.kind === 'finish' || request.kind === 'cancel') {
        if (owner && this.voiceOwner === owner) {
          this.voiceOwner = undefined; this.clearMouth(); this.invalidateMicLease(stamp.record);
        }
      }
      return response;
    } catch {
      if (owner && this.voiceOwner === owner && request.kind !== 'status') this.invalidateVoice(stamp.record);
      return failure();
    }
  }

  private requestMicrophone(event: IpcMainInvokeEvent, args: readonly unknown[]): VoiceMicGrant | null {
    const stamp = this.authorizedFeature(event, true), parsed = voiceOwnedJobSchema.safeParse(args[0]), owner = this.voiceOwner;
    if (args.length !== 1 || !stamp || !parsed.success || !owner || !owner.reserved || !this.sameFeature(stamp, owner.stamp)
      || !sameVoiceJob(parsed.data, owner.job) || owner.micUsed || !this.consentCurrent(stamp) || this.nativePrompt || this.micLease
      || !this.hasPet(owner.job.petId) || !this.service.ownsVoice(owner.job)) return null;
    const { sender } = this.senderOf(event);
    const raw = this.microphone.approve({ binding: stamp.record.binding, sender, documentEpoch: stamp.documentEpoch,
      serviceGeneration: stamp.serviceGeneration, eligible: true }, owner.job);
    const grant = voiceMicGrantSchema.safeParse(raw);
    if (!grant.success) return null;
    owner.micUsed = true;
    const lease: MicLease = { stamp, grant: grant.data, consumed: false, revoking: false,
      timer: setTimeout(() => { if (this.micLease === lease && !lease.consumed) this.invalidateVoice(stamp.record); }, MIC_PENDING_MS) };
    this.micLease = lease;
    return grant.data;
  }

  private consumeMicrophonePermission(contents: WebContents, permission: string, details: PermissionRequest & { mediaTypes?: unknown }): boolean {
    const lease = this.micLease, owner = this.voiceOwner;
    if (!lease || lease.consumed || lease.revoking || !owner || !owner.reserved || this.nativePrompt || contents.isDestroyed()
      || contents !== lease.stamp.record.window.webContents || !this.sameFeature(owner.stamp, lease.stamp)
      || !sameVoiceJob(owner.job, lease.grant.job) || !this.featureCurrent(lease.stamp, true) || !this.consentCurrent(lease.stamp)
      || !this.hasPet(owner.job.petId) || !this.service.ownsVoice(owner.job)) return false;
    const sender: SenderContext = { senderId: contents.id, isMainFrame: details.isMainFrame === true,
      frameUrl: details.requestingUrl, documentUrl: contents.getURL() };
    if (!this.microphone.consumeMediaRequest({ binding: lease.stamp.record.binding, sender, documentEpoch: lease.stamp.documentEpoch,
      serviceGeneration: lease.stamp.serviceGeneration, eligible: true }, permission, details.mediaTypes)) return false;
    lease.consumed = true;
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => { if (this.micLease === lease) this.recoverCaptureOwner(lease); }, MIC_CAPTURE_MS);
    return true;
  }

  private revokeMicrophone(event: IpcMainInvokeEvent, args: readonly unknown[]): void {
    const lease = this.micLease, parsed = voiceMicGrantSchema.safeParse(args[0]), { record, sender } = this.senderOf(event);
    if (args.length !== 1 || !lease || !parsed.success || record !== lease.stamp.record || !record
      || !authorizeSender(record.binding, sender, 'control-center') || record.documentEpoch !== lease.stamp.documentEpoch
      || parsed.data.grantId !== lease.grant.grantId || !sameVoiceJob(parsed.data.job, lease.grant.job)) return;
    // Revoking a consumed lease is also the release acknowledgement after a
    // lifecycle cancellation. It need not be focused or in an online epoch.
    if (!lease.revoking && !this.microphone.revoke({ binding: record.binding, sender, documentEpoch: lease.stamp.documentEpoch,
      serviceGeneration: lease.stamp.serviceGeneration, eligible: true }, parsed.data)) return;
    this.clearMicLease();
  }

  private clearMicLease(): void {
    if (this.micLease) clearTimeout(this.micLease.timer);
    this.microphone.invalidate();
    this.micLease = undefined;
  }

  private invalidateMicLease(record?: WindowRecord, destroyed = false): void {
    const lease = this.micLease;
    if (!lease || (record && lease.stamp.record !== record)) return;
    if (destroyed || !lease.consumed) { this.clearMicLease(); return; }
    if (lease.revoking) return;
    this.microphone.invalidate(lease.stamp.record.binding.senderId);
    clearTimeout(lease.timer);
    lease.revoking = true;
    // Never rearm permission before the old stream's owner releases it. If
    // the renderer fails to acknowledge cleanup, destroy/recover the owner.
    lease.timer = setTimeout(() => { if (this.micLease === lease) this.recoverCaptureOwner(lease); }, MIC_STOP_GRACE_MS);
  }

  private recoverCaptureOwner(lease: MicLease): void {
    if (this.micLease !== lease) return;
    const record = lease.stamp.record;
    this.clearMicLease();
    this.invalidateFeatures(record);
    if (this.isCurrent(record)) {
      if (this.stopping) this.destroyWindow(record);
      else this.recoverWindow(record);
    }
  }

  private invalidateVoice(record?: WindowRecord): void {
    const owner = this.voiceOwner;
    if (owner && (!record || owner.stamp.record === record)) {
      this.voiceOwner = undefined;
      this.service.cancelVoiceChat({ petId: owner.job.petId, conversationId: owner.job.conversationId, requestId: owner.job.requestId }, 'SERVICE_STOPPED');
      void this.service.requestVoice({ kind: 'cancel', job: owner.job, reason: 'SUSPEND' }).catch(() => undefined);
      this.clearMouth();
      this.send(owner.stamp.record, DESKTOP_IPC.voiceSuspend, true);
    }
    this.invalidateMicLease(record);
  }

  private invalidateFeatures(only?: WindowRecord): void {
    const record = only ?? this.windows.get(CENTER_KEY);
    if (record && record.binding.role !== 'control-center') return;
    if (record && this.windows.get(CENTER_KEY) !== record) return;
    if (record) {this.workspaceHost?.revokeSender(record.binding.senderId);record.featureEpoch++;}
    this.invalidateVoice(record);
    this.service.revokeFeatureDocument();
    if (record) this.send(record, DESKTOP_IPC.voiceSuspend, true);
  }

  private clearMouth(): void {
    const run = this.mouthRun;
    if (!run) return;
    this.mouthRun = undefined;
    clearTimeout(run.timer);
    this.send(run.target, DESKTOP_IPC.voiceMouth, { kind: 'clear', job: run.owner.job } satisfies VoiceMouthNotification);
  }

  private publishMouth(stamp: FeatureStamp, event: VoiceMouthNotification): void {
    const owner = this.voiceOwner;
    if (!owner || !owner.reserved || !this.sameFeature(stamp, owner.stamp) || !sameVoiceJob(owner.job, event.job)) return;
    if (event.kind === 'clear') { if (this.mouthRun?.owner === owner) this.clearMouth(); return; }
    if (!this.service.ownsVoice(owner.job) || owner.durationMs === undefined || !this.hasPet(owner.job.petId)) return;
    if (event.kind === 'begin') {
      if (owner.mouthStarted || Math.abs(event.durationMs - owner.durationMs) > 2) return;
      owner.mouthStarted = true;
      const target = [...this.windows.values()].find(record => record.pet?.identity.petId === owner.job.petId && this.isActivePet(record) && record.window.isVisible());
      if (!target) return;
      this.clearMouth();
      const run: MouthRun = { target, owner, durationMs: owner.durationMs, lastAtMs: -1, lastHostAt: -Infinity,
        timer: setTimeout(() => { if (this.mouthRun === run) this.clearMouth(); }, Math.ceil(owner.durationMs) + 2_000) };
      this.mouthRun = run;
      this.send(target, DESKTOP_IPC.voiceMouth, event);
      return;
    }
    const run = this.mouthRun, now = performance.now();
    if (!run || run.owner !== owner || !this.isActivePet(run.target) || !run.target.window.isVisible()) { if (run?.owner === owner) this.clearMouth(); return; }
    if (event.sample.atMs <= run.lastAtMs || event.sample.atMs > run.durationMs + 2 || now - run.lastHostAt < MOUTH_SAMPLE_INTERVAL_MS) return;
    run.lastAtMs = event.sample.atMs; run.lastHostAt = now;
    this.send(run.target, DESKTOP_IPC.voiceMouth, event);
  }

  private senderOf(event: IpcMainInvokeEvent): { record: WindowRecord | undefined; sender: SenderContext } {
    let record: WindowRecord | undefined;
    let isMainFrame = false;
    let frameUrl = '';
    let documentUrl = '';
    if (!event.sender.isDestroyed()) {
      const candidate = this.senders.get(event.sender.id);
      if (candidate && !candidate.window.isDestroyed() && candidate.window.webContents === event.sender) {
        record = candidate;
        try {
          const frame = event.senderFrame;
          isMainFrame = frame !== null && frame === event.sender.mainFrame;
          frameUrl = frame?.url ?? '';
          documentUrl = event.sender.getURL();
        } catch { /* Frames can be destroyed while a request is queued; deny by default. */ }
      }
    }
    return { record, sender: { senderId: event.sender.id, isMainFrame, frameUrl, documentUrl } };
  }

  private acceptSnapshot(snapshot: AppSnapshot): void {
    this.travelReturnNotices.observe(this.snapshot, snapshot);
    this.snapshot = snapshot;
    if (this.voiceOwner && !this.hasPet(this.voiceOwner.job.petId)) this.invalidateVoice(this.voiceOwner.stamp.record);
    for (const record of this.windows.values()) this.send(record, DESKTOP_IPC.snapshot, snapshot);
    // Newly created windows fetch the current snapshot or receive it on load.
    // A window creation failure must not suppress updates to existing windows.
    this.reconcilePets();
    if (this.mouthRun && (!this.isActivePet(this.mouthRun.target) || !this.mouthRun.target.window.isVisible())) this.clearMouth();
  }

  private broadcastStatus(): void {
    for (const record of this.windows.values()) this.send(record, DESKTOP_IPC.status, this.status);
  }

  private send(record: WindowRecord, channel: string, value: unknown): void {
    if (!this.isCurrent(record)) return;
    try {
      const contents = record.window.webContents;
      if (contents.isDestroyed() || !isTrustedDocument(record.binding, contents.getURL())) return;
      contents.send(channel, value);
    } catch { /* The target may have gone away; other windows must remain available. */ }
  }

  private proactiveWindow(): WindowRecord | undefined {
    if (this.petSuppressed() || this.snapshot?.pausedRender || this.nativePrompt || this.voiceOwner || this.micLease) return undefined;
    const petId = this.snapshot?.primaryPetId;
    if (!petId || !this.snapshot?.pets.some(pet => pet.petId === petId && pet.activity === 'IDLE')) return undefined;
    const record = this.windows.get(`pet:${petId}`);
    return record && this.isActivePet(record) && record.window.isVisible() && !this.windowQuietsInFullscreen(record) ? record : undefined;
  }

  private clearProactiveBubble(): void {
    if (this.proactiveTarget) this.send(this.proactiveTarget, DESKTOP_IPC.proactiveBubble, null);
    this.proactiveTarget = undefined;
  }

  private syncProactive(force = false): void {
    const target = this.proactiveWindow();
    if (this.proactiveTarget && this.proactiveTarget !== target) this.clearProactiveBubble();
    const petId = target?.pet?.identity.petId ?? null;
    if (this.status.stage === 'READY' && (force || this.proactivePetId !== petId)) {
      this.proactivePetId = petId;
      this.service.setProactiveHost(petId);
    }
  }

  private deliverProactive(event: ProactiveNoticeReady): void {
    const target = this.proactiveWindow();
    if (!target || target.pet?.identity.petId !== event.notice.petId) return;
    this.proactiveTarget = target;
    this.send(target, DESKTOP_IPC.proactiveBubble, { petId: event.notice.petId, text: event.notice.text });
    const center = this.windows.get(CENTER_KEY);
    if (center && this.featureCurrent(this.featureStamp(center))) this.send(center, DESKTOP_IPC.proactiveNotice, event);
  }

  private petSuppressed(): boolean {
    return this.stopping || this.status.stage !== 'READY' || !this.snapshot || this.snapshot.doNotDisturb
      || this.manuallyHidden || this.suspended || this.locked;
  }

  private syncFullscreenMonitor(): void {
    if (this.stopping || this.suspended || this.locked) this.fullscreenMonitor?.stop();
    else this.fullscreenMonitor?.start();
  }

  private fullscreenState(): FullscreenState {
    const state = this.fullscreenMonitor?.state ?? { kind: 'clear' };
    return this.fullscreenEveryDisplay && state.kind === 'display' ? { kind: 'global' } : state;
  }

  private windowDisplayId(record: WindowRecord): number | undefined {
    try { return screen.getDisplayMatching(record.window.getBounds()).id; }
    catch { return undefined; }
  }

  private windowHidesInFullscreen(record: WindowRecord): boolean {
    const state = this.fullscreenState();
    return state.kind === 'global' || (state.kind === 'display' && fullscreenHides(state, this.windowDisplayId(record) ?? -Infinity));
  }

  private windowQuietsInFullscreen(record: WindowRecord): boolean {
    const state = this.fullscreenState();
    return fullscreenQuiets(state, state.kind === 'display' ? this.windowDisplayId(record) ?? -Infinity : -Infinity);
  }

  private applyFullscreenState(): void {
    if (this.stopping || this.locked || this.suspended) return;
    const owner = this.voiceOwner;
    if (owner && this.windowQuietsInFullscreen(owner.stamp.record)) this.invalidateVoice(owner.stamp.record);
    this.reconcilePets();
    this.updateTray();
  }

  private getDesiredPet(): PetSurfaceIdentity | undefined {
    return desiredPetSurface(this.snapshot, this.status, this.petSuppressed());
  }

  private isActivePet(record: WindowRecord): boolean {
    const desired = this.getDesiredPet();
    const pet = record.pet;
    return this.isCurrent(record) && pet !== undefined && desired !== undefined
      && pet.phase === 'ACTIVE' && samePetSurface(pet.identity, desired)
      && pet.documentReady && pet.visualResult !== undefined && record.ready && record.responsive
      && !this.windowHidesInFullscreen(record);
  }

  private clearPetTimers(pet: PetWindowState): void {
    if (pet.stagingTimer !== undefined) clearTimeout(pet.stagingTimer);
    if (pet.retirementTimer !== undefined) clearTimeout(pet.retirementTimer);
    pet.stagingTimer = undefined;
    pet.retirementTimer = undefined;
    pet.retirementDeadline = undefined;
  }

  private setPetPhase(record: WindowRecord, phase: PetSurfacePhase): void {
    const pet = record.pet;
    if (!pet || !this.isCurrent(record)) return;
    if (pet.phase !== phase) {
      this.clearPetTimers(pet);
      pet.phase = phase;
    }
    if (phase === 'STAGING' && pet.stagingTimer === undefined) {
      pet.stagingTimer = setTimeout(() => {
        if (!this.isCurrent(record) || pet.phase !== 'STAGING') return;
        devLog('pet visual staging timed out');
        this.diagnostics?.record({ event: 'window-staging-timeout', role: 'pet' });
        this.recoverWindow(record);
      }, PET_VISUAL_TIMEOUT_MS);
    } else if (phase === 'RETIRING' && pet.retirementTimer === undefined) {
      // Absolute deadline per retained surface, not per new target. A rapid
      // B->C request or failed staging attempt must not extend old A forever.
      pet.retirementDeadline = performance.now() + PET_VISUAL_TIMEOUT_MS;
      pet.retirementTimer = setTimeout(() => {
        if (!this.isCurrent(record) || pet.phase !== 'RETIRING') return;
        this.destroyWindow(record);
        this.reconcilePets();
      }, PET_VISUAL_TIMEOUT_MS);
    }
    if (phase !== 'ACTIVE') {
      if (this.mouthRun?.target === record) this.clearMouth();
      record.inputLease.clear();
      this.updatePetInput(record);
    }
  }

  /** Keep at most one displayed surface and one hidden staging window. Native
   * visibility follows the plan, but only authority selects/owns the pet. */
  private reconcilePets(): void {
    this.syncTravelReturnSummary();
    const surfaces: PetSurfaceInfo[] = [];
    for (const record of this.windows.values()) {
      const pet = record.pet;
      if (!pet || !this.isCurrent(record)) continue;
      surfaces.push({
        senderId: record.binding.senderId, identity: pet.identity, phase: pet.phase,
        documentReady: pet.documentReady, paintReady: record.ready, visualResult: pet.visualResult,
        responsive: record.responsive, visible: record.window.isVisible(), retirementDeadline: pet.retirementDeadline,
      });
    }
    const plan = planPetHandover(this.snapshot, this.status, this.petSuppressed(), surfaces, performance.now());

    // Disable input before any old surface is retired. Unexpected native close
    // and late callbacks cannot re-authorize a non-desired window.
    const retiring = plan.retiring === undefined ? undefined : this.senders.get(plan.retiring);
    if (retiring) {
      this.setPetPhase(retiring, 'RETIRING');
      if (this.windowHidesInFullscreen(retiring)) retiring.window.hide();
    }
    const staging = plan.staging === undefined ? undefined : this.senders.get(plan.staging);
    if (staging) {
      this.setPetPhase(staging, 'STAGING');
      if (staging.window.isVisible()) staging.window.hide();
    }
    // Old surface must disappear before showing the newly ready one. Pending
    // failed/obsolete staging surfaces are removed before creating the next.
    for (const senderId of plan.remove) {
      const record = this.senders.get(senderId);
      if (record) this.destroyWindow(record);
    }
    const active = plan.active === undefined ? undefined : this.senders.get(plan.active);
    if (active && this.isCurrent(active)) {
      this.setPetPhase(active, 'ACTIVE');
      try {
        if (!this.updatePetInput(active) || this.windowHidesInFullscreen(active)) {
          if (active.window.isVisible()) active.window.hide();
        } else if (!active.window.isVisible()) active.window.showInactive();
      } catch {
        devLog('pet surface could not be presented');
        this.diagnostics?.record({ event: 'window-presentation-failed', role: 'pet' });
        this.recoverWindow(active);
      }
    }
    if (plan.create) {
      const key = `pet:${plan.create.petId}`;
      if (!this.windows.has(key) && !this.blocked.has(key) && !this.retryTimers.has(key)) {
        try { this.createWindow(key, plan.create, false); }
        catch {
          devLog('pet staging window could not be created');
          this.diagnostics?.record({ event: 'window-create-failed', role: 'pet' });
          const record = this.windows.get(key);
          if (record) this.recoverWindow(record);
          else this.scheduleRecovery(key, 'pet');
        }
      }
    }
    this.syncWalkMotion(active);
    this.syncProactive();
  }

  private stopWalkMotion(resetAttempt = false): void {
    if (this.walkingRun) clearInterval(this.walkingRun.timer);
    this.walkingRun = undefined;
    if (resetAttempt) this.walkingAttempt = undefined;
  }

  private canWalk(record: WindowRecord): boolean {
    return this.isActivePet(record) && record.window.isVisible() && this.inputMode === 'auto' && !this.snapshot?.pausedRender
      && this.snapshot?.pets.some((pet) => pet.petId === record.pet?.identity.petId && pet.presence === 'HOME' && pet.activity === 'WALK') === true;
  }

  /** WALK is an authority-projected visual activity, not a new game command.
   * Move only the visible own window a short distance; no cursor/OS input. */
  private syncWalkMotion(record: WindowRecord | undefined): void {
    // Transient suppression (pause, host hide, input mode) must not re-arm the
    // same authority-projected WALK. Only leave WALK or change identity.
    const desired = desiredPetSurface(this.snapshot, this.status, false);
    const stillWalking = desired && this.snapshot?.pets.some((pet) => pet.petId === desired.petId && pet.activity === 'WALK');
    const projectedIdentity = stillWalking ? `${desired.generation}:${desired.petId}` : undefined;
    if (this.walkingAttempt !== projectedIdentity) this.stopWalkMotion(true);
    if (!record?.pet || !this.canWalk(record)) { this.stopWalkMotion(); return; }
    const identity = `${record.pet.identity.generation}:${record.pet.identity.petId}`;
    if (this.walkingAttempt === identity) return;
    this.stopWalkMotion();
    this.walkingAttempt = identity;
    try {
      const bounds = record.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const plan = createWindowWalkPlan(bounds, display.workArea, (this.snapshot?.revision ?? 0) % 2 === 0 ? 1 : -1, performance.now());
      const expected = { x: bounds.x, y: bounds.y };
      if (!plan || record.inputLease.active || !canContinueWindowWalk(plan, bounds, expected, display.workArea, screen.getCursorScreenPoint())) return;
      const run: NativeWalkRun = {
        senderId: record.binding.senderId, displayId: display.id, plan, expected,
        timer: setInterval(() => this.tickWalkMotion(record, run), 100),
      };
      this.walkingRun = run;
    } catch { this.stopWalkMotion(); }
  }

  private tickWalkMotion(record: WindowRecord, run: NativeWalkRun): void {
    if (this.walkingRun !== run) return;
    try {
      if (!this.canWalk(record) || record.inputLease.active) { this.stopWalkMotion(); return; }
      const bounds = record.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const next = walkPositionAt(run.plan, performance.now());
      if (display.id !== run.displayId || !canContinueWindowWalk(run.plan, bounds, run.expected, display.workArea, screen.getCursorScreenPoint(), next.position)) {
        this.stopWalkMotion(); return;
      }
      if (next.position.x !== run.expected.x || next.position.y !== run.expected.y) {
        record.window.setPosition(next.position.x, next.position.y, false);
        run.expected = next.position;
      }
      if (next.done) this.stopWalkMotion();
    } catch { this.stopWalkMotion(); }
  }

  private updatePetInput(record: WindowRecord): boolean {
    if (record.binding.role !== 'pet' || !this.isCurrent(record)) return false;
    const suppressed = !this.isActivePet(record);
    if (suppressed) record.inputLease.clear();
    const ignore = suppressed || this.inputMode === 'through'
      || (this.inputMode === 'auto' && !record.inputLease.active);
    try {
      if (ignore) record.window.setIgnoreMouseEvents(true, { forward: true });
      else record.window.setIgnoreMouseEvents(false);
      return true;
    } catch {
      // Adapters lacking forwarded mouse movement fall back to full pass-through.
      record.inputLease.clear();
      try { record.window.setIgnoreMouseEvents(true); return ignore; }
      catch { record.window.hide(); return false; }
    }
  }

  private createWindow(key: string, identity: PetSurfaceIdentity | undefined, focus: boolean): void {
    const petId = identity?.petId;
    if (this.stopping && petId !== undefined) return;
    const role = petId === undefined ? 'control-center' : 'pet';
    const url = rendererUrl(this.rendererDir, role, this.devUrl, petId);
    const pet = role === 'pet';
    const window = new BrowserWindow({
      ...this.initialBounds(key, pet),
      show: false,
      title: pet ? 'Pet Desktop — Pet' : 'Pet Desktop',
      frame: !pet,
      transparent: pet,
      backgroundColor: pet ? '#00000000' : '#f5f6f8',
      alwaysOnTop: pet,
      skipTaskbar: pet,
      resizable: !pet,
      minimizable: !pet,
      maximizable: !pet,
      fullscreenable: !pet,
      focusable: !pet,
      hasShadow: !pet,
      webPreferences: {
        preload: join(__dirname, `../preload/${role}.cjs`),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });
    const binding: WindowBinding = petId === undefined
      ? { senderId: window.webContents.id, role: 'control-center', trustedUrl: url }
      : { senderId: window.webContents.id, role: 'pet', petId, trustedUrl: url };
    const record: WindowRecord = {
      key, window, binding, ready: false, responsive: true, focusOnReady: focus,
      documentEpoch: 0, featureEpoch: 0, documentReady: false,
      pet: identity === undefined ? undefined : {
        identity, phase: 'STAGING', documentReady: false, visualResult: undefined,
        stagingTimer: undefined, retirementTimer: undefined, retirementDeadline: undefined,
      },
      inputLease: new InputLease(() => this.updatePetInput(record)),
    };
    this.windows.set(key, record);
    this.senders.set(binding.senderId, record);
    this.storeAnchor(record, false);
    this.protectContents(record);
    if (pet) this.setPetPhase(record, 'STAGING');
    window.on('move', () => {
      this.storeAnchor(record);
      if (record.pet?.phase === 'ACTIVE' && this.fullscreenState().kind === 'display'
        && record.window.isVisible() === this.windowHidesInFullscreen(record)) this.reconcilePets();
    });
    window.on('resize', () => this.storeAnchor(record));
    window.on('closed', () => {
      const registered = this.windows.get(record.key) === record;
      this.unregister(record);
      if (pet && registered && !this.stopping) this.scheduleRecovery(record.key, 'pet');
    });
    window.on('hide', () => {
      record.inputLease.clear();
      if (pet) { if (this.mouthRun?.target === record) this.clearMouth(); }
      else if (this.isCurrent(record)) this.invalidateFeatures(record);
    });
    window.on('blur', () => {
      // Opening a native permission/credential prompt can blur the owner.
      // Cancel only an active voice session, not an idle consent or text turn.
      if (!pet && this.isCurrent(record) && (this.voiceOwner?.stamp.record === record || this.micLease?.stamp.record === record)) this.invalidateVoice(record);
    });
    window.on('unresponsive', () => {
      record.responsive = false;
      record.inputLease.clear();
      if (pet) this.reconcilePets();
      else this.invalidateFeatures(record);
    });
    window.on('responsive', () => { record.responsive = true; if (pet) this.reconcilePets(); });
    window.once('ready-to-show', () => {
      if (!this.isCurrent(record)) return;
      record.ready = true;
      if (pet) this.reconcilePets();
      else if (record.focusOnReady) { window.show(); window.focus(); }
      else window.showInactive();
    });
    window.webContents.on('did-finish-load', () => {
      if (!this.isCurrent(record)) return;
      devLog('renderer loaded', role);
      this.diagnostics?.record({ event: 'window-loaded', role });
      record.documentReady = isTrustedDocument(record.binding, window.webContents.getURL());
      if (record.pet) record.pet.documentReady = true;
      this.send(record, DESKTOP_IPC.status, this.status);
      if (record.pet && this.hostPreferences) {
        const { reducedMotion, scalePercent } = this.hostPreferences.values;
        this.send(record, DESKTOP_IPC.hostRenderPreferences, { reducedMotion, scalePercent });
      }
      if (this.status.stage === 'READY' && this.snapshot) this.send(record, DESKTOP_IPC.snapshot, this.snapshot);
      if (record.pet) this.reconcilePets();
    });
    window.webContents.on('did-start-navigation', (details) => {
      // Chromium can emit loading events while Vue changes only the hash.
      // Revoke document capabilities only when the main document is replaced.
      if (!details.isMainFrame || details.isSameDocument || !this.isCurrent(record)) return;
      record.inputLease.clear();
      record.documentReady = false;
      record.documentEpoch++;
      if (record.pet) {
        // Reloaded renderer must report a new ready surface for the same
        // authorized identity; never re-use the old document's acknowledgement.
        record.pet.documentReady = false;
        record.pet.visualResult = undefined;
        this.reconcilePets();
      } else { this.micConsent = undefined; this.invalidateFeatures(record); }
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      devLog('renderer gone', role, details.reason);
      this.diagnostics?.record({ event: 'window-exited', role, reason: diagnosticExitReason(details.reason) });
      this.recoverWindow(record);
    });
    void window.loadURL(url).catch(() => {
      devLog('renderer load failed', role);
      this.diagnostics?.record({ event: 'window-load-failed', role });
      this.recoverWindow(record);
    });
  }

  private protectContents(record: WindowRecord): void {
    const contents = record.window.webContents;
    // Application-initiated loadURL is unaffected. In-document hash routing does not navigate a frame.
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  private isCurrent(record: WindowRecord): boolean {
    return this.windows.get(record.key) === record && !record.window.isDestroyed();
  }

  private unregister(record: WindowRecord): void {
    if (record.binding.role === 'control-center' && this.windows.get(CENTER_KEY) === record) {
      this.invalidateFeatures(record);
      if (this.micConsent?.record === record) this.micConsent = undefined;
      this.invalidateMicLease(record, true);
    }
    if (this.mouthRun?.target === record) this.clearMouth();
    record.inputLease.clear();
    if (this.walkingRun?.senderId === record.binding.senderId) this.stopWalkMotion();
    if (record.pet) this.clearPetTimers(record.pet);
    if (this.windows.get(record.key) === record) this.windows.delete(record.key);
    if (this.senders.get(record.binding.senderId) === record) this.senders.delete(record.binding.senderId);
  }

  private destroyWindow(record: WindowRecord): void {
    if (!this.isCurrent(record)) return;
    this.storeAnchor(record);
    if (record.pet) {
      record.inputLease.clear();
      record.pet.phase = 'STAGING';
      this.updatePetInput(record);
      if (record.window.isVisible()) record.window.hide();
    }
    this.unregister(record);
    record.window.destroy();
  }

  private recoverWindow(record: WindowRecord): void {
    if (this.stopping || !this.isCurrent(record)) return;
    this.destroyWindow(record);
    this.scheduleRecovery(record.key, record.binding.role);
  }

  private scheduleRecovery(key: string, role: WindowBinding['role']): void {
    if (this.stopping || this.retryTimers.has(key) || this.blocked.has(key)) return;
    const now = Date.now();
    const failures = (this.failures.get(key) ?? []).filter((time) => now - time < WINDOW_FAILURE_INTERVAL);
    failures.push(now);
    this.failures.set(key, failures);
    if (failures.length >= MAX_WINDOW_FAILURES) {
      this.blocked.add(key);
      this.updateTray();
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.stopping) return;
      if (role === 'control-center') {
        if (!this.windows.has(CENTER_KEY)) this.createWindow(CENTER_KEY, undefined, false);
      } else this.reconcilePets();
    }, 250 * failures.length);
    this.retryTimers.set(key, timer);
  }

  private resetFailures(key: string): void {
    this.failures.delete(key);
    this.blocked.delete(key);
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(key);
  }

  private initialBounds(key: string, pet: boolean): Rectangle {
    const anchor = this.anchors.get(key);
    const display = screen.getAllDisplays().find((candidate) => candidate.id === anchor?.displayId)
      ?? screen.getPrimaryDisplay();
    const area = display.workArea;
    const size = pet ? this.petSize() : { width: anchor?.width ?? 900, height: anchor?.height ?? 680 };
    const offset = pet ? 30 * this.windows.size : 0;
    const x = anchor ? area.x + anchor.offsetX : pet ? area.x + area.width - size.width - 24 - offset
      : area.x + Math.round((area.width - size.width) / 2);
    const y = anchor ? area.y + anchor.offsetY : pet ? area.y + area.height - size.height - 24
      : area.y + Math.round((area.height - size.height) / 2);
    return clampBounds({ x, y, ...size }, area);
  }

  private storeAnchor(record: WindowRecord, persist = true): void {
    if (this.stopping || !this.isCurrent(record) || record.window.isMinimized() || record.window.isMaximized() || record.window.isFullScreen()) return;
    const bounds = record.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const before = this.anchors.get(record.key);
    const parsed = hostWindowAnchorSchema.safeParse({
      role: record.binding.role,
      petId: record.binding.role === 'pet' ? record.binding.petId : null,
      displayId: display.id,
      offsetX: bounds.x - display.workArea.x,
      offsetY: bounds.y - display.workArea.y,
      ...bounds,
      displayScale1000: Math.round(display.scaleFactor * 1000),
      observedAt: Math.max(Date.now(), (before?.observedAt ?? 0) + 1),
    });
    if (!parsed.success) return;
    const next = parsed.data;
    if (before && before.displayId === next.displayId && before.displayScale1000 === next.displayScale1000
      && before.x === next.x && before.y === next.y && before.width === next.width && before.height === next.height
      && before.offsetX === next.offsetX && before.offsetY === next.offsetY) return;
    this.anchors.set(record.key, next);
    if (!persist) return;
    const timer = this.anchorWrites.get(record.key);
    if (timer) clearTimeout(timer);
    this.anchorWrites.set(record.key, setTimeout(() => { void this.persistWindowAnchor(record.key); }, 400));
  }

  private async persistWindowAnchor(key: string): Promise<void> {
    const timer = this.anchorWrites.get(key);
    if (timer) clearTimeout(timer);
    this.anchorWrites.delete(key);
    const anchor = this.anchors.get(key);
    if (!anchor || this.status.stage !== 'READY') return;
    await this.service.requestHost({ kind: 'save-window-anchor', anchor }).catch(() => undefined);
  }

  private async refreshWindowAnchors(generation: number): Promise<void> {
    const baseline = new Map(this.anchors);
    try {
      const response = await this.service.requestHost({ kind: 'window-anchors' });
      if (this.stopping || this.status.stage !== 'READY' || this.status.generation !== generation
        || response.kind !== 'window-anchors' || !response.result.ok) return;
      for (const anchor of response.result.anchors) {
        const key = anchor.role === 'pet' ? `pet:${anchor.petId}` : CENTER_KEY;
        if (this.anchors.get(key) !== baseline.get(key) || this.anchorWrites.has(key)) continue;
        this.anchors.set(key, anchor);
        const record = this.windows.get(key);
        if (!record || !this.isCurrent(record) || record.window.isMaximized() || record.window.isFullScreen()) continue;
        record.window.setBounds(this.initialBounds(key, anchor.role === 'pet'));
      }
    } catch { /* Window positions remain usable with session defaults. */ }
  }

  private reflowWindows(): void {
    for (const record of this.windows.values()) {
      if (!this.isCurrent(record) || record.window.isMaximized() || record.window.isFullScreen()) continue;
      const currentBounds = record.window.getBounds();
      const anchor = this.anchors.get(record.key);
      const display = screen.getAllDisplays().find((candidate) => candidate.id === anchor?.displayId)
        ?? screen.getDisplayMatching(currentBounds);
      const area = display.workArea;
      const bounds = clampBounds({
        ...currentBounds,
        ...(anchor ? { x: area.x + anchor.offsetX, y: area.y + anchor.offsetY } : {}),
      }, area);
      record.window.setBounds(bounds);
      this.storeAnchor(record);
    }
    this.reconcilePets();
  }

  private setInputMode(mode: typeof this.inputMode): void {
    if (this.interactionTimer !== undefined) clearTimeout(this.interactionTimer);
    this.interactionTimer = undefined;
    this.inputMode = mode;
    if (mode !== 'auto') this.stopWalkMotion();
    if (mode === 'temporary-interactive') {
      this.interactionTimer = setTimeout(() => this.setInputMode('auto'), TEMP_INTERACTION_MS);
    }
    for (const record of this.windows.values()) {
      record.inputLease.clear();
      this.updatePetInput(record);
    }
    this.updateTray();
  }

  private togglePetVisibility(): void {
    this.manuallyHidden = !this.manuallyHidden;
    this.reconcilePets();
    this.updateTray();
  }

  private travelNoticesQuiet(): boolean {
    return this.stopping || this.status.stage !== 'READY' || !this.snapshot || this.snapshot.doNotDisturb
      || this.suspended || this.locked || this.fullscreenState().kind !== 'clear';
  }

  private syncTravelReturnSummary(): void {
    if (this.travelNoticesQuiet()) {
      clearTimeout(this.travelNoticeTimer);
      this.travelNoticeTimer = undefined;
      if (this.travelBalloon) {
        this.travelBalloon = false;
        try { this.tray?.removeBalloon(); } catch { /* Explorer can be restarting. */ }
      }
      return;
    }
    if (!this.travelReturnNotices.pendingCount || this.travelNoticeTimer) return;
    this.travelNoticeTimer = setTimeout(() => {
      this.travelNoticeTimer = undefined;
      const tray = this.tray, count = this.travelReturnNotices.pendingCount;
      if (!tray || tray.isDestroyed() || !count || this.travelNoticesQuiet()) return;
      this.travelReturnNotices.markPresented();
      try { this.updateTray(); } catch { /* Explorer can be restarting. */ }
      if (process.platform === 'win32') {
        try {
          tray.displayBalloon({ title: '旅行已结算', content: `${count} 次旅行已结算，可在旅行页查看战报。`,
            iconType: 'info', noSound: true, respectQuietTime: true });
          this.travelBalloon = true;
        } catch { /* The tray menu remains available if Windows suppresses the balloon. */ }
      }
    }, 1_000);
    this.travelNoticeTimer.unref();
  }

  private openTravelReturnSummary(): void {
    if (!this.travelReturnNotices.presentedCount) return;
    this.openControlCenter();
    this.travelReturnNotices.acknowledgePresented();
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const returns = this.travelReturnNotices.presentedCount;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开控制中心', click: () => this.openControlCenter() },
      ...(returns ? [{ label: `打开控制中心查看旅行汇总（${returns} 次）`, click: () => this.openTravelReturnSummary() }] : []),
      ...(this.stopping ? [{ label: '等待本地服务确认退出…', enabled: false }] : []),
      { label: this.manuallyHidden ? '恢复桌面宠物' : '暂时隐藏桌面宠物', click: () => this.togglePetVisibility() },
      ...(this.fullscreenMonitor ? [{ label: '全屏时隐藏所有桌宠', type: 'checkbox' as const, checked: this.fullscreenEveryDisplay,
        click: () => { this.fullscreenEveryDisplay = !this.fullscreenEveryDisplay; this.applyFullscreenState(); } }] : []),
      { label: '自动命中（实验）', type: 'radio', checked: this.inputMode === 'auto', click: () => this.setInputMode('auto') },
      { label: '整窗鼠标穿透', type: 'radio', checked: this.inputMode === 'through', click: () => this.setInputMode('through') },
      { label: '临时矩形交互（20秒）', type: 'radio', checked: this.inputMode === 'temporary-interactive', click: () => this.setInputMode('temporary-interactive') },
      { type: 'separator' },
      { label: '重新尝试失效窗口', enabled: this.blocked.size > 0, click: () => {
        const centerBlocked = this.blocked.has(CENTER_KEY);
        for (const key of [...this.blocked]) this.resetFailures(key);
        if (centerBlocked) this.openControlCenter();
        this.reconcilePets();
        this.updateTray();
      } },
      { type: 'separator' },
      { label: '退出 Pet Desktop', click: () => app.quit() },
    ]));
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.syncFullscreenMonitor();
    if (this.proactiveTimer !== undefined) clearInterval(this.proactiveTimer);
    this.clearProactiveBubble();
    this.shortcuts?.close();
    this.workspaceHost?.close();
    this.invalidateFeatures();
    this.micConsent = undefined;
    this.stopWalkMotion(true);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.interactionTimer !== undefined) clearTimeout(this.interactionTimer);
    this.reconcilePets();
    this.updateTray();
    await Promise.all([...this.anchorWrites.keys()].map(key => this.persistWindowAnchor(key)));
    // A shutdown acknowledgment or kill() return is not actual writer exit.
    // The control center and tray remain available to explain STOPPING until
    // the client confirms the child process's real exit event.
    await this.service.stop();
    await this.diagnostics?.stop();
    for (const record of [...this.windows.values()]) this.destroyWindow(record);
    this.tray?.destroy();
  }
}

function configureDevelopmentData(): void {
  if (app.isPackaged) return;
  const override = process.env.PET_DESKTOP_DEV_DATA_DIR;
  if (override !== undefined && !isAbsolute(override)) throw new Error('Development data directory must be absolute');
  const directory = override ?? join(app.getAppPath(), '.data', 'development');
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

configureDevelopmentData();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let host: DesktopHost | undefined;
  let diagnostics: DesktopDiagnostics | undefined;
  let finishing = false;
  let serviceStopped = false;
  app.on('second-instance', () => host?.openControlCenter());
  app.on('activate', () => host?.openControlCenter());
  app.on('window-all-closed', () => { /* Tray owns the resident app lifecycle. */ });
  app.on('before-quit', (event) => {
    if (serviceStopped || !host) return;
    event.preventDefault();
    if (finishing) return;
    finishing = true;
    void host.stop().then(() => {
      serviceStopped = true;
      app.quit();
    }).catch(() => {
      // If shutdown cannot establish service exit, remain alive rather than starting a second writer.
      devLog('service shutdown failed');
      diagnostics?.record({ event: 'service-shutdown-failed' });
    });
  });
  app.on('child-process-gone', (_event, details) => {
    devLog('child process gone', details.type, details.reason);
    const type = details.type.toLowerCase();
    diagnostics?.record({ event: 'child-exited', role: type === 'utility' || type === 'gpu' ? type : 'other',
      reason: diagnosticExitReason(details.reason) });
  });
  void app.whenReady().then(() => {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    diagnostics = new DesktopDiagnostics({ userDataDirectory: directory, appVersion });
    diagnostics.start();
    host = new DesktopHost(join(directory, 'pet-desktop.sqlite3'), { diagnostics });
    host.start();
  }).catch(async () => {
    devLog('host startup failed');
    diagnostics?.record({ event: 'host-startup-failed' });
    await diagnostics?.stop();
    app.quit();
  });
}
