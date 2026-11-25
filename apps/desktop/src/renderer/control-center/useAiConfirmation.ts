import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { AiProjection } from './useAiProjection';

export interface AiConfirmation {
  title: string;
  detail: string[];
  warning: string;
  confirmLabel: string;
  /** Exact frozen presentation must still be current immediately before write. */
  current: () => boolean;
  perform: () => Promise<boolean>;
}
export function useAiConfirmation(context: AiProjection) {
  const quote = shallowRef<AiConfirmation | null>(null);
  const submitting = ref(false), attempted = ref(false), error = ref<string | null>(null);
  let disposed = false;
  const confirmable = computed(() => !!quote.value && !submitting.value && !attempted.value && quote.value.current());
  function close(force = false): void {
    if (submitting.value && !force) return;
    quote.value = null; attempted.value = false; submitting.value = false; error.value = null;
  }
  function begin(action: AiConfirmation): void {
    if (!disposed && !quote.value && action.current()) {
      quote.value = Object.freeze(action); error.value = null; attempted.value = false;
    }
  }
  async function commit(): Promise<void> {
    const pending = quote.value;
    if (!pending || !confirmable.value || !pending.current()) return;
    submitting.value = true; attempted.value = true;
    let success = false;
    try { success = await pending.perform(); } catch { /* sanitized feedback */ }
    if (disposed || quote.value !== pending) return;
    submitting.value = false;
    if (success) { close(true); context.refreshAll(); }
    else error.value = '结果未确认，请关闭并查询实际记录。不会自动重复执行。';
  }
  function dialogError(): void { close(true); error.value = '无法打开操作确认窗口，未提交请求。'; }
  watch([context.generation, context.epoch], () => close(true), { flush: 'sync' });
  onBeforeUnmount(() => { disposed = true; close(true); });
  return { quote, submitting, attempted, confirmable, error, begin, close, commit, dialogError };
}
