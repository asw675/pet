import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { aiIntentSchema } from '../../shared/ai-ipc';
import type { AiIntent, AiResult, ChatIdentity } from '../../shared/ai-ipc';
import type { ChatMessage, ChatStreamEvent } from '@pet-desktop/contracts/ai';
import { aiErrorText, aiIntentKey, newChatOverlay, reduceChatOverlay, sameChatIdentity, validateAiResponse } from '../shared/ai-view-policy';
import type { AiQueryData, ChatOverlay } from '../shared/ai-view-policy';
import { useAppStore } from '../shared/store';

export interface AiScopeToken { readonly generation: number; readonly epoch: number; readonly petId: string; readonly conversationId: string }
export function useAiProjection() {
  const store = useAppStore();
  const bridge = typeof window !== 'undefined' && window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
  const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
  const pets = computed(() => store.snapshot?.pets ?? []);
  const petId = ref(''), conversationId = ref('');
  const pet = computed(() => pets.value.find(candidate => candidate.petId === petId.value));
  const epoch = ref(0), refreshSignal = ref(0);
  const active = shallowRef<ChatOverlay | null>(null);
  const cancelPending = ref(false), chatError = ref<string | null>(null), chatNotice = ref<string | null>(null);
  const chatting = computed(() => active.value !== null && active.value.terminal === null);
  let disposed = false;
  const token = (): AiScopeToken | null => generation.value === null || !pet.value ? null
    : { generation: generation.value, epoch: epoch.value, petId: petId.value, conversationId: conversationId.value };
  const isCurrent = (stamp: AiScopeToken | null): boolean => !disposed && stamp !== null && generation.value === stamp.generation
    && epoch.value === stamp.epoch && petId.value === stamp.petId && conversationId.value === stamp.conversationId && !!pet.value;

  /** Preload handles transport correlation. Never expose raw errors, model
   * reply branch data, or credential values in generic renderer feedback. */
  async function invoke(intent: AiIntent): Promise<AiResult | null> {
    if (!bridge) return null;
    const checked = aiIntentSchema.safeParse(intent);
    if (!checked.success) return null;
    try { return validateAiResponse(checked.data, await bridge.aiRequest(checked.data)); }
    catch { return null; }
  }
  const problem = (result: AiResult | null) => result && !result.ok ? aiErrorText[result.error.code] : '操作未确认，请查询实际记录后再决定。';
  function refreshAll(): void { refreshSignal.value++; }
  async function stopExact(identity: ChatIdentity): Promise<boolean> {
    const result = await invoke({ method: 'chat/cancel', payload: { ...identity, reason: 'USER' } });
    return result?.ok === true && result.method === 'chat/cancel' && result.data.changed;
  }
  function invalidate(cancel: boolean): void {
    const previous = active.value;
    if (cancel && previous?.terminal === null && previous.generation === generation.value) void stopExact(previous.identity);
    epoch.value++; active.value = null; chatError.value = null; chatNotice.value = null; cancelPending.value = false;
  }
  function selectPet(id: string): void {
    if (id === petId.value || generation.value === null || !pets.value.some(candidate => candidate.petId === id)) return;
    invalidate(true); conversationId.value = ''; petId.value = id;
  }
  function selectConversation(id: string): void {
    if (id === conversationId.value || !token()) return;
    invalidate(true); conversationId.value = id;
  }
  // Generation boundaries reset data even when persisted revisions or IDs are
  // identical. No old stream is cancelled against a newly restarted service.
  watch(generation, next => {
    invalidate(false); conversationId.value = ''; petId.value = next === null ? '' : store.snapshot?.primaryPetId ?? pets.value[0]?.petId ?? '';
  }, { immediate: true, flush: 'sync' });
  watch(pets, next => {
    if (generation.value !== null && !next.some(candidate => candidate.petId === petId.value)) {
      invalidate(true); conversationId.value = ''; petId.value = next[0]?.petId ?? '';
    }
  }, { flush: 'sync' });
  function onStream(event: ChatStreamEvent): void {
    const previous = active.value;
    if (!previous || disposed) return;
    const next = reduceChatOverlay(previous, event, generation.value, epoch.value);
    if (next === previous) return;
    active.value = next;
    if (next.terminal !== null) {
      chatNotice.value = next.terminal === 'final' ? '回复已由服务完成，正在读取真实对话记录。'
        : next.terminal === 'cancelled' ? '服务已确认停止回复。' : null;
      chatError.value = next.error ? aiErrorText[next.error] : null;
      cancelPending.value = false; refreshAll();
    }
  }
  const unsubscribe = bridge?.subscribeChatEvents(onStream);
  function reconcileHistory(rows: readonly ChatMessage[]): void {
    const current = active.value;
    if (!current || current.generation !== generation.value || current.scopeEpoch !== epoch.value) return;
    const settled = rows.find(row => row.role === 'ASSISTANT' && row.status !== 'PENDING' && sameChatIdentity(current.identity, row));
    if (!settled) return;
    const terminal = settled.status === 'COMPLETED' ? 'final' : settled.status === 'CANCELLED' ? 'cancelled' : 'error';
    if (current.terminal === terminal) return;
    // A manually refreshed durable transcript can recover from a missing
    // notification. Never infer a terminal from silence or request timeout.
    active.value = { ...current, text: '', terminal, error: terminal === 'error' ? 'UNAVAILABLE' : null };
    cancelPending.value = false;
    chatError.value = terminal === 'error' ? '本地历史记录确认该回复失败。' : null;
    chatNotice.value = terminal === 'final' ? '已由真实对话记录确认回复。' : terminal === 'cancelled' ? '已由真实对话记录确认取消。' : null;
  }

  async function startChat(text: string, identityOverride?: ChatIdentity): Promise<boolean> {
    const scope = token();
    if (!scope || !scope.conversationId || chatting.value || !bridge) return false;
    let identity: ChatIdentity;
    try { identity = identityOverride ?? { petId: scope.petId, conversationId: scope.conversationId, requestId: globalThis.crypto.randomUUID() }; }
    catch { return false; }
    if (identity.petId !== scope.petId || identity.conversationId !== scope.conversationId) return false;
    const checked = aiIntentSchema.safeParse({ method: 'chat/start', payload: { ...identity, trigger: 'USER', userText: text.trim() } });
    if (!checked.success) return false;
    active.value = newChatOverlay(identity, scope.generation, scope.epoch);
    chatError.value = null; chatNotice.value = null; cancelPending.value = false;
    const result = await invoke(checked.data);
    if (!isCurrent(scope) || !active.value || !sameChatIdentity(active.value.identity, identity)) {
      // Handles the asynchronous start crossing a deliberate pet switch or
      // leaving the page. Never send stale cancellation into a new service.
      if (result?.ok && generation.value === scope.generation) void stopExact(identity);
      return false;
    }
    if (active.value.terminal !== null) return active.value.terminal === 'final';
    if (!result?.ok) {
      active.value = { ...active.value, text: '', terminal: 'error', error: result?.error.code ?? 'UNAVAILABLE' };
      chatError.value = problem(result); refreshAll(); return false;
    }
    refreshAll(); return true;
  }
  async function cancelChat(): Promise<void> {
    const current = active.value, scope = token();
    if (!current || current.terminal !== null || !scope || cancelPending.value) return;
    cancelPending.value = true;
    const changed = await stopExact(current.identity);
    if (!isCurrent(scope) || !active.value || !sameChatIdentity(active.value.identity, current.identity)) return;
    cancelPending.value = false;
    if (active.value.terminal === null) {
      // Cancellation reply alone isn't a final transcript. Re-read actual
      // records and let the terminal notification (if any) close the stream.
      chatNotice.value = changed ? '停止请求已受理，等待服务最终状态。' : '停止结果未确认，请检查实际对话记录。';
      refreshAll();
    }
  }
  onBeforeUnmount(() => { invalidate(true); disposed = true; unsubscribe?.(); });
  return { store, bridge, generation, pets, pet, petId, conversationId, epoch, refreshSignal, active, chatting, cancelPending,
    chatError, chatNotice, token, isCurrent, invoke, problem, refreshAll, selectPet, selectConversation, startChat, cancelChat, reconcileHistory };
}
export type AiProjection = ReturnType<typeof useAiProjection>;

export function useAiQuery<M extends keyof AiQueryData>(context: AiProjection, method: M, query: ComputedRef<Extract<AiIntent, { method: M }> | undefined>) {
  const data = shallowRef<AiQueryData[M] | null>(null);
  const pending = ref(false), error = ref<string | null>(null), version = ref(0);
  const loadedKey = ref('');
  const key = computed(() => aiIntentKey(query.value));
  let sequence = 0, disposed = false;
  const usable = computed<AiQueryData[M] | null>(() => context.generation.value !== null && loadedKey.value === key.value && key.value !== '' ? data.value : null);
  const clear = () => { sequence++; data.value = null; loadedKey.value = ''; pending.value = false; error.value = null; version.value++; };
  async function refresh(): Promise<void> {
    const intent = query.value, scope = context.token(), ownKey = key.value;
    const request = ++sequence;
    const live = () => !disposed && sequence === request && context.isCurrent(scope) && key.value === ownKey;
    data.value = null; loadedKey.value = ''; error.value = null; version.value++;
    if (!intent || !scope) { pending.value = false; return; }
    pending.value = true;
    try {
      const result = await context.invoke(intent);
      if (!live()) return;
      if (!result?.ok || result.method !== method) { error.value = context.problem(result); return; }
      data.value = result.data as AiQueryData[M]; loadedKey.value = ownKey; version.value++;
    } finally { if (live()) pending.value = false; }
  }
  watch([context.generation, context.epoch, key], clear, { flush: 'sync' });
  watch([context.generation, context.epoch, key, context.refreshSignal], () => { void refresh(); }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; clear(); });
  return { data: usable, pending, error, version, refresh };
}
