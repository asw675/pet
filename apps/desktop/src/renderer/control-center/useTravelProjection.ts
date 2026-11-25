import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { activeTravelIpcResultSchema, travelCatalogIpcResultSchema, travelPreviewIpcResultSchema, travelReportsIpcResultSchema } from '@pet-desktop/contracts';
import { activeTravelMatchesSnapshot, travelReportsQuerySchema } from '@pet-desktop/contracts/travel';
import type { ActiveTravelPage, TravelReportsQuery, TripPreparationPayload } from '@pet-desktop/contracts/travel';
import { useAppStore } from '../shared/store';
import {
  previewMatchesPreparation, reportsMatchQuery, reportsQueryKey, travelQueryCanAccept, travelReasonText,
  usableTravelCatalog, usableTravelPreview, usableTravelReports,
} from '../shared/travel-view-policy';
import type { StampedTravelCatalog, StampedTravelPreview, StampedTravelReports } from '../shared/travel-view-policy';

function travelContext() {
  const store = useAppStore();
  const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
  const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
  const revision = computed(() => generation.value === null ? null : store.snapshot?.revision ?? null);
  return { store, bridge, generation, revision };
}

export function useActiveTravelProjection() {
  const { store, bridge, generation, revision } = travelContext();
  const hasTrips = computed(() => store.snapshot?.pets.some(pet => pet.trip?.status === 'TRAVELING') === true);
  const stamp = shallowRef<{ generation: number; page: ActiveTravelPage } | null>(null);
  const failed = ref(false);
  const page = computed(() => {
    const current = stamp.value;
    return current && current.generation === generation.value && store.snapshot
      && activeTravelMatchesSnapshot(current.page, store.snapshot) ? current.page : null;
  });
  watch([generation, revision, hasTrips], async ([gen, base, active], _, onCleanup) => {
    let stale = false;
    onCleanup(() => { stale = true; });
    failed.value = false;
    if (!bridge || gen === null || base === null || !active) {
      stamp.value = null;
      return;
    }
    try {
      const result = activeTravelIpcResultSchema.safeParse(await bridge.listActiveTravel());
      if (stale || gen !== generation.value) return;
      if (!result.success || !result.data.ok || !travelQueryCanAccept(result.data.activeTravel.revision, result.data.snapshot, store.snapshot, base)) {
        failed.value = true;
        return;
      }
      stamp.value = { generation: gen, page: result.data.activeTravel };
      if (revision.value !== null && result.data.activeTravel.revision > revision.value) await store.refresh();
    } catch {
      if (!stale) failed.value = true;
    }
  }, { immediate: true });
  return { activeTravel: page, activeTravelFailed: failed };
}

export function useTravelCatalogProjection() {
  const context = travelContext();
  const { store, bridge, generation, revision } = context;
  const stamp = shallowRef<StampedTravelCatalog | null>(null);
  const pending = ref(false);
  const queryError = ref<string | null>(null);
  let sequence = 0;
  let disposed = false;
  const catalog = computed(() => usableTravelCatalog(stamp.value, generation.value, store.snapshot));
  const available = computed(() => catalog.value !== null && !pending.value && store.ready && !store.busy && !store.loading);

  async function refreshCatalog(): Promise<void> {
    const request = ++sequence;
    const gen = generation.value;
    const base = revision.value;
    const current = () => !disposed && request === sequence && generation.value === gen;
    queryError.value = null;
    if (!bridge || gen === null || base === null) {
      pending.value = false; stamp.value = null;
      if (gen !== null) queryError.value = '路线目录暂不可读取。';
      return;
    }
    pending.value = true;
    try {
      const parsed = travelCatalogIpcResultSchema.safeParse(await bridge.listTravelCatalog());
      if (!current()) return;
      if (!parsed.success || !parsed.data.ok) {
        stamp.value = null; queryError.value = '未取得有效路线目录，请重新查询。'; return;
      }
      const { travelCatalog, snapshot } = parsed.data;
      if (!travelQueryCanAccept(travelCatalog.revision, snapshot, store.snapshot, base)) {
        stamp.value = null; queryError.value = '路线目录与当前业务快照不一致，请刷新。'; return;
      }
      stamp.value = { generation: gen, projection: travelCatalog, snapshot };
      if (revision.value !== null && travelCatalog.revision > revision.value) {
        await store.refresh();
        if (current() && !catalog.value) {
          stamp.value = null; queryError.value = '路线目录正在等待一致的业务快照，请重新查询。';
        }
      }
    } catch {
      if (current()) { stamp.value = null; queryError.value = '路线服务暂不可用，请刷新后重试。'; }
    } finally { if (current()) pending.value = false; }
  }

  async function reload(): Promise<void> {
    if (generation.value === null || !bridge) await store.refresh();
    else await refreshCatalog();
  }
  watch(generation, () => { sequence++; stamp.value = null; pending.value = false; }, { flush: 'sync' });
  watch([generation, revision], () => { void refreshCatalog(); }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; sequence++; stamp.value = null; });
  return { ...context, catalog, available, pending, queryError, reload, refreshCatalog };
}

/** A departure preview is created only by an explicit query gesture. Draft,
 * generation, and exact business revision guard every late reply/confirm. */
export function useDeparturePreview(
  context: ReturnType<typeof useTravelCatalogProjection>,
  payload: ComputedRef<TripPreparationPayload | undefined>,
  draftKey: ComputedRef<string>,
) {
  const { store, bridge, generation, revision, catalog, available } = context;
  const stamp = shallowRef<StampedTravelPreview | null>(null);
  const pending = ref(false);
  const queryError = ref<string | null>(null);
  const preview = computed(() => usableTravelPreview(stamp.value, generation.value, store.snapshot, catalog.value, payload.value));
  const stale = computed(() => stamp.value !== null && preview.value === null);
  let sequence = 0;
  let disposed = false;

  function invalidate(): void {
    sequence++;
    stamp.value = null;
    pending.value = false;
    queryError.value = null;
  }
  watch([generation, draftKey], invalidate, { flush: 'sync' });

  const canPreview = computed(() => !!payload.value && available.value && !pending.value);
  async function requestPreview(): Promise<void> {
    const requested = payload.value;
    const gen = generation.value;
    const base = revision.value;
    if (!bridge || !requested || gen === null || base === null || !canPreview.value) return;
    const request = ++sequence;
    const ownDraftKey = draftKey.value;
    const current = () => !disposed && request === sequence && generation.value === gen && draftKey.value === ownDraftKey;
    stamp.value = null;
    pending.value = true;
    queryError.value = null;
    try {
      const parsed = travelPreviewIpcResultSchema.safeParse(await bridge.previewTravel(requested));
      if (!current()) return;
      if (!parsed.success || !parsed.data.ok) {
        queryError.value = '未取得有效的出发准备报价，请重新查询。'; return;
      }
      const { snapshot, travelPreview } = parsed.data;
      if (!travelQueryCanAccept(travelPreview.revision, snapshot, store.snapshot, base)
        || !previewMatchesPreparation(travelPreview, requested)) {
        queryError.value = '已选择的出发条件与服务返回结果不一致，请重新查询。'; return;
      }
      if (!travelPreview.route || travelPreview.routeCatalogVersion !== requested.routeCatalogVersion) {
        queryError.value = travelPreview.reasons.map(travelReasonText).join(' ') || '目录已变化，请重新查询。';
        // Restore read-only catalog metadata, but never silently repeat the preview or departure.
        void context.refreshCatalog();
        return;
      }
      stamp.value = { generation: gen, snapshot, projection: travelPreview, requested };
      if (revision.value !== null && travelPreview.revision > revision.value) await store.refresh();
    } catch {
      if (current()) { stamp.value = null; queryError.value = '无法取得出发条件，请刷新后重试。'; }
    } finally { if (current()) pending.value = false; }
  }
  onBeforeUnmount(() => { disposed = true; sequence++; stamp.value = null; });
  return { stamp, preview, stale, pending, queryError, canPreview, requestPreview, invalidate };
}

export function useTravelReportsProjection(query: ComputedRef<TravelReportsQuery>,
  resetOffset: (offset: number) => void, resetScope: () => void) {
  const context = travelContext();
  const { store, bridge, generation, revision } = context;
  const stamp = shallowRef<StampedTravelReports | null>(null);
  const pending = ref(false);
  const queryError = ref<string | null>(null);
  let sequence = 0;
  let disposed = false;
  const key = computed(() => reportsQueryKey(query.value));
  const page = computed(() => usableTravelReports(stamp.value, generation.value, store.snapshot, query.value));
  const allowCommands = computed(() => !!page.value && !pending.value && store.ready && !store.loading && !store.busy);

  async function refreshReports(): Promise<void> {
    const request = ++sequence;
    const gen = generation.value;
    const base = revision.value;
    const ownKey = key.value;
    const parsedQuery = travelReportsQuerySchema.safeParse(query.value);
    const current = () => !disposed && request === sequence && generation.value === gen && key.value === ownKey;
    queryError.value = null;
    if (!bridge || gen === null || base === null || !parsedQuery.success) {
      pending.value = false; stamp.value = null;
      if (gen !== null) queryError.value = '旅行报告查询条件不可用，请重新选择。';
      return;
    }
    pending.value = true;
    try {
      const parsed = travelReportsIpcResultSchema.safeParse(await bridge.listTravelReports(parsedQuery.data));
      if (!current()) return;
      if (!parsed.success || !parsed.data.ok) {
        stamp.value = null; queryError.value = '未取得有效旅行报告，请重新查询。'; return;
      }
      const { snapshot, travelReports } = parsed.data;
      if (!travelQueryCanAccept(travelReports.revision, snapshot, store.snapshot, base) || !reportsMatchQuery(travelReports, parsedQuery.data)) {
        stamp.value = null; queryError.value = '旅行历史与当前业务快照或查询分页不一致，请刷新。'; return;
      }
      if (travelReports.offset > 0 && travelReports.rows.length === 0) {
        resetOffset(Math.max(0, Math.floor(Math.max(0, travelReports.total - 1) / travelReports.limit) * travelReports.limit));
        return;
      }
      stamp.value = { generation: gen, projection: travelReports, snapshot, query: parsedQuery.data };
      if (revision.value !== null && travelReports.revision > revision.value) {
        await store.refresh();
        if (current() && !page.value) {
          stamp.value = null; queryError.value = '旅行报告尚在等待一致的业务快照，请重新查询。';
        }
      }
    } catch {
      if (current()) { stamp.value = null; queryError.value = '旅行报告服务暂不可用，请刷新后重试。'; }
    } finally { if (current()) pending.value = false; }
  }
  async function reload(): Promise<void> {
    if (generation.value === null || !bridge) await store.refresh();
    else await refreshReports();
  }
  watch(generation, () => {
    sequence++; stamp.value = null; pending.value = false; resetScope();
  }, { flush: 'sync' });
  watch([generation, revision, key], () => { void refreshReports(); }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; sequence++; stamp.value = null; });
  return { ...context, page, pending, queryError, allowCommands, reload, refreshReports };
}
