import { describe, expect, it, vi } from 'vitest';
import { defaultHostShortcutBindings } from '@pet-desktop/contracts/host-shortcuts';
import { charactersIpcResultSchema, galleryIpcResultSchema, ipcRequestSchema, ipcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, CharacterCatalogRow, CharactersIpcResult, DomainCommand, GalleryIpcResult, GalleryQuery, InventoryIpcResult, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import { createControlCenterBridge, createPetBridge } from '../src/preload/bridge.js';
import type { DesktopIpcPort } from '../src/preload/bridge.js';
import { DESKTOP_IPC } from '../src/shared/protocol.js';
import type { PetVisualReady, ServiceStatus } from '../src/shared/protocol.js';

type PushListener = Parameters<DesktopIpcPort['on']>[1];
type InvokeChannel = Parameters<DesktopIpcPort['invoke']>[0];
type PushChannel = Parameters<DesktopIpcPort['on']>[0];

const snapshot = {
  revision: 8, primaryPetId: null, pets: [], walletCoins: 10,
  doNotDisturb: false, pausedRender: false,
} satisfies AppSnapshot;

const status = { stage: 'READY', generation: 3 } satisfies ServiceStatus;
const ready = { characterId: 'star-singer', generation: status.generation, result: 'READY' } satisfies PetVisualReady;
const command = {
  type: 'PET_INTERACT', commandId: 'command-42', issuedAt: 1234,
  payload: { petId: 'pet-1', interaction: 'PET' },
} satisfies DomainCommand;
const galleryQuery = { filter: 'UNLOCKED', petId: 'pet-1', offset: 20, limit: 10 } satisfies GalleryQuery;

function gallerySuccess(requestId: string, query: GalleryQuery = galleryQuery) {
  return {
    schemaVersion: 1, ok: true, requestId, snapshot,
    gallery: { revision: snapshot.revision, total: 0, rows: [], offset: query.offset, limit: query.limit },
  } satisfies GalleryIpcResult;
}

const characterRow = {
  characterId: 'nova-mechanist', displayName: '诺瓦', species: '机械少女', profession: 'MECHANICAL_SUPPORT', professionLabel: '机械师',
  background: '来自失落工坊的机械助手。',
  personality: { summary: '认真而好奇', traits: ['认真'], likes: ['齿轮'], speechStyle: '短句' },
  voiceStyleId: 'voice-nova', adventureFocus: ['采集'], basePower: 20,
  baseStats: { hp: 100, atk: 10, def: 10, spd: 5, luk: 1 }, growthPerLevel: { hp: 5, atk: 1, def: 1, spd: 1, luk: 0 },
  unlock: { kind: 'EXPLORATION_COINS', requiredSettledTrips: 1, coinCost: 2 },
  instances: [], availability: 'AVAILABLE',
} satisfies CharacterCatalogRow;

function charactersSuccess(requestId: string) {
  return {
    schemaVersion: 1, ok: true, requestId, snapshot,
    characters: { revision: snapshot.revision, catalogVersion: 1, settledTrips: 1, walletCoins: snapshot.walletCoins, rows: [characterRow] },
  } satisfies CharactersIpcResult;
}

function inventorySuccess(requestId: string) {
  return { schemaVersion: 1, ok: true, requestId, snapshot,
    inventory: { revision: snapshot.revision, walletCoins: snapshot.walletCoins, catalogVersion: 1, legacyStackOffset: 0, legacyStackTotal: 0,
      definitions: [], stacks: [], instances: [], offers: [], pets: [] } } satisfies InventoryIpcResult;
}

const privateDetail = '/Users/test/private.sqlite: database error';

class FakeIpc implements DesktopIpcPort {
  readonly listeners = new Map<PushChannel, Set<PushListener>>();
  readonly calls: Array<[InvokeChannel, ...unknown[]]> = [];
  handle: (channel: InvokeChannel, ...args: unknown[]) => unknown = (channel, raw) => {
    if (channel === DESKTOP_IPC.request) {
      const request = ipcRequestSchema.parse(raw);
      if (request.method === 'gallery/list') return gallerySuccess(request.requestId, request.payload);
      if (request.method === 'characters/list') return charactersSuccess(request.requestId);
      if (request.method === 'inventory/list') return inventorySuccess(request.requestId);
      return { schemaVersion: 1, ok: true, requestId: request.requestId, snapshot } satisfies IpcResult;
    }
    if (channel === DESKTOP_IPC.getStatus) return status;
    return { ok: true };
  };

  async invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    this.calls.push([channel, ...args]);
    return this.handle(channel, ...args);
  }

  on(channel: PushChannel, listener: PushListener): void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)?.add(listener);
  }

  removeListener(channel: PushChannel, listener: PushListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: PushChannel, ...args: unknown[]): void {
    // This object must never be passed to the renderer callback.
    const event = { sender: this, privateData: privateDetail };
    for (const listener of Array.from(this.listeners.get(channel) ?? [])) listener(event, ...args);
  }
}

function requestIds(): () => string {
  let count = 0;
  return () => `request-${++count}`;
}

describe('role-specific preload bridges', () => {
  it('only exposes the closed public API for each role', () => {
    const ipc = new FakeIpc();
    const commonKeys = [
      'role', 'getSnapshot', 'dispatch', 'subscribeSnapshot', 'getServiceStatus',
      'subscribeServiceStatus', 'openControlCenter',
    ];
    const pet = createPetBridge(ipc);
    const center = createControlCenterBridge(ipc);
    expect(Object.keys(pet).sort()).toEqual([...commonKeys, 'setInteractive', 'dragPetWindow', 'changePetScale', 'reportVisualReady','subscribeVoiceMouth','subscribeHostRenderPreferences','subscribeProactiveBubble',
      'readCharacterPack', 'subscribeCharacterPackChanged'].sort());
    expect(Object.keys(center).sort()).toEqual([...commonKeys, 'listGallery', 'listCharacters', 'listInventory', 'listActiveTravel', 'listTravelCatalog', 'previewTravel', 'listTravelReports', 'listEvents',
      'getHostSettings','setHostShortcutEnabled','getHostShortcutBindings','saveHostShortcutBindings','setLoginStart','getHostPreferences','saveHostPreferences','exportBackup','exportDiagnostics','restoreBackup','getRestoreBackupStatus','getPeriodicBackupStatus',
      'aiRequest','subscribeChatEvents','saveProviderCredential','revokeProviderCredential','voiceRequest','voiceSettingsRequest','workspaceRequest','authorizeMicrophone','requestMic','revokeMic','cancelVoiceChat','publishMouth','subscribeSuspend',
      'proactiveRequest','subscribeProactiveNotices','listCharacterPacks','importCharacterPack','activateCharacterPack'].sort());
    expect('reportVisualReady' in center).toBe(false);
    expect('listGallery' in pet).toBe(false);
    expect('listCharacters' in pet).toBe(false);
    expect('listInventory' in pet).toBe(false);
    expect('listTravelCatalog' in pet).toBe(false);
    expect('previewTravel' in pet).toBe(false);
    expect('listTravelReports' in pet).toBe(false);
    expect('listEvents' in pet).toBe(false);
    expect('aiRequest' in pet).toBe(false);
    expect('saveProviderCredential' in pet).toBe(false);
    expect('requestMic' in pet).toBe(false);
    expect('voiceRequest' in pet).toBe(false);
    expect('subscribeVoiceMouth' in center).toBe(false);
    expect(pet.role).toBe('pet');
    expect(center.role).toBe('control-center');
    expect(Object.isFrozen(pet)).toBe(true);
    expect(Object.isFrozen(center)).toBe(true);
  });

  it('sends only a pathless backup request and strips unexpected path replies', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const spy = vi.spyOn(ipc, 'invoke').mockResolvedValue({ ok: true, schemaVersion: 11, path: '/private/save.sqlite3' });
    expect(await bridge.exportBackup()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(spy).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.hostRequest, { kind: 'backup' });
    expect(await bridge.saveHostPreferences({ scalePercent: 101, reducedMotion: true, expectedRevision: 0 } as never))
      .toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('allows only pet gesture phases and does not forward caller-controlled coordinates', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const center = createControlCenterBridge(ipc);
    const request = { phase: 'begin', gestureId: '3065c68a-860d-4359-a8cf-c3dd57ee9221' } as const;
    expect('dragPetWindow' in center).toBe(false);
    expect(await pet.dragPetWindow({ ...request, x: 100 } as never)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.dragPetWindow({ ...request, gestureId: 'other' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.dragPetWindow({ ...request, phase: 'position' } as never)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(ipc.calls).toEqual([]);
    expect(await pet.dragPetWindow(request)).toEqual({ ok: true });
    expect(ipc.calls).toEqual([[DESKTOP_IPC.petDrag, request]]);
  });

  it('exports diagnostics without sharing paths or records with either renderer', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const invoke = vi.spyOn(ipc, 'invoke').mockResolvedValueOnce({ ok: true, entries: 7, path: '/private/log.json' })
      .mockResolvedValueOnce({ ok: true, entries: 7 });
    expect('exportDiagnostics' in createPetBridge(ipc)).toBe(false);
    const invalidCall = bridge.exportDiagnostics as (...args: unknown[]) => ReturnType<typeof bridge.exportDiagnostics>;
    expect(await invalidCall('/private/misuse.json')).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(invoke).not.toHaveBeenCalled();
    expect(await bridge.exportDiagnostics()).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await bridge.exportDiagnostics()).toEqual({ ok: true, entries: 7 });
    expect(invoke.mock.calls).toEqual([[DESKTOP_IPC.exportDiagnostics], [DESKTOP_IPC.exportDiagnostics]]);
  });

  it('limits editable combinations to the approved actions and rejects destination or command-shaped payloads', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const preferences = { revision: 0, bindings: defaultHostShortcutBindings };
    const invoke = vi.spyOn(ipc, 'invoke').mockResolvedValue({ ok: true, preferences });
    expect('getHostShortcutBindings' in createPetBridge(ipc)).toBe(false);
    expect(await bridge.getHostShortcutBindings()).toEqual({ ok: true, preferences });
    expect(await bridge.saveHostShortcutBindings({ expectedRevision: 0, bindings: { ...defaultHostShortcutBindings, OPEN_CONTROL_CENTER: 'Ctrl+C' } }))
      .toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await bridge.saveHostShortcutBindings({ expectedRevision: 0, bindings: defaultHostShortcutBindings })).toEqual({ ok: true, preferences });
    expect(invoke.mock.calls).toEqual([
      [DESKTOP_IPC.hostRequest, { kind: 'shortcut-bindings' }],
      [DESKTOP_IPC.hostRequest, { kind: 'save-shortcut-bindings', edit: { expectedRevision: 0, bindings: defaultHostShortcutBindings } }],
    ]);
  });

  it('uses pathless restore requests and rejects restore statuses containing host details', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const invoke = vi.spyOn(ipc, 'invoke').mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 'RESTORED', path: '/private/source.sqlite3' });
    expect(await bridge.restoreBackup()).toEqual({ ok: true });
    expect(await bridge.getRestoreBackupStatus()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(invoke.mock.calls).toEqual([
      [DESKTOP_IPC.hostRequest, { kind: 'restore-backup' }], [DESKTOP_IPC.hostRequest, { kind: 'restore-status' }],
    ]);
    expect('restoreBackup' in createPetBridge(ipc)).toBe(false);
  });

  it('reads periodic backup status without exposing paths or permitting the pet bridge to query it', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const valid = { ok: true, status: 'AVAILABLE', lastCompletedAt: '2026-11-25T12:00:00.000Z' };
    const invoke = vi.spyOn(ipc, 'invoke').mockResolvedValueOnce(valid).mockResolvedValueOnce({ ...valid, path: '/private/automatic.sqlite3' });
    expect(await bridge.getPeriodicBackupStatus()).toEqual(valid);
    expect(await bridge.getPeriodicBackupStatus()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(invoke).toHaveBeenNthCalledWith(1, DESKTOP_IPC.hostRequest, { kind: 'periodic-backup-status' });
    expect('getPeriodicBackupStatus' in createPetBridge(ipc)).toBe(false);
  });

  it('exposes a closed inventory query only to the control center and rejects unrelated replies', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    expect(await bridge.listInventory()).toEqual(inventorySuccess('request-1'));
    expect(ipc.calls).toEqual([[DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'inventory/list', payload: {} }]]);
    const list = bridge.listInventory as (...args: unknown[]) => Promise<InventoryIpcResult>;
    expect(await list({ petId: 'other' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(ipc.calls).toHaveLength(1);
    ipc.handle = () => charactersSuccess('request-3');
    expect(await bridge.listInventory()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    ipc.handle = () => ({ ...inventorySuccess('request-4'), inventory: { ...inventorySuccess('request-4').inventory, walletCoins: 999 } });
    expect(await bridge.listInventory()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    ipc.handle = () => inventorySuccess('request-5');
    expect(await bridge.getSnapshot()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    ipc.handle = () => ({ ...inventorySuccess('request-6'), inventory: { ...inventorySuccess('request-6').inventory, legacyStackOffset: 128 } });
    expect(await bridge.listInventory(128)).toMatchObject({ ok: true, inventory: { legacyStackOffset: 128 } });
    ipc.handle = () => inventorySuccess('request-7');
    expect(await bridge.listInventory(128)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('correlates travel catalog, preview and paged history to their exact methods and payloads', async () => {
    const ipc = new FakeIpc(); const bridge = createControlCenterBridge(ipc, requestIds());
    const route = { routeId: 'meadow', contentVersion: 1, title: '草原', description: '测试', risk: 'LOW', minLevel: 1,
      recommendedMaxLevel: 5, energyCost10: 150, durationMs: 100, requiredSupplies: [], rewardItemIds: [], cgIds: [] };
    ipc.handle = () => ({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot,
      travelCatalog: { revision: snapshot.revision, routeCatalogVersion: 1, routes: [route], supplyStock: [] } });
    expect(await bridge.listTravelCatalog()).toMatchObject({ ok: true, travelCatalog: { routeCatalogVersion: 1 } });
    expect(await bridge.previewTravel({ petId: 'pet-1', routeId: 'meadow', routeCatalogVersion: 1, selectedSupplies: [] })).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    ipc.handle = () => ({ schemaVersion: 1, ok: true, requestId: 'request-3', snapshot,
      travelReports: { revision: snapshot.revision, petId: null, offset: 12, limit: 10, total: 0, rows: [] } });
    expect(await bridge.listTravelReports({ offset: 12, limit: 10 })).toMatchObject({ ok: true, travelReports: { offset: 12 } });
    ipc.handle = () => ({ schemaVersion: 1, ok: true, requestId: 'request-4', snapshot,
      travelReports: { revision: snapshot.revision, petId: null, offset: 12, limit: 10, total: 0, rows: [] } });
    expect(await bridge.listTravelReports({ offset: 0, limit: 10 })).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(await bridge.listTravelReports({ offset: 0, limit: 21 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('correlates event history view and only accepts exact page/filter results', async () => {
    const ipc=new FakeIpc(); const bridge=createControlCenterBridge(ipc,requestIds());
    const query={filter:'PENDING' as const,offset:0,limit:10};
    const result={schemaVersion:1,ok:true,requestId:'request-1',snapshot,events:{revision:snapshot.revision,petId:null,filter:'PENDING',offset:0,limit:10,total:0,pendingTotal:0,rows:[]}};
    ipc.handle=()=>result;
    expect(await bridge.listEvents(query)).toMatchObject({ok:true,events:{pendingTotal:0}});
    ipc.handle=()=>({...result,requestId:'request-2',events:{...result.events,filter:'ALL'}});
    expect(await bridge.listEvents(query)).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR'}});
    expect(await bridge.listEvents({...query,limit:31})).toMatchObject({ok:false,error:{code:'INVALID_REQUEST'}});
  });

  it('validates, wraps and correlates requests without changing the command ID', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc, requestIds());
    const request: IpcRequest = { schemaVersion: 1, requestId: 'request-1', method: 'snapshot/get', payload: {} };
    expect(await bridge.getSnapshot()).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.dispatch(command)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-2', snapshot });
    expect(await bridge.dispatch(command)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-3', snapshot });
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, request],
      [DESKTOP_IPC.request, { ...request, requestId: 'request-2', method: 'command/dispatch', payload: { command } }],
      [DESKTOP_IPC.request, { ...request, requestId: 'request-3', method: 'command/dispatch', payload: { command } }],
    ]);
  });

  it('generates distinct schema-valid request IDs by default', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const a = ipcResultSchema.parse(await bridge.getSnapshot());
    const b = ipcResultSchema.parse(await bridge.getSnapshot());
    expect(a.ok && b.ok && a.requestId !== b.requestId).toBe(true);
  });

  it.each([
    null, { ...command, type: 'shell/execute' }, { ...command, channel: 'debug' },
    { ...command, payload: { ...command.payload, secret: privateDetail } },
    { ...command, payload: { petId: 123, interaction: 'PET' } },
  ])('rejects malformed commands before transport: case %#', async (input) => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const result = await bridge.dispatch(input as DomainCommand);
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: {
      requestId: 'request-1', code: 'INVALID_REQUEST', retryable: false,
    } });
    expect(ipcResultSchema.safeParse(result).success).toBe(true);
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('only invokes the fixed host actions and rejects non-boolean interactive input', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const center = createControlCenterBridge(ipc);
    expect(await pet.setInteractive(true)).toEqual({ ok: true });
    expect(await pet.setInteractive(false)).toEqual({ ok: true });
    expect(await pet.setInteractive('true' as unknown as boolean)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.setInteractive({ channel: 'debug' } as unknown as boolean)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.openControlCenter()).toEqual({ ok: true });
    expect(await center.openControlCenter()).toEqual({ ok: true });
    expect(await center.getServiceStatus()).toEqual(status);
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.petInteractive, true], [DESKTOP_IPC.petInteractive, false],
      [DESKTOP_IPC.openControlCenter], [DESKTOP_IPC.openControlCenter], [DESKTOP_IPC.getStatus],
    ]);
  });

  it('reports ready/fallback only through the pet-specific visual channel', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const fallback = { ...ready, generation: 4, result: 'FALLBACK' } satisfies PetVisualReady;
    expect(await pet.reportVisualReady(ready)).toEqual({ ok: true });
    expect(await pet.reportVisualReady(fallback)).toEqual({ ok: true });
    expect(ipc.calls).toEqual([[DESKTOP_IPC.petVisualReady, ready], [DESKTOP_IPC.petVisualReady, fallback]]);
  });

  it('exposes a pet-only zoom step and projects only supported host scales', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const changeScale = pet.changePetScale as (...args: unknown[]) => ReturnType<typeof pet.changePetScale>;
    expect(await changeScale('increase')).toEqual({ ok: true });
    expect(await changeScale('decrease')).toEqual({ ok: true });
    expect(await changeScale('increase', 200)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await changeScale(125)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(ipc.calls).toEqual([[DESKTOP_IPC.changePetScale, 'increase'], [DESKTOP_IPC.changePetScale, 'decrease']]);

    const listener = vi.fn();
    const unsubscribe = pet.subscribeHostRenderPreferences(listener);
    ipc.emit(DESKTOP_IPC.hostRenderPreferences, { reducedMotion: true, scalePercent: 125 });
    ipc.emit(DESKTOP_IPC.hostRenderPreferences, { reducedMotion: true, scalePercent: 999 });
    ipc.emit(DESKTOP_IPC.hostRenderPreferences, { reducedMotion: true });
    ipc.emit(DESKTOP_IPC.hostRenderPreferences, { reducedMotion: true, scalePercent: 150, hotkeysEnabled: true });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ reducedMotion: true, scalePercent: 125 });
    unsubscribe();
    ipc.emit(DESKTOP_IPC.hostRenderPreferences, { reducedMotion: true, scalePercent: 75 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, undefined, '', [], {}, { ...ready, characterId: '' },
    { ...ready, characterId: '../private' },
    { ...ready, characterId: 'x'.repeat(129) },
    { ...ready, generation: -1 }, { ...ready, generation: 1.1 },
    { ...ready, generation: '3' }, { ...ready, generation: Infinity },
    { ...ready, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...ready, result: 'FAILED' }, { ...ready, result: true },
    { ...ready, petId: 'another-pet' }, { ...ready, path: privateDetail },
    { ...ready, data: privateDetail }, { ...ready, channel: 'debug' },
    Object.defineProperty({}, 'characterId', { enumerable: true, get() { throw new Error(privateDetail); } }),
  ])('rejects malformed visual reports before invoking IPC: case %#', async (input) => {
    const ipc = new FakeIpc();
    const result = await createPetBridge(ipc).reportVisualReady(input as PetVisualReady);
    expect(result).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });
});

describe('control-center-only character catalog', () => {
  it('sends an exact empty request through the fixed channel and shares reply ID sequencing across methods', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    expect(await bridge.getSnapshot()).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.listCharacters()).toEqual(charactersSuccess('request-2'));
    expect(await bridge.listGallery(galleryQuery)).toEqual(gallerySuccess('request-3'));
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'snapshot/get', payload: {} }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'characters/list', payload: {} }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-3', method: 'gallery/list', payload: galleryQuery }],
    ]);
  });

  it('rejects any runtime input, even an empty object or explicit undefined, without invoking IPC', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const invoke = bridge.listCharacters as (...args: unknown[]) => Promise<CharactersIpcResult>;
    for (const args of [[{}], [undefined], [null], ['characters/list'], [{ path: privateDetail }], [{}, {}]]) {
      const result = await invoke(...args);
      expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: { code: 'INVALID_REQUEST', retryable: false } });
      expect(charactersIpcResultSchema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(privateDetail);
    }
    expect(ipc.calls).toEqual([]);
    expect(await bridge.listCharacters()).toEqual(charactersSuccess('request-7'));
  });

  it('allows acquire and rename requests through the existing command method, not the catalog query', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const acquire: DomainCommand = { type: 'PET_ACQUIRE', commandId: 'acquire-1', issuedAt: 1234,
      payload: { characterId: 'nova-mechanist', catalogVersion: 1 } };
    const rename: DomainCommand = { type: 'PET_RENAME', commandId: 'rename-1', issuedAt: 1234,
      payload: { petId: 'pet-1', nickname: '星光' } };
    expect(await bridge.dispatch(acquire)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.dispatch(rename)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-2', snapshot });
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'command/dispatch', payload: { command: acquire } }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'command/dispatch', payload: { command: rename } }],
    ]);
  });

  it('rejects globally schema-valid character replies through snapshot/dispatch/gallery despite an equal request ID', async () => {
    for (const role of ['pet', 'control-center'] as const) {
      const ipc = new FakeIpc();
      const bridge = role === 'pet' ? createPetBridge(ipc, requestIds()) : createControlCenterBridge(ipc, requestIds());
      ipc.handle = (_channel, raw) => {
        const reply = charactersSuccess(ipcRequestSchema.parse(raw).requestId);
        expect(ipcResultSchema.safeParse(reply).success).toBe(true);
        return reply;
      };
      expect(await bridge.getSnapshot()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', requestId: 'request-1' } });
      expect(await bridge.dispatch(command)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', requestId: 'request-2' } });
      if (bridge.role === 'control-center') {
        expect(await bridge.listGallery(galleryQuery)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', requestId: 'request-3' } });
      }
    }
  });

  it.each([
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot },
    gallerySuccess('request-1'),
    charactersSuccess('wrong-id'),
    { ...charactersSuccess('request-1'), gallery: gallerySuccess('request-1').gallery },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, revision: snapshot.revision + 1 } },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, walletCoins: snapshot.walletCoins + 1 } },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, catalogVersion: 0 } },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, settledTrips: -1 } },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, path: privateDetail } },
    { ...charactersSuccess('request-1'), characters: { ...charactersSuccess('request-1').characters, rows: [characterRow, characterRow] } },
  ])('rejects invalid character catalog success replies: case %#', async reply => {
    const ipc = new FakeIpc();
    ipc.handle = () => reply;
    const result = await createControlCenterBridge(ipc, requestIds()).listCharacters();
    expect(result).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'INTERNAL_ERROR', retryable: true } });
    expect(charactersIpcResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('sanitizes character catalog IPC rejects and legitimate errors, including mismatched IDs', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    ipc.handle = () => ({ schemaVersion: 1, ok: false, error: {
      requestId: 'request-1', code: 'NOT_FOUND', retryable: false, message: privateDetail,
    } });
    const first = await bridge.listCharacters();
    expect(first).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'NOT_FOUND', retryable: false } });
    expect(JSON.stringify(first)).not.toContain(privateDetail);
    expect(await bridge.listCharacters()).toMatchObject({ ok: false, error: { requestId: 'request-2', code: 'INTERNAL_ERROR', retryable: true } });
    ipc.handle = () => { throw new Error(privateDetail); };
    const rejected = await bridge.listCharacters();
    expect(rejected).toMatchObject({ ok: false, error: { requestId: 'request-3', code: 'SERVICE_UNAVAILABLE', retryable: true } });
    expect(JSON.stringify(rejected)).not.toContain(privateDetail);
  });
});

describe('control-center-only gallery requests', () => {
  it('validates the closed query and returns its authority-coherent page on the existing correlated request channel', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const snapshotReply = await bridge.getSnapshot();
    const reply = await bridge.listGallery(galleryQuery);
    expect(snapshotReply).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(reply).toEqual(gallerySuccess('request-2'));
    expect(galleryIpcResultSchema.safeParse(reply).success).toBe(true);
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'snapshot/get', payload: {} }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'gallery/list', payload: galleryQuery }],
    ]);
  });

  it.each([
    undefined, null, '', [], {}, { ...galleryQuery, filter: 'UNKNOWN' }, { ...galleryQuery, rarity: 'UNKNOWN' },
    { ...galleryQuery, petId: '../private' }, { ...galleryQuery, characterId: 123 },
    { ...galleryQuery, offset: -1 }, { ...galleryQuery, offset: 10_001 }, { ...galleryQuery, offset: 1.1 },
    { ...galleryQuery, limit: 0 }, { ...galleryQuery, limit: 51 }, { ...galleryQuery, limit: '10' },
    { ...galleryQuery, path: privateDetail }, { ...galleryQuery, method: 'snapshot/get' },
  ])('rejects invalid gallery arguments before IPC: case %#', async (input) => {
    const ipc = new FakeIpc();
    const result = await createControlCenterBridge(ipc, requestIds()).listGallery(input as GalleryQuery);
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: { code: 'INVALID_REQUEST', requestId: 'request-1', retryable: false } });
    expect(galleryIpcResultSchema.safeParse(result).success).toBe(true);
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('allows closed gallery preference commands through the ordinary command method without returning gallery data', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const favorite: DomainCommand = {
      type: 'CG_SET_FAVORITE', commandId: 'favorite-1', issuedAt: 1234,
      payload: { petId: 'pet-1', cgId: 'cg-1', variant: 'default', favorite: true },
    };
    const viewed: DomainCommand = {
      type: 'CG_MARK_VIEWED', commandId: 'viewed-1', issuedAt: 1234,
      payload: { petId: 'pet-1', cgId: 'cg-1', variant: 'default', characterId: 'star-singer',
        eventDefId: 'def-1', assetVersion: '1.0.0', assetHash: 'a'.repeat(64) },
    };
    expect(await bridge.dispatch(favorite)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.dispatch(viewed)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-2', snapshot });
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'command/dispatch', payload: { command: favorite } }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'command/dispatch', payload: { command: viewed } }],
    ]);
  });

  it('rejects gallery success replies through ordinary snapshot and dispatch methods even with a valid request ID', async () => {
    for (const role of ['pet', 'control-center'] as const) {
      const ipc = new FakeIpc();
      const bridge = role === 'pet' ? createPetBridge(ipc, requestIds()) : createControlCenterBridge(ipc, requestIds());
      ipc.handle = (_channel, raw) => {
        const reply = gallerySuccess(ipcRequestSchema.parse(raw).requestId);
        expect(ipcResultSchema.safeParse(reply).success).toBe(true);
        return reply;
      };
      expect(await bridge.getSnapshot()).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'INTERNAL_ERROR' } });
      expect(await bridge.dispatch(command)).toMatchObject({ ok: false, error: { requestId: 'request-2', code: 'INTERNAL_ERROR' } });
    }
  });

  it.each([
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot }, // snapshot-only success
    gallerySuccess('other-id'),
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, revision: snapshot.revision + 1 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, offset: 0 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, limit: 50 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, path: privateDetail } },
  ])('rejects invalid or mismatched gallery replies: case %#', async (reply) => {
    const ipc = new FakeIpc();
    ipc.handle = () => reply;
    const result = await createControlCenterBridge(ipc, requestIds()).listGallery(galleryQuery);
    expect(result).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'INTERNAL_ERROR', retryable: true } });
    expect(galleryIpcResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('sanitizes gallery transport failures and correlates legitimate errors', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    ipc.handle = () => ({ schemaVersion: 1, ok: false, error: {
      requestId: 'request-1', code: 'NOT_FOUND', retryable: false, message: privateDetail,
    } });
    const first = await bridge.listGallery(galleryQuery);
    expect(first).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'NOT_FOUND', retryable: false } });
    expect(JSON.stringify(first)).not.toContain(privateDetail);
    const mismatched = await bridge.listGallery(galleryQuery);
    expect(mismatched).toMatchObject({ ok: false, error: { requestId: 'request-2', code: 'INTERNAL_ERROR', retryable: true } });
    expect(JSON.stringify(mismatched)).not.toContain(privateDetail);
    ipc.handle = () => { throw new Error(privateDetail); };
    const rejected = await bridge.listGallery(galleryQuery);
    expect(rejected).toMatchObject({ ok: false, error: { requestId: 'request-3', code: 'SERVICE_UNAVAILABLE', retryable: true } });
    expect(JSON.stringify(rejected)).not.toContain(privateDetail);
  });
});

describe('runtime response validation and error isolation', () => {
  it.each([
    null, { schemaVersion: 2, ok: true, requestId: 'request-1', snapshot },
    { schemaVersion: 1, ok: true, requestId: 'different-id', snapshot },
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot: { ...snapshot, secret: privateDetail } },
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot: { ...snapshot, walletCoins: -1 } },
    { schemaVersion: 1, ok: false, error: { code: 'FORBIDDEN', message: privateDetail, retryable: false, requestId: 'other-id' } },
  ])('rejects invalid or mismatched responses: case %#', async (response) => {
    const ipc = new FakeIpc();
    ipc.handle = () => response;
    const result = await createPetBridge(ipc, requestIds()).getSnapshot();
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: {
      code: 'INTERNAL_ERROR', requestId: 'request-1', retryable: true,
    } });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('preserves legitimate codes but not free-text IPC error details', async () => {
    const ipc = new FakeIpc();
    ipc.handle = () => ({ schemaVersion: 1, ok: false, error: {
      code: 'FORBIDDEN', message: privateDetail, retryable: false, requestId: 'request-1',
    } });
    const response = await createPetBridge(ipc, requestIds()).dispatch(command);
    expect(response).toMatchObject({ schemaVersion: 1, ok: false, error: {
      code: 'FORBIDDEN', retryable: false, requestId: 'request-1',
    } });
    expect(JSON.stringify(response)).not.toContain(privateDetail);
  });

  it('never forwards rejected invoke exceptions, invalid host responses or invalid status', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc, requestIds());
    ipc.handle = () => ({ ok: true, message: privateDetail });
    expect(await bridge.openControlCenter()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 0 });
    ipc.handle = () => ({ ok: false, code: 'FORBIDDEN' });
    expect(await bridge.setInteractive(false)).toEqual({ ok: false, code: 'FORBIDDEN' });
    ipc.handle = () => { throw new Error(privateDetail); };
    const result = await bridge.getSnapshot();
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', requestId: 'request-1', retryable: true } });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(await bridge.openControlCenter()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 0 });
  });

  it('sanitizes visual readiness reply errors without leaking host details', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc);
    ipc.handle = () => ({ ok: false, code: 'FORBIDDEN' });
    expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'FORBIDDEN' });
    for (const reply of [null, { ok: true, path: privateDetail }, { ok: false, code: 'FORBIDDEN', message: privateDetail },
      { ok: false, code: privateDetail }]) {
      ipc.handle = () => reply;
      expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    }
    ipc.handle = () => { throw new Error(privateDetail); };
    expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('subscriptions', () => {
  it('does not leak IPC events, rejects malformed payloads and unsubscribes duplicate listeners independently', () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc);
    const listener = vi.fn();
    const unsubscribeFirst = bridge.subscribeSnapshot(listener);
    const unsubscribeSecond = bridge.subscribeSnapshot(listener);
    const captured = Array.from(ipc.listeners.get(DESKTOP_IPC.snapshot) ?? []);
    expect(captured).toHaveLength(2);
    for (const payload of [null, { ...snapshot, secret: privateDetail }, { ...snapshot, revision: -1 }]) {
      ipc.emit(DESKTOP_IPC.snapshot, payload);
    }
    ipc.emit(DESKTOP_IPC.snapshot, snapshot, privateDetail);
    expect(listener).not.toHaveBeenCalled();
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(listener.mock.calls).toEqual([[snapshot], [snapshot]]);
    unsubscribeFirst();
    unsubscribeFirst();
    captured[0]?.({}, snapshot); // even a late callback captured before removal is inactive
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(listener.mock.calls).toEqual([[snapshot], [snapshot], [snapshot]]);
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(1);
    unsubscribeSecond();
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('only delivers validated status DTOs and retains the latest known generation on failure', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const listener = vi.fn();
    const dispose = bridge.subscribeServiceStatus(listener);
    expect(await bridge.getServiceStatus()).toEqual(status);
    ipc.emit(DESKTOP_IPC.status, { ...status, stage: 'INVALID' });
    ipc.emit(DESKTOP_IPC.status, { ...status, generation: -1 });
    ipc.emit(DESKTOP_IPC.status, { ...status, secret: privateDetail });
    expect(listener).not.toHaveBeenCalled();
    const next = { stage: 'RESTARTING', generation: 4 } satisfies ServiceStatus;
    ipc.emit(DESKTOP_IPC.status, next);
    expect(listener.mock.calls).toEqual([[next]]);
    ipc.handle = () => { throw new Error(privateDetail); };
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 4 });
    dispose();
    dispose();
    ipc.emit(DESKTOP_IPC.status, status);
    expect(ipc.listeners.get(DESKTOP_IPC.status)?.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects a nonfunction subscriber and isolates a throwing subscriber from other listeners', () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const invalid = 'not a callback' as unknown as () => void;
    expect(() => bridge.subscribeSnapshot(invalid)).toThrow('A listener function is required.');
    expect(() => bridge.subscribeServiceStatus(invalid)).toThrow('A listener function is required.');
    expect(ipc.listeners.size).toBe(0);

    const second = vi.fn();
    const firstDispose = bridge.subscribeSnapshot(() => { throw new Error(privateDetail); });
    const secondDispose = bridge.subscribeSnapshot(second);
    expect(() => ipc.emit(DESKTOP_IPC.snapshot, snapshot)).not.toThrow();
    expect(second.mock.calls).toEqual([[snapshot]]);
    firstDispose();
    secondDispose();
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(0);
  });
});
