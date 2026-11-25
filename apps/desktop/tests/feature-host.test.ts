import type { HostAuthorityRequest, HostAuthorityResult } from '../src/shared/host-settings-ipc';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '@pet-desktop/contracts/voice';
import type { AiRequest, AiResult } from '../src/shared/ai-ipc';
import type { ServiceStatus } from '../src/shared/protocol';
import type { VoiceMicGrant, VoiceOwnedJob, VoiceServiceRequest, VoiceServiceResult } from '../src/shared/voice-ipc';
import { DESKTOP_IPC } from '../src/shared/protocol';
import { sameVoiceJob } from '../src/shared/voice-ipc';
import type { VoiceSettingsRequest, VoiceSettingsResult } from '../src/shared/voice-settings-ipc';

// No Electron process, window, OS permission, audio device, keychain or
// real provider is created. These mocks exercise the registered Main IPC
// handlers and lifecycle using exact webContents/frame object identities.
const electronMock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[],
  permission: undefined as ((...args: any[]) => void) | undefined, check: undefined as (() => boolean) | undefined,
  device: undefined as (() => boolean) | undefined, prompt: vi.fn(), savePrompt: vi.fn(), power: undefined as EventEmitter | undefined,
  screen: undefined as EventEmitter | undefined }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const app = Object.assign(new EventEmitter(), { isPackaged: true, requestSingleInstanceLock: () => false, quit: vi.fn(), getPath: () => '/non-real-pet-desktop-data' });
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
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
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
      this.webContents.url = url; this.webContents.mainFrame = { url };
      this.webContents.emit('did-start-loading'); this.webContents.emit('did-finish-load'); this.emit('ready-to-show');
    }
    reload() {
      this.webContents.emit('did-start-loading');
      this.webContents.mainFrame = { url: this.webContents.url };
      this.webContents.emit('did-finish-load');
    }
  }
  electronMock.power = new EventEmitter();
  electronMock.screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) });
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} isDestroyed() { return false; } destroy() {} }
  return { app, BrowserWindow: Window, dialog: { showMessageBox: electronMock.prompt, showSaveDialog: electronMock.savePrompt }, ipcMain: { handle: (channel: string, handler: any) => electronMock.handlers.set(channel, handler) },
    Menu: { buildFromTemplate: () => ({}) }, nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) }, powerMonitor: electronMock.power,
    safeStorage: {}, screen: electronMock.screen, session: { defaultSession: {
      setPermissionRequestHandler: (handler: any) => { electronMock.permission = handler; },
      setPermissionCheckHandler: (handler: any) => { electronMock.check = handler; },
      setDevicePermissionHandler: (handler: any) => { electronMock.device = handler; },
    } }, Tray, utilityProcess: { fork: () => { throw new Error('Native process must not be created'); } } };
});

import { DesktopHost } from '../src/main/bootstrap';

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
  const service = {
    requestHost: vi.fn(async (request: HostAuthorityRequest): Promise<HostAuthorityResult> => {
      if (request.kind === 'backup') return { kind: 'backup', result: { ok: true, schemaVersion: 11 } };
      return { kind: 'preferences', result: { ok: true, preferences: { revision: 0, updatedAt: null,
        values: { hotkeysEnabled: true, scalePercent: 100, reducedMotion: false } } } };
    }),
    getStatus: () => current, start: () => snapshotListener(snapshot()), stop: async () => {}, request: vi.fn(),
    subscribeStatus: (listener: typeof statusListener) => { statusListener = listener; return () => {}; },
    subscribeSnapshot: (listener: typeof snapshotListener) => { snapshotListener = listener; return () => {}; },
    subscribeChat: vi.fn(() => () => {}),
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
  const host = new DesktopHost('/non-real.sqlite3', { service, vault });
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
  return { host, service, vault, cc, pet, call, event, callFrom, permission, authorize, reserve, grant,
    status: (status: ServiceStatus) => { current = status; statusListener(status); }, snapshot: (next: AppSnapshot) => snapshotListener(next) };
}

describe('actual Main feature IPC and lifecycle (mocked Electron)', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','setInterval','clearInterval','performance'] });
    electronMock.handlers.clear(); electronMock.windows.length = 0; electronMock.power?.removeAllListeners(); electronMock.screen?.removeAllListeners();
    electronMock.savePrompt.mockReset();
    electronMock.prompt.mockReset(); electronMock.prompt.mockResolvedValue({ response: 1 });
    f = fixture();
  });
  afterEach(async () => { await f?.host.stop(); vi.useRealTimers(); });

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
