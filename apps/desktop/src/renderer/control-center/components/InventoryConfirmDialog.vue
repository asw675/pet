<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { InventoryConfirmationQuote } from '../../shared/inventory-view-policy';

const props = defineProps<{
  quote: InventoryConfirmationQuote | null;
  attempted: boolean;
  executing: boolean;
  confirmable: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: []; modalError: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);

watch(() => props.quote, async (next) => {
  if (!next) { if (dialog.value?.open) dialog.value.close(); return; }
  await nextTick();
  if (props.quote !== next) return;
  try {
    if (!dialog.value) throw new Error('Missing confirmation dialog');
    if (!dialog.value.open) dialog.value.showModal();
  } catch { emit('modalError'); }
}, { flush: 'post' });
function onCancel(event: Event): void {
  event.preventDefault();
  if (!props.executing) emit('cancel');
}
function onClose(): void {
  if (props.quote && !dialog.value?.open && !props.executing) emit('cancel');
}
</script>

<template>
  <dialog ref="dialog" class="inventory-confirm" aria-labelledby="inventory-confirm-title" @cancel="onCancel" @close="onClose">
    <section v-if="quote" class="inventory-confirm-content">
      <header><span class="eyebrow">本地服务 · 操作确认</span><h2 id="inventory-confirm-title">{{ quote.title }}</h2></header>
      <dl class="quote-rows">
        <div v-for="(entry, index) in quote.rows" :key="`${index}:${entry.label}`"><dt>{{ entry.label }}</dt><dd>{{ entry.value }}</dd></div>
      </dl>
      <p class="quote-warning">{{ quote.warning }}</p>
      <p v-if="executing" class="muted small" role="status">正在等待本地服务确认…</p>
      <p v-else-if="attempted" class="quote-warning" role="alert">本次操作结果未确认。请关闭并刷新背包后重新选择；不会自动重复提交。</p>
      <p v-else-if="!confirmable" class="quote-warning" role="status">当前状态、服务报价或目录版本已变化。请关闭窗口并重新确认最新条件。</p>
      <div class="quote-actions">
        <button type="button" class="button button-secondary" :disabled="executing" @click="emit('cancel')">取消</button>
        <button type="button" class="button button-primary" :disabled="!confirmable || executing" @click="emit('confirm')">{{ quote.confirmLabel }}</button>
      </div>
    </section>
  </dialog>
</template>

<style scoped>
.inventory-confirm { width: min(530px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; color: var(--text); background: #342b32; border: 1px solid #93755d; border-radius: 15px; box-shadow: 0 24px 55px #100911c9; padding: 0; }
.inventory-confirm::backdrop { background: #110e17dc; }
.inventory-confirm-content { display: grid; gap: 15px; padding: 20px; }
.inventory-confirm-content h2 { margin-top: 5px; color: var(--gold-light); font-size: 22px; overflow-wrap: anywhere; }
.quote-rows { margin: 0; display: grid; gap: 8px; padding: 14px; border-radius: 10px; border: 1px solid var(--border); background: #292229; }
.quote-rows > div { display: grid; grid-template-columns: minmax(72px, .8fr) minmax(0, 1.65fr); align-items: baseline; gap: 14px; font-size: 12px; }
.quote-rows dt { color: var(--muted); }
.quote-rows dd { margin: 0; color: var(--gold-light); overflow-wrap: anywhere; text-align: right; font-weight: 620; line-height: 1.5; }
.quote-warning { background: #49332d; border: 1px solid #76523f; color: #f2cfb0; font-size: 12px; padding: 10px 12px; border-radius: 8px; line-height: 1.6; }
.quote-actions { display: flex; justify-content: flex-end; gap: 9px; flex-wrap: wrap; }
</style>
