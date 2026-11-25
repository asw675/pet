/// <reference path="../src/renderer/env.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { computed, createRenderer, nextTick, ref } from 'vue';
import type { AppSnapshot, EventsIpcResult } from '@pet-desktop/contracts';
import { appSnapshotSchema, eventsIpcResultSchema } from '@pet-desktop/contracts';
import type { EventListQuery, EventPage } from '@pet-desktop/contracts/events';
import { useEventProjection } from '../src/renderer/control-center/useEventProjection';
import { useAppStore } from '../src/renderer/shared/store';

type Host = { parent: Host | null; children: Host[]; text: string };
function node(text = ''): Host { return { parent: null, children: [], text }; }
// No browser, DOM, Electron or mocked Vue lifecycle. Mount using the real
// renderer's inert host + real Pinia, with only the projected IPC boundary stubbed.
const renderer = createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: node, createComment: node,
  insert(child, parent) { child.parent = parent; parent.children.push(child); },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(it => it !== child); child.parent = null; },
  setText(child, text) { child.text = text; }, setElementText(child, text) { child.text = text; },
  parentNode: child => child.parent, nextSibling: () => null, patchProp: () => {},
});
const source = (revision: number, walletCoins = 10): AppSnapshot => appSnapshotSchema.parse({
  revision, walletCoins, primaryPetId: null, pets: [], pausedRender: false, doNotDisturb: false,
});
const defaultQuery: EventListQuery = { filter: 'PENDING', offset: 0, limit: 8 };
function result(query: EventListQuery, snapshot: AppSnapshot, edit: Partial<EventPage> = {}): EventsIpcResult {
  return eventsIpcResultSchema.parse({ schemaVersion: 1, ok: true, requestId: 'event-query', snapshot,
    events: { ...query, petId: query.petId ?? null, revision: snapshot.revision, pendingTotal: 0, total: 0, rows: [], ...edit } });
}
function deferred<T>() {
  let finish!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function tick() { await nextTick(); await Promise.resolve(); await nextTick(); }

function harness(debounceMs = 0) {
  const requests: Array<{ query: EventListQuery; finish: (value: EventsIpcResult) => void; fail: (error: unknown) => void }> = [];
  const listEvents = vi.fn((query: EventListQuery) => {
    const { promise, finish, fail } = deferred<EventsIpcResult>();
    requests.push({ query, finish, fail });
    return promise;
  });
  vi.stubGlobal('window', { petDesktop: { role: 'control-center', listEvents } });
  const pinia = createPinia();
  const store = useAppStore(pinia);
  store.serviceStatus = { stage: 'READY', generation: 1 };
  store.snapshot = source(4);
  store.liveSnapshot = true;
  const queryData = ref<EventListQuery>({ ...defaultQuery });
  const reset = vi.fn(() => { queryData.value = { ...defaultQuery }; });
  const resetOffset = vi.fn((offset: number) => { queryData.value = { ...queryData.value, offset }; });
  let projection!: ReturnType<typeof useEventProjection>;
  const app = renderer.createApp({ setup() {
    projection = useEventProjection(computed(() => queryData.value), resetOffset, reset, { debounceMs });
    return () => null;
  } });
  app.use(pinia); app.mount(node());
  let unmounted = false;
  const unmount = () => { if (!unmounted) app.unmount(); unmounted = true; };
  cleanups.push(unmount);
  return { store, queryData, requests, listEvents, projection, reset, resetOffset, unmount };
}

describe('real event projection lifecycle', () => {
  it('makes one scoped query on mount and accepts only a same-revision result', async () => {
    const h = harness();
    expect(h.projection.pending.value).toBe(true);
    expect(h.requests.map(item => item.query)).toEqual([defaultQuery]);
    h.requests[0]!.finish(result(defaultQuery, source(4)));
    await tick();
    expect(h.projection.page.value?.revision).toBe(4);
    expect(h.projection.allowCommands.value).toBe(true);
    expect(h.projection.pending.value).toBe(false);
  });
  it('drops a late pending-page reply after filter changes, even if it returns a coherent old snapshot', async () => {
    const h = harness();
    const history: EventListQuery = { ...defaultQuery, filter: 'HISTORY' };
    h.queryData.value = history;
    await tick();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.finish(result(history, source(4)));
    await tick();
    h.requests[0]!.finish(result(defaultQuery, source(4)));
    await tick();
    expect(h.projection.page.value?.filter).toBe('HISTORY');
    expect(h.projection.queryError.value).toBeNull();
  });
  it('drops an old promise across service restart, including a higher old revision', async () => {
    const h = harness();
    h.queryData.value = { ...defaultQuery, petId: 'old-pet' };
    await tick();
    h.store.liveSnapshot = false;
    h.store.serviceStatus = { stage: 'RESTARTING', generation: 2 };
    await tick();
    expect(h.projection.page.value).toBeNull();
    expect(h.projection.pending.value).toBe(false);
    expect(h.queryData.value).toEqual(defaultQuery);
    h.store.snapshot = source(1);
    h.store.serviceStatus = { stage: 'READY', generation: 2 };
    h.store.liveSnapshot = true;
    await tick();
    expect(h.requests.at(-1)?.query).toEqual(defaultQuery);
    h.requests.at(-1)!.finish(result(defaultQuery, source(1)));
    await tick();
    h.requests[0]!.finish(result(defaultQuery, source(999)));
    await tick();
    expect(h.projection.page.value?.revision).toBe(1);
    expect(h.projection.stamp.value?.generation).toBe(2);
  });
  it('invalidates an actionable page immediately when a newer business revision arrives', async () => {
    const h = harness();
    h.requests[0]!.finish(result(defaultQuery, source(4)));
    await tick();
    expect(h.projection.allowCommands.value).toBe(true);
    h.store.snapshot = source(5);
    expect(h.projection.page.value).toBeNull();
    expect(h.projection.allowCommands.value).toBe(false);
    await tick();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.finish(result(defaultQuery, source(5)));
    await tick();
    expect(h.projection.page.value?.revision).toBe(5);
  });
  it('cannot adopt an ahead supplementary page as the main business state; waits for an actual main refresh', async () => {
    const h = harness();
    const refresh = deferred<void>();
    const refreshSpy = vi.spyOn(h.store, 'refresh').mockImplementation(() => refresh.promise);
    h.requests[0]!.finish(result(defaultQuery, source(5)));
    await tick();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(h.store.snapshot?.revision).toBe(4);
    expect(h.projection.page.value).toBeNull();
    expect(h.projection.allowCommands.value).toBe(false);
    h.store.snapshot = source(5);
    refresh.finish();
    await tick();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.finish(result(defaultQuery, source(5)));
    await tick();
    expect(h.projection.page.value?.revision).toBe(5);
  });
  it('does not accept same-revision contradictory wallet or mismatched scope', async () => {
    const h = harness();
    h.requests[0]!.finish(result(defaultQuery, source(4, 99)));
    await tick();
    expect(h.projection.page.value).toBeNull();
    expect(h.projection.queryError.value).toContain('不一致');
    void h.projection.reload();
    h.requests[1]!.finish(result({ ...defaultQuery, filter: 'HISTORY' }, source(4)));
    await tick();
    expect(h.projection.page.value).toBeNull();
    expect(h.projection.queryError.value).toContain('不一致');
  });
  it('returns to actual first page when pending selection/expiry removed the last page', async () => {
    const h = harness();
    h.queryData.value = { ...defaultQuery, offset: 8 };
    await tick();
    h.requests[1]!.finish(result(h.queryData.value, source(4)));
    await tick();
    expect(h.resetOffset).toHaveBeenCalledWith(0);
    expect(h.requests).toHaveLength(3);
    expect(h.projection.page.value).toBeNull();
    h.requests[2]!.finish(result(defaultQuery, source(4)));
    await tick();
    expect(h.projection.page.value?.offset).toBe(0);
  });
  it('discards failure after unmount and does not start new queries when store changes', async () => {
    const h = harness();
    h.unmount();
    h.requests[0]!.fail(new Error('late rejected transport'));
    h.store.snapshot = source(5);
    await tick();
    expect(h.projection.stamp.value).toBeNull();
    expect(h.projection.queryError.value).toBeNull();
    expect(h.requests).toHaveLength(1);
  });
  it('coalesces revision signals for home inbox without periodic polling or automatic retry', async () => {
    vi.useFakeTimers();
    const h = harness(250);
    h.store.snapshot = source(5);
    await tick();
    await vi.advanceTimersByTimeAsync(125);
    h.store.snapshot = source(6);
    await tick();
    await vi.advanceTimersByTimeAsync(249);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.fail(new Error('temporary service failure'));
    await tick();
    expect(h.projection.queryError.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(1);
    void h.projection.reload();
    expect(h.requests).toHaveLength(2);
    h.requests[1]!.finish(result(defaultQuery, source(6)));
    await tick();
    expect(h.projection.page.value?.revision).toBe(6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(2);
  });
  it('clears pending debounce timer on home unmount', async () => {
    vi.useFakeTimers();
    const h = harness(250);
    h.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.requests).toHaveLength(0);
  });
});
