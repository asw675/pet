<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { AiConfirmation } from '../useAiConfirmation';
const props = defineProps<{ quote: AiConfirmation | null; submitting: boolean; attempted: boolean; confirmable: boolean; error: string | null }>();
const emit = defineEmits<{ confirm: []; cancel: []; modalError: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
watch(() => props.quote, async next => {
  if (!next) { if (dialog.value?.open) dialog.value.close(); return; }
  await nextTick();
  if (props.quote !== next) return;
  try {
    if (!dialog.value) throw new Error('missing dialog');
    if (!dialog.value.open) dialog.value.showModal();
  } catch { emit('modalError'); }
}, { flush: 'post' });
function cancel(event: Event) { event.preventDefault(); if (!props.submitting) emit('cancel'); }
function closed() { if (props.quote && !dialog.value?.open && !props.submitting) emit('cancel'); }
</script>
<template>
  <dialog ref="dialog" class="ai-confirm" aria-label="AI 操作确认" @cancel="cancel" @close="closed">
    <section v-if="quote">
      <header><span class="eyebrow">显式授权 · 本地服务</span><h2>{{ quote.title }}</h2></header>
      <ul><li v-for="(line, i) in quote.detail" :key="i">{{ line }}</li></ul>
      <p class="ai-warning">{{ quote.warning }}</p>
      <p v-if="submitting" class="small muted" role="status">等待服务确认…</p>
      <p v-else-if="error" class="ai-warning" role="alert">{{ error }}</p>
      <p v-else-if="attempted || !confirmable" class="ai-warning" role="status">记录、授权或服务状态已变化。请关闭窗口并重新确认。</p>
      <div class="ai-confirm-actions">
        <button type="button" class="button button-secondary" :disabled="submitting" @click="emit('cancel')">取消</button>
        <button type="button" class="button button-primary" :disabled="!confirmable || submitting" @click="emit('confirm')">{{ quote.confirmLabel }}</button>
      </div>
    </section>
  </dialog>
</template>
<style scoped>
.ai-confirm { width: min(530px,calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; overflow: auto; background: #342b32; color: var(--text); border: 1px solid #93755d; border-radius: 15px; box-shadow: 0 24px 55px #100911c9; }
.ai-confirm::backdrop { background: #110e17dc; }
.ai-confirm section { padding: 20px; display: grid; gap: 13px; }
.ai-confirm h2 { color: var(--gold-light); font-size: 20px; margin-top: 5px; }
.ai-confirm ul { margin: 0; padding: 13px 13px 13px 28px; border-radius: 8px; background: #292229; border: 1px solid var(--border); display: grid; gap: 7px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.ai-warning { background: #49332d; color: #f2cfb0; border: 1px solid #76523f; border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.6; }
.ai-confirm-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; }
</style>
