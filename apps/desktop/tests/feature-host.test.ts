import type { HostAuthorityRequest, HostAuthorityResult, HostPreferencesView } from '../src/shared/host-settings-ipc';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { defaultHostShortcutBindings, type HostShortcutBindings } from '@pet-desktop/contracts/host-shortcuts';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '@pet-desktop/contracts/voice';
import type { AiRequest, AiResult } from '../src/shared/ai-ipc';
import type { ServiceStatus } from '../src/shared/protocol';
import type { VoiceMicGrant, VoiceOwnedJob, VoiceServiceRequest, VoiceServiceResult } from '../src/shared/voice-ipc';
import { DESKTOP_IPC } from '../src/shared/protocol';
import { sameVoiceJob } from '../src/shared/voice-ipc';
import type { VoiceSettingsRequest, VoiceSettingsResult } from '../src/shared/voice-settings-ipc';
import type { DesktopDiagnostics } from '../src/main/desktop-diagnostics';
import type { FullscreenSample } from '../src/main/fullscreen-policy';

// No Electron process, window, OS permission, audio device, keychain or
// real provider is created. These mocks exercise the registered Main IPC
// handlers and lifecycle using exact webContents/frame object identities.
const electronMock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[],
  permission: undefined as ((...args: any[]) => void) | undefined, check: undefined as (() => boolean) | undefined,
  device: undefined as (() => boolean) | undefined, prompt: vi.fn(), savePrompt: vi.fn(), openPrompt: vi.fn(), power: undefined as EventEmitter | undefined,
  screen: undefined as EventEmitter | undefined,
  balloon: vi.fn(), menu: vi.fn(),
  registeredShortcuts: new Map<string, () => void>(), blockedShortcuts: new Set<string>() }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const app = Object.assign(new EventEmitter(), { isPackaged: true, isReady: () => true, requestSingleInstanceLock: () => false,
    quit: vi.fn(), getPath: () => '/non-real-pet-desktop-data' });
  let id = 0;
  class Contents extends EventEmitter {
    id = ++id;
    mainFrame = { url: '' };
    url = '';
    destroyed = false;
    sent: Array<{ channel: string; value: unknown }> = [];
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    send(channel: string, value: unknown) { this.sent.push({ channel, value }); }
    setWindowOpenHandler() {}
  }
  const display = { id: 1, scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const secondary = { id: 2, scaleFactor: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };
  class Window extends EventEmitter {
    webContents = new Contents();
    visible = false;
    focused = false;
    destroyed = false;
    bounds: { x: number; y: number; width: number; height: number };
    constructor(options: { x: number; y: number; width: number; height: number }) {
      super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      electronMock.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; this.focused = false; }
    focus() { this.focused = true; }
    blur() { this.focused = false; this.emit('blur'); }
    hide() { this.visible = false; this.focused = false; this.emit('hide'); }
    destroy() { this.destroyed = true; this.visible = false; this.webContents.destroyed = true; this.emit('closed'); }
    getBounds() { return { ...this.bounds }; }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setPosition(x: number, y: number) { this.bounds = { ...this.bounds, x, y }; }
    setIgnoreMouseEvents() {}
    async loadURL(url: string) {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.webContents.url = url; this.webContents.mainFrame = { url };
      this.webContents.emit('did-finish-load'); this.emit('ready-to-show');
    }
    reload() {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.webContents.mainFrame = { url: this.webContents.url };
      this.webContents.emit('did-finish-load');
    }
  }
  electronMock.power = new EventEmitter();
  electronMock.screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display, secondary], getPrimaryDisplay: () => display,
    getDisplayMatching: ({ x }: { x: number }) => x < 0 ? secondary : display, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    screenToDipPoint: ({ x, y }: { x: number; y: number }) => x < 0 ? { x, y } : { x: Math.round(x / 1.5), y: Math.round(y / 1.5) } });
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value: unknown) { electronMock.menu(value); }
    displayBalloon(value: unknown) { electronMock.balloon(value); }
    removeBalloon() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  return { app, BrowserWindow: Window, dialog: { showMessageBox: electronMock.prompt, showSaveDialog: electronMock.savePrompt, showOpenDialog: electronMock.openPrompt }, ipcMain: { handle: (channel: string, handler: any) => electronMock.handlers.set(channel, handler) },
    globalShortcut: {
      register: (key: string, callback: () => void) => {
        if (electronMock.blockedShortcuts.has(key) || electronMock.registeredShortcuts.has(key)) return false;
        electronMock.registeredShortcuts.set(key, callback);
        return true;
      },
      isRegistered: (key: string) => electronMock.registeredShortcuts.has(key),
      unregister: (key: string) => { electronMock.registeredShortcuts.delete(key); },
    },
    Menu: { buildFromTemplate: (value: unknown) => value }, nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) }, powerMonitor: electronMock.power,
    safeStorage: {}, screen: electronMock.screen, session: { defaultSession: {
      setPermissionRequestHandler: (handler: any) => { electronMock.permission = handler; },
      setPermissionCheckHandler: (handler: any) => { electronMock.check = handler; },
      setDevicePermissionHandler: (handler: any) => { electronMock.device = handler; },
    } }, Tray, utilityProcess: { fork: () => { throw new Error('Native process must not be created'); } } };
});

import { DesktopHost } from '../src/main/bootstrap';
import { proactiveFailure } from '../src/shared/proactive-ipc';
import type { ProactiveNoticeReady, ProactiveRequest } from '../src/shared/proactive-ipc';

const snapshot = (primaryPetId = 'pet-a'): AppSnapshot => ({ revision: 0, primaryPetId, doNotDisturb: false, pausedRender: false, walletCoins: 0,
  pets: ['pet-a', 'pet-b'].map((petId) => ({ petId, characterId: petId === 'pet-a' ? 'star-singer' : 'fluffy-ranger', nickname: petId,
    presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL', visibility: petId === primaryPetId ? 'VISIBLE' : 'HIDDEN',
    moodScore: 70, healthPoints: 100, energy: 100, bond: 20, level: 1, xp: 0, revision: 0 })) });
const job = (petId = 'pet-a', n = 1): VoiceOwnedJob => ({ petId, conversationId: `conversation-${petId}`, requestId: `request-${n}`, turnId: `turn-${n}`, generation: n });
const aiRequest: AiRequest = { requestId: 'renderer-request', intent: { method: 'settings/list', payload: { offset: 0, limit: 50 } } };
const aiSuccess = (request: AiRequest): AiResult => ({ requestId: request.requestId, method: 'settings/list', ok: true, data: { providers: [], assignments: [] } });

function fixture() {
  let current = { stage: 'READY', generation: 1 } as ServiceStatus;
  let active: VoiceOwnedJob | undefined;
  let statusListener: (status: ServiceStatus) => void = () => {};
  let snapshotListener: (value: AppSnapshot) => void = () => {};
  let proactiveListener: (event: ProactiveNoticeReady) => void = () => {};
  const service = {
    requestHost: vi.fn(async (request: HostAuthorityRequest): Promise<HostAuthorityResult> => {
      if (request.kind === 'window-anchors') return { kind: request.kind, result: { ok: true, anchors: [] } };
      if (request.kind === 'save-window-anchor') return { kind: request.kind, result: { ok: true } };
      if (request.kind === 'backup') return { kind: 'backup', result: { ok: true, schemaVersion: 11 } };
      if (request.kind === 'restore-backup') return { kind: 'restore-backup', result: { ok: true } };
      if (request.kind === 'restore-status') return { kind: 'restore-status', result: { ok: true, status: 'RESTORED' } };
      return { kind: 'preferences', result: { ok: true, preferences: { revision: 0, updatedAt: null,
        values: { hotkeysEnabled: true, scalePercent: 100, reducedMotion: false } } } };
    }),
    getStatus: () => current, start: () => snapshotListener(snapshot()), stop: async () => {}, restart: vi.fn(() => true), recover: vi.fn(() => true), request: vi.fn(),
    subscribeStatus: (listener: typeof statusListener) => { statusListener = listener; return () => {}; },
    subscribeSnapshot: (listener: typeof snapshotListener) => { snapshotListener = listener; return () => {}; },
    subscribeChat: vi.fn(() => () => {}),
    subscribeProactive: (listener: typeof proactiveListener) => { proactiveListener = listener; return () => {}; },
    setProactiveHost: vi.fn(),
    requestProactive: vi.fn(async (request: ProactiveRequest) => proactiveFailure(request)),
    requestAi: vi.fn(async (request: AiRequest) => aiSuccess(request)),
    requestVoiceSettings: vi.fn(async (request: VoiceSettingsRequest):Promise<VoiceSettingsResult> => ({ok:true,kind:'profile',profile:{petId:request.petId,
      revision:request.kind==='save'||request.kind==='reset'?request.expectedRevision+1:0,updatedAt:request.kind==='save'||request.kind==='reset'?1:null,
      config:request.kind==='save'?request.config:DEFAULT_LOCAL_VOICE_CONFIG}})),
    requestWorkspace:vi.fn(async(request)=>({ok:false as const,requestId:request.requestId,method:request.intent.method,error:{code:'SERVICE_UNAVAILABLE' as const}})),
    ownsVoice: (candidate: VoiceOwnedJob) => active !== undefined && sameVoiceJob(active, candidate),
    cancelVoiceChat: vi.fn(), revokeFeatureDocument: vi.fn(() => { active = undefined; }),
    requestVoice: vi.fn(async (request: VoiceServiceRequest): Promise<VoiceServiceResult> => {
      if (request.kind === 'begin') { active = request.job; return { ok: true, kind: 'begun', job: request.job, configRevision: request.expectedConfigRevision }; }
      if (request.kind === 'cancel' || request.kind === 'finish') { active = undefined; return { ok: true, kind: 'closed', job: request.job, changed: true }; }
      if (request.kind === 'synthesize') return { ok: true, kind: 'synthesized', job: request.job,
        audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1, bytes: new Uint8Array(32000) } };
      return { ok: false, kind: 'error', code: 'unavailable', ...('job' in request ? { job: request.job } : {}) };
    }),
  };
  const vault = { save: vi.fn(async () => true), revoke: vi.fn(async () => true), resolve: vi.fn(async () => null) };
  const diagnostics = { record: vi.fn<DesktopDiagnostics['record']>(),
    publish: vi.fn<DesktopDiagnostics['publish']>(async (_destination, isCurrent) => isCurrent() ? { entries: 3 } : 'cancelled'),
    stop: vi.fn<DesktopDiagnostics['stop']>(async () => {}) };
  const fullscreenProbe = { available: true, sample: vi.fn<(_: AbortSignal) => Promise<FullscreenSample>>().mockResolvedValue({ kind: 'clear' }), stop: vi.fn() };
  const host = new DesktopHost('/non-real.sqlite3', { service, vault, diagnostics, fullscreenProbe });
  host.start();
  const cc = electronMock.windows[0],pet = electronMock.windows[1];
  function event(window = cc, frame = window.webContents.mainFrame) { return { sender: window.webContents, senderFrame: frame }; }
  function call(channel: string, ...args: unknown[]) { return electronMock.handlers.get(channel)!(event(), ...args); }
  function callFrom(window: any, channel: string, ...args: unknown[]) { return electronMock.handlers.get(channel)!(event(window), ...args); }
  function permission(window = cc, mediaTypes: unknown = ['audio'], main = true, requestingUrl = window.webContents.url, kind = 'media'): boolean {
    let value: boolean | undefined;
    electronMock.permission!(window.webContents, kind, (result: boolean) => { value = result; }, { isMainFrame: main, requestingUrl, mediaTypes });
    return value === true;
  }
  const authorize = async () => { expect(await call(DESKTOP_IPC.micAuthorize)).toEqual({ ok: true }); };
  const reserve = async (candidate = job()) => {
    expect(await call(DESKTOP_IPC.voiceRequest,{ kind: 'begin', job: candidate, expectedConfigRevision: 0 })).toMatchObject({ ok: true, kind: 'begun', job: candidate });
  };
  const grant = (candidate = job()): VoiceMicGrant => {
    const result = call(DESKTOP_IPC.micRequest, candidate); expect(result).toMatchObject({ job: candidate }); return result;
  };
  expect(callFrom(pet, DESKTOP_IPC.petVisualReady, { characterId: 'star-singer', generation: 1, result: 'READY' })).toEqual({ ok: true });
  expect(pet.visible).toBe(true);
  service.revokeFeatureDocument.mockClear();
  return { host, service, vault, diagnostics, fullscreenProbe, cc, pet, call, event, callFrom, permission, authorize, reserve, grant,
    status: (status: ServiceStatus) => { current = status; statusListener(status); }, snapshot: (next: AppSnapshot) => snapshotListener(next),
    proactive: (event: ProactiveNoticeReady) => proactiveListener(event) };
}

describe('actual Main feature IPC and lifecycle (mocked Electron)', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','setInterval','clearInterval','performance'] });
    electronMock.handlers.clear(); electronMock.windows.length = 0; electronMock.power?.removeAllListeners(); electronMock.screen?.removeAllListeners();
    electronMock.registeredShortcuts.clear(); electronMock.blockedShortcuts.clear();
    electronMock.balloon.mockClear(); electronMock.menu.mockClear();
    electronMock.savePrompt.mockReset();
    electronMock.openPrompt.mockReset();
    electronMock.prompt.mockReset(); electronMock.prompt.mockResolvedValue({ response: 1 });
    f = fixture();
  });
  afterEach(async () => { await f?.host.stop(); vi.useRealTimers(); });

  it('steps scale only for the current visible desktop pet and resizes without drifting', async () => {
    const channel = DESKTOP_IPC.changePetScale;
    let preferences: HostPreferencesView = { revision: 8, updatedAt: null,
      values: { hotkeysEnabled: false, reducedMotion: true, scalePercent: 100 } };
    f.service.requestHost.mockImplementation(async request => {
      if (request.kind === 'save') {
        expect(request.edit.expectedRevision).toBe(preferences.revision);
        expect(request.edit.reducedMotion).toBe(true);
        preferences = { ...preferences, revision: preferences.revision + 1,
          values: { ...preferences.values, scalePercent: request.edit.scalePercent } };
      }
      return { kind: 'preferences', result: { ok: true, preferences } };
    });
    f.pet.setPosition(900, 500);
    const originalBounds = f.pet.getBounds();
    expect(await f.call(channel, 'increase')).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await f.callFrom(f.pet, channel, { scalePercent: 200 })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await electronMock.handlers.get(channel)!(f.event(f.pet, { url: f.pet.webContents.url }), 'increase'))
      .toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(f.service.requestHost).not.toHaveBeenCalled();

    f.snapshot({ ...snapshot(), revision: 1, pausedRender: true });
    expect(await f.callFrom(f.pet, channel, 'increase')).toEqual({ ok: true });
    expect(f.pet.getBounds()).toEqual({ x: 868, y: 463, width: 325, height: 369 });
    expect(f.pet.webContents.sent).toContainEqual({
      channel: DESKTOP_IPC.hostRenderPreferences, value: { reducedMotion: true, scalePercent: 125 },
    });
    expect(await f.callFrom(f.pet, channel, 'decrease')).toEqual({ ok: true });
    expect(f.pet.getBounds()).toEqual(originalBounds);
    expect(preferences.values.hotkeysEnabled).toBe(false);

    f.snapshot({ ...snapshot(), revision: 2, doNotDisturb: true });
    const writes = f.service.requestHost.mock.calls.length;
    expect(await f.callFrom(f.pet, channel, 'increase')).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(f.service.requestHost.mock.calls).toHaveLength(writes);
  });

  it('refreshes a conflicted scale write and does not save past a scale limit', async () => {
    let preferences: HostPreferencesView = { revision: 1, updatedAt: null,
      values: { hotkeysEnabled: true, reducedMotion: false, scalePercent: 150 } };
    f.service.requestHost.mockImplementation(async request => {
      if (request.kind === 'save') {
        expect(request.edit).toEqual({ expectedRevision: 1, reducedMotion: false, scalePercent: 200 });
        preferences = { revision: 2, updatedAt: null,
          values: { hotkeysEnabled: false, reducedMotion: true, scalePercent: 200 } };
        return { kind: 'preferences', result: { ok: false, code: 'REVISION_CONFLICT' } };
      }
      return { kind: 'preferences', result: { ok: true, preferences } };
    });
    expect(await f.callFrom(f.pet, DESKTOP_IPC.changePetScale, 'increase')).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(f.pet.webContents.sent).toContainEqual({
      channel: DESKTOP_IPC.hostRenderPreferences, value: { reducedMotion: true, scalePercent: 200 },
    });
    expect(await f.callFrom(f.pet, DESKTOP_IPC.changePetScale, 'increase')).toEqual({ ok: true });
    expect(f.service.requestHost.mock.calls.filter(([request]) => request.kind === 'save')).toHaveLength(1);
  });

  it('quiets only the fullscreen display, cancels active voice and restores the same pet surface without focus', async () => {
    await vi.advanceTimersByTimeAsync(0);
    f.fullscreenProbe.sample.mockResolvedValue({ kind: 'display', x: -900, y: 300 });
    await vi.advanceTimersByTimeAsync(800);
    expect(f.pet.isVisible()).toBe(true);
    await f.authorize();
    await f.reserve();

    f.fullscreenProbe.sample.mockResolvedValue({ kind: 'display', x: 900, y: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.pet.isVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.pet.isVisible()).toBe(false);
    expect(f.pet.isDestroyed()).toBe(false);
    expect(f.cc.isVisible()).toBe(true);
    expect(f.service.setProactiveHost).toHaveBeenLastCalledWith(null);
    expect(f.service.cancelVoiceChat).toHaveBeenCalledOnce();
    expect(await f.call(DESKTOP_IPC.voiceRequest, { kind: 'begin', job: job('pet-a', 2), expectedConfigRevision: 0 }))
      .toMatchObject({ ok: false, code: 'permission_denied' });

    f.fullscreenProbe.sample.mockResolvedValue({ kind: 'clear' });
    await vi.advanceTimersByTimeAsync(800);
    expect(f.pet.isVisible()).toBe(true);
    expect(f.pet.isFocused()).toBe(false);
    f.snapshot({ ...snapshot(), revision: 1, doNotDisturb: true });
    expect(f.pet.isVisible()).toBe(false);
  });

  it('holds committed returns through fullscreen and manual quiet mode, then offers one summary', async () => {
    await vi.advanceTimersByTimeAsync(0);
    f.fullscreenProbe.sample.mockResolvedValue({ kind: 'global' });
    await vi.advanceTimersByTimeAsync(800);
    const tripRevision = (revision: number, settled: boolean, doNotDisturb = true): AppSnapshot => ({
      ...snapshot(), revision, doNotDisturb,
      pets: snapshot().pets.map(pet => ({
        ...pet, presence: settled ? 'HOME' : 'AWAY', activity: settled ? 'IDLE' : null,
        trip: { tripId: `trip-${pet.petId}`, routeId: 'meadow', status: settled ? 'SETTLED' : 'TRAVELING', expectedReturnAt: 2_000 },
      })),
    });
    f.snapshot(tripRevision(1, false));
    f.snapshot(tripRevision(2, true));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(electronMock.balloon).not.toHaveBeenCalled();
    f.fullscreenProbe.sample.mockResolvedValue({ kind: 'clear' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(electronMock.balloon).not.toHaveBeenCalled();
    f.snapshot(tripRevision(3, true, false));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(electronMock.menu).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ label: '打开控制中心查看旅行汇总（2 次）' }),
    ]));
    if (process.platform === 'win32') {
      expect(electronMock.balloon).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: '2 次旅行已结算，可在旅行页查看战报。', noSound: true, respectQuietTime: true,
      }));
    }
  });

  it('keeps control-center privileges across same-document routing and unrelated subframe loads', async () => {
    const contents = f.cc.webContents;
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-loading');
    contents.url = contents.mainFrame.url = `${contents.url}#/settings`;
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(await f.call(DESKTOP_IPC.hostRequest, { kind: 'preferences' })).toMatchObject({ ok: true });
    expect(f.service.revokeFeatureDocument).not.toHaveBeenCalled();
  });

  it('exports diagnostics only from the focused main control-center frame and while service is unavailable', async () => {
    const channel = DESKTOP_IPC.exportDiagnostics;
    f.status({ stage: 'UNAVAILABLE', generation: 2 });
    expect(await f.callFrom(f.pet, channel)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await f.call(channel, 'renderer-path.json')).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const subframe = f.event(f.cc, { url: f.cc.webContents.url });
    expect(await electronMock.handlers.get(channel)!(subframe)).toEqual({ ok: false, code: 'FORBIDDEN' });
    f.cc.blur();
    expect(await f.call(channel)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(electronMock.savePrompt).not.toHaveBeenCalled();
    f.cc.focus();
    const selected = join(tmpdir(), 'native-selected-diagnostic.json');
    electronMock.savePrompt.mockResolvedValueOnce({ canceled: false, filePath: selected });
    expect(await f.call(channel)).toEqual({ ok: true, entries: 3 });
    expect(f.diagnostics.publish).toHaveBeenCalledExactlyOnceWith(selected, expect.any(Function));
  });

  it('invalidates diagnostics publication when its window reloads during the native prompt', async () => {
    let finish!: (value: { canceled: boolean; filePath: string }) => void;
    electronMock.savePrompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.call(DESKTOP_IPC.exportDiagnostics);
    expect(await f.call(DESKTOP_IPC.exportDiagnostics)).toEqual({ ok: false, code: 'BUSY' });
    f.cc.reload();
    finish({ canceled: false, filePath: join(tmpdir(), 'stale-diagnostic.json') });
    expect(await pending).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(f.diagnostics.publish).not.toHaveBeenCalled();
  });

  it('restores a saved display anchor and coalesces window move events into one authoritative write', async () => {
    const stored = { role: 'control-center' as const, petId: null, displayId: 1, offsetX: 150, offsetY: 100,
      x: 150, y: 100, width: 840, height: 650, displayScale1000: 1500, observedAt: 1 };
    f.service.requestHost.mockImplementation(async request => request.kind === 'window-anchors'
      ? { kind: request.kind, result: { ok: true, anchors: [stored] } }
      : request.kind === 'save-window-anchor'
        ? { kind: request.kind, result: { ok: true } }
        : { kind: 'preferences', result: { ok: false, code: 'UNAVAILABLE' } });
    f.status({ stage: 'READY', generation: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.service.requestHost).toHaveBeenCalledWith({ kind: 'window-anchors' });
    expect(f.cc.getBounds()).toEqual({ x: 150, y: 100, width: 840, height: 650 });
    f.cc.setPosition(185, 120);
    f.cc.emit('move');
    f.cc.setPosition(195, 130);
    f.cc.emit('move');
    await vi.advanceTimersByTimeAsync(399);
    expect(f.service.requestHost.mock.calls.filter(([request]) => request.kind === 'save-window-anchor')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.requestHost).toHaveBeenLastCalledWith({
      kind: 'save-window-anchor',
      anchor: { ...stored, x: 195, y: 130, offsetX: 195, offsetY: 130, observedAt: expect.any(Number) },
    });
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'save-window-anchor', anchor: stored }))
      .rejects.toThrow('INVALID_REQUEST');
  });

  it('routes proactive requests only from the control center and shows a bubble only on the active matching pet', async () => {
    const request: ProactiveRequest = { requestId: 'read-proactive', intent: { method: 'settings/get', payload: { petId: 'pet-a' } } };
    expect(await f.callFrom(f.pet, DESKTOP_IPC.proactiveRequest, request)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(f.service.requestProactive).not.toHaveBeenCalled();
    await f.call(DESKTOP_IPC.proactiveRequest, request);
    expect(f.service.requestProactive).toHaveBeenCalledExactlyOnceWith({ ...request, requestId: expect.stringMatching(/^proactive-/u) });
    expect(f.service.setProactiveHost).toHaveBeenLastCalledWith('pet-a');

    const event: ProactiveNoticeReady = { kind: 'notice-ready', notice: {
      noticeId: 'fresh', petId: 'pet-a', trigger: 'IDLE', sourceKey: 'idle:0', sourceAt: 0, createdAt: 1, text: '测试问候',
      responseKind: 'RULE', deliveryStatus: 'READY', generation: null, readyAt: 1, acknowledgedAt: null, dismissedAt: null,
    } };
    f.proactive({ ...event, notice: { ...event.notice, petId: 'pet-b' } });
    expect(f.pet.webContents.sent).not.toContainEqual({ channel: DESKTOP_IPC.proactiveBubble, value: expect.anything() });
    f.proactive(event);
    expect(f.pet.webContents.sent).toContainEqual({ channel: DESKTOP_IPC.proactiveBubble, value: { petId: 'pet-a', text: '测试问候' } });
    f.snapshot({ ...snapshot(), revision: 1, doNotDisturb: true });
    expect(f.service.setProactiveHost).toHaveBeenLastCalledWith(null);
    expect(f.pet.visible).toBe(false);
    f.proactive(event);
    expect(f.pet.webContents.sent.filter((entry: { channel: string }) => entry.channel === DESKTOP_IPC.proactiveBubble)).toHaveLength(1);
  });

  it('accepts backup only from the focused control center and sends only the native-selected path to the writer', async () => {
    const destination = join(tmpdir(), 'synthetic-backup.sqlite3');
    electronMock.savePrompt.mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(f.callFrom(f.pet, DESKTOP_IPC.hostRequest, { kind: 'backup' })).rejects.toThrow('FORBIDDEN');
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'backup', destination })).rejects.toThrow('INVALID_REQUEST');
    expect(electronMock.savePrompt).not.toHaveBeenCalled();
    expect(await f.call(DESKTOP_IPC.hostRequest, { kind: 'backup' })).toEqual({ ok: false, code: 'CANCELLED' });
    expect(f.service.requestHost).not.toHaveBeenCalled();
    expect(await f.call(DESKTOP_IPC.hostRequest, { kind: 'backup' })).toEqual({ ok: true, schemaVersion: 11 });
    expect(f.service.requestHost).toHaveBeenCalledExactlyOnceWith({ kind: 'backup', destination });
  });

  it.runIf(process.platform === 'win32')('activates only the authoritative edit and keeps prior shortcuts on conflict or save failure', async () => {
    const channel = DESKTOP_IPC.hostRequest;
    const previousKey = defaultHostShortcutBindings.OPEN_CONTROL_CENTER;
    const newKey = 'CommandOrControl+Alt+F9';
    let stored: { revision: number; bindings: HostShortcutBindings } = { revision: 0, bindings: { ...defaultHostShortcutBindings } };
    const requestHost = f.service.requestHost.getMockImplementation()!;
    const save = vi.fn(async (): Promise<HostAuthorityResult> => ({ kind: 'shortcut-bindings', result: { ok: false, code: 'SERVICE_UNAVAILABLE' } }));
    f.service.requestHost.mockImplementation(async request => {
      if (request.kind === 'shortcut-bindings') return { kind: 'shortcut-bindings', result: { ok: true, preferences: stored } };
      if (request.kind === 'save-shortcut-bindings') return save();
      return requestHost(request);
    });
    expect(await f.call(channel, { kind: 'settings' })).toMatchObject({ ok: true });
    expect(electronMock.registeredShortcuts.has(previousKey)).toBe(true);

    const request = { kind: 'save-shortcut-bindings', edit: {
      expectedRevision: 0, bindings: { ...defaultHostShortcutBindings, OPEN_CONTROL_CENTER: newKey },
    } };
    await expect(f.callFrom(f.pet, channel, request)).rejects.toThrow('FORBIDDEN');
    electronMock.blockedShortcuts.add(newKey);
    expect(await f.call(channel, request)).toEqual({ ok: false, code: 'CONFLICT', id: 'OPEN_CONTROL_CENTER' });
    expect(save).not.toHaveBeenCalled();
    expect(electronMock.registeredShortcuts.has(previousKey)).toBe(true);

    electronMock.blockedShortcuts.delete(newKey);
    expect(await f.call(channel, request)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(electronMock.registeredShortcuts.has(newKey)).toBe(false);
    expect(electronMock.registeredShortcuts.has(previousKey)).toBe(true);

    let acknowledge!: (reply: HostAuthorityResult) => void;
    save.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const pending = f.call(channel, request);
    expect(electronMock.registeredShortcuts.has(newKey)).toBe(true);
    f.cc.blur();
    electronMock.registeredShortcuts.get(newKey)!();
    expect(f.cc.isFocused()).toBe(false);
    f.cc.focus();
    stored = { revision: 1, bindings: request.edit.bindings };
    acknowledge({ kind: 'shortcut-bindings', result: { ok: true, preferences: stored } });
    expect(await pending).toEqual({ ok: true, preferences: stored });
    expect(electronMock.registeredShortcuts.has(previousKey)).toBe(false);
    expect(electronMock.registeredShortcuts.has(newKey)).toBe(true);

    f.status({ stage: 'READY', generation: 2 });
    expect(await f.call(channel, { kind: 'settings' })).toMatchObject({ ok: true, settings: { shortcuts: {
      entries: expect.arrayContaining([{ id: 'OPEN_CONTROL_CENTER', accelerator: newKey, status: 'REGISTERED' }]),
    } } });
  });

  it('requires the focused control center, native selection and affirmative restore confirmation before triggering maintenance', async () => {
    const source = join(tmpdir(), 'synthetic 源备份.sqlite3');
    await expect(f.callFrom(f.pet, DESKTOP_IPC.hostRequest, { kind: 'restore-backup' })).rejects.toThrow('FORBIDDEN');
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-backup', source })).rejects.toThrow('INVALID_REQUEST');
    expect(electronMock.openPrompt).not.toHaveBeenCalled();
    electronMock.openPrompt.mockResolvedValue({ canceled: false, filePaths: [source] });
    electronMock.prompt.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-backup' })).resolves.toEqual({ ok: false, code: 'CANCELLED' });
    expect(f.service.requestHost).not.toHaveBeenCalled();
    expect(f.service.restart).not.toHaveBeenCalled();
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-backup' })).resolves.toEqual({ ok: true });
    expect(f.service.requestHost).toHaveBeenCalledExactlyOnceWith({ kind: 'restore-backup', source });
    expect(f.service.restart).toHaveBeenCalledOnce();
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-status' })).resolves.toEqual({ ok: true, status: 'RESTORED' });
  });

  it('allows controlled recovery from an unavailable service only after a native confirmation', async () => {
    const source = join(tmpdir(), 'recovery.sqlite3');
    f.status({ stage: 'UNAVAILABLE', generation: 1 });
    electronMock.openPrompt.mockResolvedValue({ canceled: false, filePaths: [source] });
    electronMock.prompt.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-backup' })).resolves.toEqual({ ok: false, code: 'CANCELLED' });
    expect(f.service.recover).not.toHaveBeenCalled();
    await expect(f.call(DESKTOP_IPC.hostRequest, { kind: 'restore-backup' })).resolves.toEqual({ ok: true });
    expect(f.service.recover).toHaveBeenCalledExactlyOnceWith(source);
    expect(f.service.requestHost).not.toHaveBeenCalled();
  });

  it('accepts only the trusted control-center main frame and remaps the AI transport correlation ID', async () => {
    expect(await f.call(DESKTOP_IPC.aiRequest, aiRequest)).toEqual(aiSuccess(aiRequest));
    const upstream = f.service.requestAi.mock.calls[0]![0];
    expect(upstream.requestId).not.toBe(aiRequest.requestId); expect(upstream.intent).toEqual(aiRequest.intent);
    await expect(f.callFrom(f.pet, DESKTOP_IPC.aiRequest, aiRequest)).rejects.toThrow('FORBIDDEN');
    await expect(electronMock.handlers.get(DESKTOP_IPC.aiRequest)!(f.event(f.cc, { url: f.cc.webContents.url }), aiRequest)).rejects.toThrow('FORBIDDEN');
    await expect(f.call(DESKTOP_IPC.aiRequest, { ...aiRequest, secret: 'not-allowed' })).rejects.toThrow('INVALID_REQUEST');
    expect(f.service.requestAi).toHaveBeenCalledTimes(1);
  });

  it('drops an in-flight response on reload, even when the new URL is identical, and revokes the old feature document', async () => {
    let done!: (result: AiResult) => void;
    f.service.requestAi.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = f.call(DESKTOP_IPC.aiRequest, aiRequest);
    const upstream = f.service.requestAi.mock.calls[0]![0];
    f.cc.reload(); done(aiSuccess(upstream));
    expect(await pending).toMatchObject({ ok: false, requestId: aiRequest.requestId, error: { code: 'UNAVAILABLE' } });
    expect(f.service.revokeFeatureDocument).toHaveBeenCalled();
    expect(await f.call(DESKTOP_IPC.aiRequest, aiRequest)).toMatchObject({ ok: true });
  });

  it('requires native explicit credential approval and never includes plaintext in the confirmation', async () => {
    const credential = { providerId: 'provider-test', credentialRef: 'credential:test', secret: 'synthetic-test-key-only' };
    electronMock.prompt.mockResolvedValueOnce({ response: 0 });
    expect(await f.call(DESKTOP_IPC.credentialSave, credential)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(f.vault.save).not.toHaveBeenCalled();
    expect(await f.call(DESKTOP_IPC.credentialSave, credential)).toEqual({ ok: true });
    expect(f.vault.save).toHaveBeenCalledWith(credential.providerId, credential.credentialRef, credential.secret);
    expect(JSON.stringify(electronMock.prompt.mock.calls.map(call => call[1]))).not.toContain(credential.secret);
    expect(await f.call(DESKTOP_IPC.credentialRevoke, { providerId: credential.providerId, credentialRef: credential.credentialRef })).toEqual({ ok: true });
    expect(f.vault.revoke).toHaveBeenCalledWith(credential.providerId, credential.credentialRef);
    expect(await f.callFrom(f.pet, DESKTOP_IPC.credentialSave, credential)).toMatchObject({ ok: false });
  });

  it('rejects delayed native approval after document replacement before any credential write', async () => {
    let approve!: (result: { response: number }) => void;
    electronMock.prompt.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    const pending = f.call(DESKTOP_IPC.credentialSave, { providerId: 'provider-test', credentialRef: 'credential:test', secret: 'synthetic-only' });
    f.cc.reload(); approve({ response: 1 });
    expect(await pending).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(f.vault.save).not.toHaveBeenCalled();
  });

  it('native microphone approval grants no browser permission until a current exact job reserves and requests a lease', async () => {
    expect(electronMock.check!()).toBe(false); expect(electronMock.device!()).toBe(false);
    expect(f.permission()).toBe(false); expect(f.call(DESKTOP_IPC.micRequest, job())).toBeNull();
    expect(await f.call(DESKTOP_IPC.voiceRequest,{ kind: 'begin', job: job(), expectedConfigRevision: 0 })).toMatchObject({ ok: false });
    electronMock.prompt.mockImplementationOnce(async () => { f.cc.blur(); return { response: 1 }; });
    await f.authorize(); f.cc.focus();
    expect(f.service.revokeFeatureDocument).not.toHaveBeenCalled(); expect(f.permission()).toBe(false);
    const otherPet = job('pet-b'); await f.reserve(otherPet); // valid nonprimary pet
    expect(f.call(DESKTOP_IPC.micRequest, job())).toBeNull();
    const lease = f.grant(otherPet);
    expect(f.permission(f.cc, ['audio','video'])).toBe(false);
    expect(f.permission(f.cc, ['audio'], false)).toBe(false);
    expect(f.permission(f.cc, ['audio'], true, 'https://untrusted.invalid')).toBe(false);
    expect(f.permission(f.pet)).toBe(false); expect(f.permission(f.cc, ['audio'], true, f.cc.webContents.url, 'display-capture')).toBe(false);
    expect(f.permission()).toBe(true); expect(f.permission()).toBe(false);
    f.call(DESKTOP_IPC.micRevoke, lease); expect(f.call(DESKTOP_IPC.micRequest, otherPet)).toBeNull();
  });

  it('never revokes an ordinary text turn on an idle blur but cancels the exact voice job and requires release acknowledgement', async () => {
    f.cc.blur(); expect(f.service.revokeFeatureDocument).not.toHaveBeenCalled(); expect(f.service.cancelVoiceChat).not.toHaveBeenCalled(); f.cc.focus();
    await f.authorize(); await f.reserve(); const lease = f.grant(); expect(f.permission()).toBe(true);
    f.cc.blur();
    expect(f.service.cancelVoiceChat).toHaveBeenCalledWith({ petId: job().petId, conversationId: job().conversationId, requestId: job().requestId }, 'SERVICE_STOPPED');
    expect(f.service.revokeFeatureDocument).not.toHaveBeenCalled();
    expect(f.cc.webContents.sent).toContainEqual({ channel: DESKTOP_IPC.voiceSuspend, value: true });
    f.cc.focus(); expect(await f.call(DESKTOP_IPC.voiceRequest,{ kind: 'begin', job: job('pet-a',2), expectedConfigRevision: 0 })).toMatchObject({ ok: false });
    // The authenticated owner may acknowledge release even if focus was lost.
    f.cc.blur(); f.call(DESKTOP_IPC.micRevoke, lease); f.cc.focus();
    await f.reserve(job('pet-a',2)); expect(f.cc.destroyed).toBe(false);
  });

  it('recovers the document if consumed microphone capture outlives 35 seconds without a release', async () => {
    await f.authorize(); await f.reserve(); f.grant(); expect(f.permission()).toBe(true);
    await vi.advanceTimersByTimeAsync(34_999); expect(f.cc.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(f.cc.destroyed).toBe(true);
    expect(f.service.revokeFeatureDocument).toHaveBeenCalled(); expect(f.permission()).toBe(false);
  });

  it('revokes a consumed lease on suspend and recovers its owner if cleanup is not acknowledged', async () => {
    await f.authorize(); await f.reserve(); f.grant(); expect(f.permission()).toBe(true);
    electronMock.power?.emit('suspend'); expect(f.permission()).toBe(false);
    expect(f.service.revokeFeatureDocument).toHaveBeenCalled(); expect(f.cc.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); expect(f.cc.destroyed).toBe(true);
  });

  it('invalidates document-scoped native consent and all old exact jobs on generation change', async () => {
    await f.authorize(); await f.reserve(); const lease = f.grant();
    f.status({ stage: 'RESTARTING', generation: 1 }); f.status({ stage: 'READY', generation: 2 }); f.snapshot(snapshot());
    expect(f.permission()).toBe(false); f.call(DESKTOP_IPC.micRevoke,lease);
    expect(await f.call(DESKTOP_IPC.voiceRequest,{kind:'begin',job:job('pet-a',2),expectedConfigRevision:0})).toMatchObject({ok:false});
    await f.authorize(); await f.reserve(job('pet-a',2));
  });

  it('scopes local voice settings to current owned pets and never mutates during an active voice session',async()=>{
    expect(await f.call(DESKTOP_IPC.voiceSettingsRequest,{kind:'get',petId:'pet-b'})).toMatchObject({ok:true,profile:{petId:'pet-b'}});
    expect(await f.call(DESKTOP_IPC.voiceSettingsRequest,{kind:'get',petId:'unknown'})).toEqual({ok:false,kind:'error',code:'NOT_FOUND',petId:'unknown'});
    expect(await f.callFrom(f.pet,DESKTOP_IPC.voiceSettingsRequest,{kind:'get',petId:'pet-a'})).toMatchObject({ok:false});
    expect(await f.call(DESKTOP_IPC.voiceSettingsRequest,{kind:'get',petId:'pet-a',secret:'synthetic-only'})).toEqual({ok:false,kind:'error',code:'INVALID_REQUEST'});
    await f.authorize();await f.reserve();
    expect(await f.call(DESKTOP_IPC.voiceSettingsRequest,{kind:'reset',petId:'pet-a',expectedRevision:0})).toEqual({ok:false,kind:'error',code:'BUSY',petId:'pet-a'});
    expect(f.service.requestVoiceSettings).toHaveBeenCalledTimes(1);
    await f.call(DESKTOP_IPC.voiceRequest,{kind:'finish',job:job()});
    expect(await f.call(DESKTOP_IPC.voiceSettingsRequest,{kind:'reset',petId:'pet-a',expectedRevision:0})).toMatchObject({ok:true,profile:{petId:'pet-a',revision:1}});
  });

  it('publishes only exact synthesized voice mouth identity to the visible matching pet and bounds samples/rate', async () => {
    await f.authorize(); await f.reserve();
    const current=job(),other=job('pet-b');
    const begin={kind:'begin',job:current,durationMs:1000};
    const count=()=>f.pet.webContents.sent.filter((entry: any)=>entry.channel===DESKTOP_IPC.voiceMouth).length;
    f.call(DESKTOP_IPC.voiceMouth,begin); expect(count()).toBe(0);
    await f.call(DESKTOP_IPC.voiceRequest,{kind:'synthesize',job:current});
    f.call(DESKTOP_IPC.voiceMouth,{...begin,job:other}); f.call(DESKTOP_IPC.voiceMouth,{...begin,durationMs:900}); expect(count()).toBe(0);
    f.call(DESKTOP_IPC.voiceMouth,begin); expect(count()).toBe(1);
    const sample=(atMs:number)=>({kind:'sample',job:current,sample:{petId:current.petId,turnId:current.turnId,generation:current.generation,atMs,mouthOpen:.5,speaking:true}});
    f.call(DESKTOP_IPC.voiceMouth,sample(0));f.call(DESKTOP_IPC.voiceMouth,sample(20)); expect(count()).toBe(2);
    await vi.advanceTimersByTimeAsync(34); f.call(DESKTOP_IPC.voiceMouth,sample(34));expect(count()).toBe(3);
    await vi.advanceTimersByTimeAsync(34); f.call(DESKTOP_IPC.voiceMouth,sample(1)); f.call(DESKTOP_IPC.voiceMouth,sample(1500));expect(count()).toBe(3);
    expect(f.cc.webContents.sent.filter((entry: any)=>entry.channel===DESKTOP_IPC.voiceMouth)).toEqual([]);
    f.snapshot(snapshot('pet-b'));expect(f.pet.webContents.sent).toContainEqual({channel:DESKTOP_IPC.voiceMouth,value:{kind:'clear',job:current}});
    f.call(DESKTOP_IPC.voiceMouth,sample(100));expect(count()).toBe(4);
  });
});
