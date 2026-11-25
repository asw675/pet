import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { inventoryIpcResultSchema } from '@pet-desktop/contracts';
import { inventoryLimits } from '@pet-desktop/contracts/inventory';
import { useAppStore } from '../shared/store';
import {
  confirmInventoryQuote, createInventoryQuote, inventoryQueryCanAccept, legacyPageOffset, usableInventoryPage,
} from '../shared/inventory-view-policy';
import type {
  InventoryConfirmationQuote, InventoryOperation, StampedInventoryPage,
} from '../shared/inventory-view-policy';

/** Shared inventory/shop renderer plumbing; each mounted route owns its
 * read request sequence and confirmation, with no fallback/business data. */
export function useInventoryProjection() {
  const store = useAppStore();
  const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
  const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
  const revision = computed(() => generation.value === null ? null : store.snapshot?.revision ?? null);
  const stamp = shallowRef<StampedInventoryPage | null>(null);
  const legacyOffset = ref(0);
  const pending = ref(false);
  const queryError = ref<string | null>(null);
  let queryEpoch = 0;
  let disposed = false;
  const page = computed(() => usableInventoryPage(stamp.value, generation.value, store.snapshot, legacyOffset.value));
  const allowCommands = computed(() => page.value !== null && !pending.value && store.ready && !store.loading && !store.busy);

  async function refreshInventory(): Promise<void> {
    const seq = ++queryEpoch;
    const ownGeneration = generation.value;
    const baseRevision = revision.value;
    const ownOffset = legacyOffset.value;
    const current = () => !disposed && seq === queryEpoch && generation.value === ownGeneration && legacyOffset.value === ownOffset;
    queryError.value = null;
    if (!bridge || ownGeneration === null || baseRevision === null) {
      stamp.value = null;
      pending.value = false;
      if (ownGeneration !== null) queryError.value = '背包装备查询暂不可用，请刷新。';
      return;
    }
    pending.value = true;
    try {
      const parsed = inventoryIpcResultSchema.safeParse(await bridge.listInventory(ownOffset === 0 ? undefined : ownOffset));
      if (!current()) return;
      if (!parsed.success || !parsed.data.ok) {
        stamp.value = null;
        queryError.value = '没有取得有效的背包与商店档案，请重新查询。';
        return;
      }
      const { inventory, snapshot } = parsed.data;
      const live = store.snapshot;
      if (!live || !inventoryQueryCanAccept(inventory, snapshot, live, baseRevision, ownOffset)) {
        stamp.value = null;
        queryError.value = '背包档案与当前业务快照不一致，请刷新。';
        return;
      }
      if (ownOffset > 0 && ownOffset >= inventory.legacyStackTotal) {
        // A historical page may shrink. Return to its last possible page;
        // never display a fabricated empty history or a different offset.
        legacyOffset.value = Math.max(0, Math.floor(Math.max(0, inventory.legacyStackTotal - 1) / inventoryLimits.legacyStackPage)
          * inventoryLimits.legacyStackPage);
        return;
      }
      stamp.value = { generation: ownGeneration, inventory };
      if (inventory.revision > live.revision) {
        // Query may advance authority before a delayed push. Keep actions
        // blocked until the existing AppStore confirms the exact snapshot.
        await store.refresh();
        if (current() && !page.value) {
          stamp.value = null;
          queryError.value = '背包档案仍在等待一致的业务快照，请重新查询。';
        }
      }
    } catch {
      if (current()) {
        stamp.value = null;
        queryError.value = '背包服务暂不可用，请刷新后重试。';
      }
    } finally {
      if (current()) pending.value = false;
    }
  }

  async function reload(): Promise<void> {
    if (generation.value === null || !bridge) await store.refresh();
    else await refreshInventory();
  }

  function changeLegacyPage(direction: -1 | 1): void {
    if (pending.value || !page.value || store.busy) return;
    const next = legacyPageOffset(page.value, direction);
    if (next === undefined) return;
    legacyOffset.value = next;
  }

  const quote = shallowRef<InventoryConfirmationQuote | null>(null);
  const attempted = ref(false);
  const executing = ref(false);
  const confirmable = computed(() => !!quote.value && !attempted.value && !executing.value
    && confirmInventoryQuote(quote.value, stamp.value, generation.value, store.snapshot, allowCommands.value) !== undefined);

  function quoteFor(operation: InventoryOperation): InventoryConfirmationQuote | undefined {
    return createInventoryQuote(stamp.value, generation.value, store.snapshot, operation, allowCommands.value);
  }
  function beginQuote(operation: InventoryOperation): void {
    if (executing.value) return;
    const candidate = quoteFor(operation);
    if (!candidate) return;
    attempted.value = false;
    quote.value = candidate;
  }
  function closeQuote(force = false): void {
    if (executing.value && !force) return;
    quote.value = null;
    attempted.value = false;
    executing.value = false;
  }
  function onModalError(): void {
    closeQuote(true);
    queryError.value = '无法打开操作确认，请刷新后重试。';
  }

  async function confirmQuote(): Promise<void> {
    const selected = quote.value;
    if (!selected || attempted.value || executing.value) return;
    const command = confirmInventoryQuote(selected, stamp.value, generation.value, store.snapshot, allowCommands.value);
    if (!command) return;
    // Check and consume the gesture synchronously, before awaiting anything.
    // store.dispatch owns the expectedRevision and single command ID.
    attempted.value = true;
    executing.value = true;
    const success = await store.dispatch(command, '操作已由本地服务确认，正在更新背包。');
    if (disposed || quote.value !== selected || generation.value !== selected.generation) return;
    executing.value = false;
    if (success) {
      closeQuote(true);
      void refreshInventory();
    } else {
      // No local debit/grant and no automatic retry. An ambiguous result
      // invalidates this supplemental projection; the user must refresh.
      stamp.value = null;
      queryError.value = '本次操作的结果尚未确认，请重新查询再决定是否操作。';
    }
  }

  watch(generation, (next, previous) => {
    if (next !== previous) {
      queryEpoch += 1;
      pending.value = false;
      stamp.value = null;
      legacyOffset.value = 0;
      closeQuote(true);
    }
  }, { flush: 'sync' });
  watch([generation, revision, () => store.snapshot?.walletCoins, legacyOffset], () => { void refreshInventory(); }, { immediate: true });
  onBeforeUnmount(() => {
    disposed = true;
    queryEpoch += 1;
    closeQuote(true);
    stamp.value = null;
  });

  return {
    store, generation, page, pending, queryError, allowCommands, reload, changeLegacyPage,
    quote, attempted, executing, confirmable, quoteFor, beginQuote, confirmQuote, closeQuote, onModalError,
  };
}
