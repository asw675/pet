<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GalleryRow, UnlockedGalleryRow } from '@pet-desktop/contracts';
import { cgAcquisitionKey, cgFailureText, resolveBuiltinCg } from '../../cg-assets/registry';
import Icon from './Icon.vue';

const props = defineProps<{
  row: GalleryRow;
  generation: number;
  nickname: string;
  allowOpen: boolean;
  allowCommands: boolean;
}>();
const emit = defineEmits<{ open: [row: UnlockedGalleryRow]; favorite: [row: UnlockedGalleryRow] }>();
const thumbnail = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const retry = ref(0);

const unlocked = computed(() => props.row.unlockStatus === 'UNLOCKED' ? props.row : null);
const previewKey = computed(() => unlocked.value ? cgAcquisitionKey(unlocked.value) : null);

watch([previewKey, () => props.generation, retry], (_, __, onCleanup) => {
  thumbnail.value = null;
  error.value = null;
  loading.value = false;
  const row = unlocked.value;
  // No image resolution at all for a locked row. Legacy/unavailable rows are
  // known history placeholders, not requests for whatever artwork is newest.
  if (!row) return;
  if (row.assetRef.state !== 'PINNED') { error.value = cgFailureText[row.assetRef.state]; return; }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  void resolveBuiltinCg(row, 'thumbnail', controller.signal).then((result) => {
    if (controller.signal.aborted) return;
    loading.value = false;
    if (result.ok) thumbnail.value = result.asset.src;
    else if (result.code !== 'CANCELLED') error.value = cgFailureText[result.code];
  });
}, { immediate: true });

function reportDecodeFailure(event: Event): void {
  if (!(event.currentTarget instanceof HTMLImageElement)
    || event.currentTarget.getAttribute('src') !== thumbnail.value) return;
  thumbnail.value = null;
  error.value = cgFailureText.CORRUPTED_ASSET;
}

function open(): void {
  if (props.allowOpen && unlocked.value) emit('open', unlocked.value);
}
function favorite(): void {
  if (props.allowCommands && unlocked.value) emit('favorite', unlocked.value);
}
</script>

<template>
  <article class="panel cg-card" :class="{ 'cg-card-locked': !unlocked }">
    <button class="cg-card-visual" type="button" :disabled="!unlocked || !allowOpen"
      :aria-label="unlocked ? `查看${row.title}` : `${row.title}，未解锁`" @click="open">
      <img v-if="thumbnail" :src="thumbnail" :alt="`${row.title}缩略图`" @error="reportDecodeFailure" />
      <div v-else class="cg-placeholder" :class="{ silhouette: !unlocked }">
        <Icon name="gallery" />
        <span>{{ !unlocked ? '未解锁' : loading ? '验证缩略图中…' : '历史画面暂不可用' }}</span>
      </div>
      <span v-if="unlocked && unlocked.viewedAt === null" class="cg-new">未读</span>
    </button>
    <div class="cg-card-content">
      <div class="cg-card-heading"><span class="eyebrow">{{ nickname }}</span><span v-if="unlocked?.favorite" class="cg-star" aria-label="已收藏">★</span></div>
      <h3>{{ row.title }}</h3>
      <p>{{ row.hint }}</p>
      <p v-if="error" class="cg-card-error" role="status">{{ error }}</p>
      <div v-if="unlocked" class="cg-card-actions">
        <button class="button button-primary" :disabled="!allowOpen" type="button" @click="open">查看回忆</button>
        <button class="button button-secondary" :disabled="!allowCommands" type="button" :aria-pressed="unlocked.favorite" @click="favorite">{{ unlocked.favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
        <button v-if="error && unlocked.assetRef.state === 'PINNED'" class="text-button" :disabled="!allowOpen" type="button" @click="retry++">重新加载缩略图</button>
      </div>
      <span v-else class="small muted">解锁后便可查看完整纪念画面</span>
    </div>
  </article>
</template>

<style scoped>
.cg-card { overflow: hidden; display: flex; flex-direction: column; min-height: 100%; }
.cg-card-visual { display: block; width: 100%; position: relative; padding: 0; border: 0; border-bottom: 1px solid var(--border); background: #28212c; aspect-ratio: 16 / 9; min-height: 110px; }
.cg-card-visual:disabled { opacity: 1; }
.cg-card-visual img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cg-placeholder { display: grid; place-content: center; gap: 10px; width: 100%; height: 100%; color: #cbb9c8; font-size: 11px; background: radial-gradient(ellipse at 50% 38%, #544456 0%, #302833 68%, #261f28 100%); }
.cg-placeholder .icon { width: 34px; height: 34px; margin: auto; opacity: .8; }
.silhouette { color: #958391; background: radial-gradient(ellipse at 50% 38%, #413743 0%, #28222c 68%, #211c24 100%); }
.silhouette .icon { width: 39px; height: 39px; opacity: .54; }
.cg-new { position: absolute; top: 8px; left: 8px; background: var(--gold); color: #422e28; border-radius: 5px; padding: 4px 6px; font-size: 10px; font-weight: 700; box-shadow: 0 2px 6px #130e17aa; }
.cg-card-content { display: flex; flex: 1; flex-direction: column; gap: 8px; padding: 14px; }
.cg-card-heading { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.cg-card-heading .eyebrow { overflow-wrap: anywhere; }
.cg-star { color: var(--gold); font-size: 15px; }
.cg-card-content h3 { color: var(--text); font-size: 17px; overflow-wrap: anywhere; }
.cg-card-content p { color: var(--muted); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.cg-card-content p.cg-card-error { color: #deb1ae; font-size: 11px; }
.cg-card-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: auto; }
.cg-card-actions .button { min-height: 32px; padding: 6px 9px; font-size: 11px; }
.cg-card-actions .text-button { white-space: normal; text-align: left; color: var(--gold); }
</style>
