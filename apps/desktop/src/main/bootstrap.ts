import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, screen, session, Tray, utilityProcess,
} from 'electron';
import type { IpcMainInvokeEvent, Rectangle } from 'electron';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { DESKTOP_IPC, petVisualReadySchema } from '../shared/protocol';
import type { HostActionResult, PetVisualReady, ServiceStatus } from '../shared/protocol';
import { authorizeSender, isTrustedDocument, routeRequest } from './boundary';
import type { SenderContext, WindowBinding } from './boundary';
import { ServiceClient } from './service-client';
import type { ServiceChild } from './service-client';
import { clampBounds, InputLease, rendererUrl } from './window-policy';
import { desiredPetSurface, isCurrentVisualReport, planPetHandover, samePetSurface } from './pet-handover';
import type { PetSurfaceIdentity, PetSurfaceInfo, PetSurfacePhase } from './pet-handover';

const CENTER_KEY = 'control-center';
const PET_SIZE = { width: 260, height: 295 };
const MAX_WINDOW_FAILURES = 3;
const WINDOW_FAILURE_INTERVAL = 60_000;
const TEMP_INTERACTION_MS = 20_000;
const PET_VISUAL_TIMEOUT_MS = 10_000;
const devLog = (...messages: string[]) => { if (!app.isPackaged) console.info('[desktop]', ...messages); };

interface Anchor { displayId: number; offsetX: number; offsetY: number }
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

function spawnService(databasePath: string): ServiceChild {
  const child = utilityProcess.fork(join(__dirname, 'app-service.cjs'), [databasePath], {
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

class DesktopHost {
  private readonly service: ServiceClient;
  private status: ServiceStatus;
  private snapshot: AppSnapshot | undefined;
  private pendingSnapshot: AppSnapshot | undefined;
  private readonly windows = new Map<string, WindowRecord>();
  private readonly senders = new Map<number, WindowRecord>();
  private readonly anchors = new Map<string, Anchor>();
  private readonly failures = new Map<string, number[]>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly blocked = new Set<string>();
  private tray: Tray | undefined;
  private stopping = false;
  private manuallyHidden = false;
  private suspended = false;
  private locked = false;
  private inputMode: 'auto' | 'through' | 'temporary-interactive' = 'auto';
  private interactionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly rendererDir = join(__dirname, '../renderer');
  private readonly devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

  constructor(databasePath: string) {
    this.service = new ServiceClient({ spawn: () => spawnService(databasePath) });
    this.status = this.service.getStatus();
  }

  start(): void {
    this.registerIpc();
    // Both roles currently need no browser permissions, including media/device access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setDevicePermissionHandler(() => false);

    this.tray = new Tray(makeTrayIcon());
    this.tray.setToolTip('Pet Desktop');
    this.tray.on('click', () => { this.openControlCenter(); });
    this.updateTray();

    screen.on('display-added', () => this.reflowWindows());
    screen.on('display-removed', () => this.reflowWindows());
    screen.on('display-metrics-changed', () => this.reflowWindows());
    powerMonitor.on('suspend', () => { this.suspended = true; this.reconcilePets(); });
    powerMonitor.on('resume', () => { this.suspended = false; this.reflowWindows(); });
    powerMonitor.on('lock-screen', () => { this.locked = true; this.reconcilePets(); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.reflowWindows(); });

    this.service.subscribeSnapshot((snapshot) => {
      if (this.stopping) return;
      if (this.status.stage !== 'READY') { this.pendingSnapshot = snapshot; return; }
      this.acceptSnapshot(snapshot);
    });
    this.service.subscribeStatus((status) => {
      if (status.generation !== this.status.generation || status.stage !== 'READY') {
        this.snapshot = undefined;
        // A new generation cannot use an earlier generation's projection.
        this.pendingSnapshot = undefined;
      }
      this.status = status;
      this.broadcastStatus();
      devLog('service', status.stage, `generation=${status.generation}`);
      if (status.stage === 'READY' && this.pendingSnapshot) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        this.acceptSnapshot(snapshot);
      } else {
        this.reconcilePets();
      }
    });

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
    ipcMain.handle(DESKTOP_IPC.request, (event, ...args: unknown[]) => {
      const { record, sender } = this.senderOf(event);
      const activePetRevision = record !== undefined && this.isActivePet(record) && record.window.isVisible()
        ? this.snapshot?.revision : undefined;
      return routeRequest(record?.binding, sender, args, (request) => this.service.request(request), activePetRevision);
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
    this.snapshot = snapshot;
    for (const record of this.windows.values()) this.send(record, DESKTOP_IPC.snapshot, snapshot);
    // Newly created windows fetch the current snapshot or receive it on load.
    // A window creation failure must not suppress updates to existing windows.
    this.reconcilePets();
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

  private petSuppressed(): boolean {
    return this.stopping || this.status.stage !== 'READY' || !this.snapshot || this.snapshot.doNotDisturb
      || this.manuallyHidden || this.suspended || this.locked;
  }

  private getDesiredPet(): PetSurfaceIdentity | undefined {
    return desiredPetSurface(this.snapshot, this.status, this.petSuppressed());
  }

  private isActivePet(record: WindowRecord): boolean {
    const desired = this.getDesiredPet();
    const pet = record.pet;
    return this.isCurrent(record) && pet !== undefined && desired !== undefined
      && pet.phase === 'ACTIVE' && samePetSurface(pet.identity, desired)
      && pet.documentReady && pet.visualResult !== undefined && record.ready && record.responsive;
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
      record.inputLease.clear();
      this.updatePetInput(record);
    }
  }

  /** Keep at most one displayed surface and one hidden staging window. Native
   * visibility follows the plan, but only authority selects/owns the pet. */
  private reconcilePets(): void {
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
    if (retiring) this.setPetPhase(retiring, 'RETIRING');
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
        if (!this.updatePetInput(active)) {
          if (active.window.isVisible()) active.window.hide();
        } else if (!active.window.isVisible()) active.window.showInactive();
      } catch {
        devLog('pet surface could not be presented');
        this.recoverWindow(active);
      }
    }
    if (plan.create) {
      const key = `pet:${plan.create.petId}`;
      if (!this.windows.has(key) && !this.blocked.has(key) && !this.retryTimers.has(key)) {
        try { this.createWindow(key, plan.create, false); }
        catch {
          devLog('pet staging window could not be created');
          const record = this.windows.get(key);
          if (record) this.recoverWindow(record);
          else this.scheduleRecovery(key, 'pet');
        }
      }
    }
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
      pet: identity === undefined ? undefined : {
        identity, phase: 'STAGING', documentReady: false, visualResult: undefined,
        stagingTimer: undefined, retirementTimer: undefined, retirementDeadline: undefined,
      },
      inputLease: new InputLease(() => this.updatePetInput(record)),
    };
    this.windows.set(key, record);
    this.senders.set(binding.senderId, record);
    this.storeAnchor(record);
    this.protectContents(record);
    if (pet) this.setPetPhase(record, 'STAGING');
    window.on('move', () => this.storeAnchor(record));
    window.on('resize', () => this.storeAnchor(record));
    window.on('closed', () => {
      const registered = this.windows.get(record.key) === record;
      this.unregister(record);
      if (pet && registered && !this.stopping) this.scheduleRecovery(record.key, 'pet');
    });
    window.on('hide', () => record.inputLease.clear());
    window.on('unresponsive', () => {
      record.responsive = false;
      record.inputLease.clear();
      if (pet) this.reconcilePets();
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
      if (record.pet) record.pet.documentReady = true;
      this.send(record, DESKTOP_IPC.status, this.status);
      if (this.status.stage === 'READY' && this.snapshot) this.send(record, DESKTOP_IPC.snapshot, this.snapshot);
      if (record.pet) this.reconcilePets();
    });
    window.webContents.on('did-start-loading', () => {
      record.inputLease.clear();
      if (record.pet) {
        // Reloaded renderer must report a new ready surface for the same
        // authorized identity; never re-use the old document's acknowledgement.
        record.pet.documentReady = false;
        record.pet.visualResult = undefined;
        this.reconcilePets();
      }
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      devLog('renderer gone', role, details.reason);
      this.recoverWindow(record);
    });
    void window.loadURL(url).catch(() => {
      devLog('renderer load failed', role);
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
    record.inputLease.clear();
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
    const size = pet ? PET_SIZE : { width: 900, height: 680 };
    const offset = pet ? 30 * this.windows.size : 0;
    const x = anchor ? area.x + anchor.offsetX : pet ? area.x + area.width - size.width - 24 - offset
      : area.x + Math.round((area.width - size.width) / 2);
    const y = anchor ? area.y + anchor.offsetY : pet ? area.y + area.height - size.height - 24
      : area.y + Math.round((area.height - size.height) / 2);
    return clampBounds({ x, y, ...size }, area);
  }

  private storeAnchor(record: WindowRecord): void {
    if (!this.isCurrent(record) || record.window.isMaximized() || record.window.isFullScreen()) return;
    const bounds = record.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.anchors.set(record.key, {
      displayId: display.id,
      offsetX: bounds.x - display.workArea.x,
      offsetY: bounds.y - display.workArea.y,
    });
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
    if (mode === 'temporary-interactive') {
      this.interactionTimer = setTimeout(() => this.setInputMode('auto'), TEMP_INTERACTION_MS);
    }
    for (const record of this.windows.values()) {
      record.inputLease.clear();
      this.updatePetInput(record);
    }
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开控制中心', click: () => this.openControlCenter() },
      ...(this.stopping ? [{ label: '等待本地服务确认退出…', enabled: false }] : []),
      { label: this.manuallyHidden ? '恢复桌面宠物' : '暂时隐藏桌面宠物', click: () => {
        this.manuallyHidden = !this.manuallyHidden;
        this.reconcilePets();
        this.updateTray();
      } },
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
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.interactionTimer !== undefined) clearTimeout(this.interactionTimer);
    this.reconcilePets();
    this.updateTray();
    // A shutdown acknowledgment or kill() return is not actual writer exit.
    // The control center and tray remain available to explain STOPPING until
    // the client confirms the child process's real exit event.
    await this.service.stop();
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
    });
  });
  app.on('child-process-gone', (_event, details) => devLog('child process gone', details.type, details.reason));
  void app.whenReady().then(() => {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    host = new DesktopHost(join(directory, 'pet-desktop.sqlite3'));
    host.start();
  }).catch(() => {
    devLog('host startup failed');
    app.quit();
  });
}
