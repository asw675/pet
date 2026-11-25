import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { eventsIpcResultSchema } from '@pet-desktop/contracts';
import { eventListQuerySchema } from '@pet-desktop/contracts/events';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import { useAppStore } from '../shared/store';
import { eventQueryCanAccept, eventQueryKey, usableEventPage } from '../shared/event-view-policy';
import type { StampedEventPage } from '../shared/event-view-policy';

/** Read-only event projection. Query only from explicit refresh and the
 * existing authoritative snapshot generation/revision signal. The home
 * inbox can coalesce those signals without polling or triggering a reroll. */
export function useEventProjection(query: ComputedRef<EventListQuery>, resetOffset: (offset: number) => void,
  resetScope: () => void, options: { readonly debounceMs?: number } = {}) {
  const store = useAppStore();
  const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
  const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
  const revision = computed(() => generation.value === null ? null : store.snapshot?.revision ?? null);
  const stamp = shallowRef<StampedEventPage | null>(null);
  const pending = ref(false);
  const queryError = ref<string | null>(null);
  const key = computed(() => eventQueryKey(query.value));
  const page = computed(() => usableEventPage(stamp.value, generation.value, store.snapshot, query.value));
  const allowCommands = computed(() => page.value !== null && !pending.value && store.ready && !store.loading && !store.busy);
  let sequence = 0;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelTimer(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  async function refreshEvents(): Promise<void> {
    cancelTimer();
    const request = ++sequence;
    const gen = generation.value;
    const base = revision.value;
    const ownKey = key.value;
    const parsedQuery = eventListQuerySchema.safeParse(query.value);
    const current = () => !disposed && request === sequence && generation.value === gen && key.value === ownKey;
    queryError.value = null;
    if (!bridge || gen === null || base === null || !parsedQuery.success) {
      pending.value = false; stamp.value = null;
      if (gen !== null) queryError.value = '事件查询条件不可用，请重新选择。';
      return;
    }
    pending.value = true;
    try {
      const parsed = eventsIpcResultSchema.safeParse(await bridge.listEvents(parsedQuery.data));
      if (!current()) return;
      if (!parsed.success || !parsed.data.ok) {
        stamp.value = null; queryError.value = '未取得有效事件记录，请重新查询。'; return;
      }
      const { snapshot, events } = parsed.data;
      if (!eventQueryCanAccept(events, snapshot, store.snapshot, base, parsedQuery.data)) {
        stamp.value = null; queryError.value = '事件档案与当前业务快照或查询分页不一致，请刷新。'; return;
      }
      if (events.offset > 0 && events.rows.length === 0) {
        resetOffset(Math.max(0, Math.floor(Math.max(0, events.total - 1) / events.limit) * events.limit));
        return;
      }
      stamp.value = { generation: gen, snapshot, query: parsedQuery.data, page: events };
      if (revision.value !== null && events.revision > revision.value) {
        await store.refresh();
        if (current() && !page.value) {
          stamp.value = null; queryError.value = '事件档案尚在等待一致的业务状态，请重新查询。';
        }
      }
    } catch {
      if (current()) { stamp.value = null; queryError.value = '事件服务暂不可用，请刷新后重试。'; }
    } finally { if (current()) pending.value = false; }
  }
  async function reload(): Promise<void> {
    if (generation.value === null || !bridge) await store.refresh();
    else await refreshEvents();
  }

  function scheduleRefresh(): void {
    // Fail closed as soon as a new revision/scope enters the queue; old
    // delayed requests cannot become actionable before the debounce fires.
    sequence++; cancelTimer();
    if (generation.value === null) { stamp.value = null; pending.value = false; return; }
    if ((options.debounceMs ?? 0) > 0) {
      pending.value = true;
      debounceTimer = setTimeout(() => { if (!disposed) void refreshEvents(); }, options.debounceMs);
    } else void refreshEvents();
  }
  watch(generation, () => {
    sequence++; cancelTimer(); stamp.value = null; pending.value = false; queryError.value = null; resetScope();
  }, { flush: 'sync' });
  watch([generation, revision, key], scheduleRefresh, { immediate: true });
  onBeforeUnmount(() => { disposed = true; sequence++; cancelTimer(); stamp.value = null; pending.value = false; });
  return { store, generation, revision, stamp, page, pending, queryError, allowCommands, reload, refreshEvents };
}
