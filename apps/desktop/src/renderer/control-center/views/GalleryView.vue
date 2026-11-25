<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { galleryIpcResultSchema, galleryLimits, galleryQuerySchema } from '@pet-desktop/contracts';
import type { GalleryFilter, GalleryQuery, GalleryRarity, GalleryRow, UnlockedGalleryRow } from '@pet-desktop/contracts';
import { BUILTIN_CG_CATALOG } from '@pet-desktop/domain/cg-catalog';
import { cgFailureText, cgRowKey, resolveBuiltinCg } from '../../cg-assets/registry';
import type { CgAssetResult } from '../../cg-assets/registry';
import { confirmedViewPayload, exactGalleryRow, returnedGalleryMatchesQuery, usableGalleryPage } from '../../cg-assets/gallery-view-policy';
import type { StampedGalleryPage } from '../../cg-assets/gallery-view-policy';
import { routeName } from '../../shared/presentation';
import { useAppStore } from '../../shared/store';
import CgGalleryCard from '../components/CgGalleryCard.vue';
import Icon from '../components/Icon.vue';

const store = useAppStore();
const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
const pageSize = 12;
const filter = ref<GalleryFilter>('ALL');
const petFilter = ref('');
const characterFilter = ref('');
const routeFilter = ref('');
const eventFilter = ref('');
const rarityFilter = ref<GalleryRarity | ''>('');
const offset = ref(0);
const filters: readonly { value: GalleryFilter; label: string }[] = [
  { value: 'ALL', label: '全部' }, { value: 'UNLOCKED', label: '已解锁' },
  { value: 'LOCKED', label: '未解锁' }, { value: 'FAVORITES', label: '收藏' },
];
const rarities: readonly { value: GalleryRarity; label: string }[] = [
  { value: 'COMMON', label: '普通' }, { value: 'UNCOMMON', label: '少见' }, { value: 'RARE', label: '稀有' },
  { value: 'EPIC', label: '史诗' }, { value: 'LEGENDARY', label: '传说' },
];

const petOptions = computed(() => store.snapshot?.pets ?? []);
const charactersSeen = ref<string[]>([]);
const routesSeen = ref<string[]>([]);
const eventsSeen = ref<string[]>([]);
const options = (...sets: readonly (readonly string[])[]) => [...new Set(sets.flat().filter(Boolean))].sort();
const characterOptions = computed(() => options(BUILTIN_CG_CATALOG.map(x => x.characterId), petOptions.value.map(x => x.characterId), charactersSeen.value, [characterFilter.value]));
const routeOptions = computed(() => options(BUILTIN_CG_CATALOG.map(x => x.routeId), routesSeen.value, [routeFilter.value]));
const eventOptions = computed(() => options(BUILTIN_CG_CATALOG.map(x => x.eventDefId), eventsSeen.value, [eventFilter.value]));
const eventName = (id: string) => id === 'dew-postcard' ? '晨露明信片' : id;
const characterName = (id: string) => id === 'star-singer' ? '星咏' : id === 'fluffy-ranger' ? '绒绒' : id;
const nickname = (row: GalleryRow) => petOptions.value.find(pet => pet.petId === row.petId)?.nickname ?? row.petId;

const filterKey = computed(() => JSON.stringify([filter.value, petFilter.value, characterFilter.value, routeFilter.value, eventFilter.value, rarityFilter.value]));
watch(filterKey, () => { offset.value = 0; }, { flush: 'sync' });
const query = computed<GalleryQuery>(() => ({
  filter: filter.value, offset: offset.value, limit: pageSize,
  ...(petFilter.value ? { petId: petFilter.value } : {}),
  ...(characterFilter.value ? { characterId: characterFilter.value } : {}),
  ...(routeFilter.value ? { routeId: routeFilter.value } : {}),
  ...(eventFilter.value ? { eventDefId: eventFilter.value } : {}),
  ...(rarityFilter.value ? { rarity: rarityFilter.value } : {}),
}));
const queryKey = computed(() => JSON.stringify(query.value));
const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
const revision = computed(() => generation.value === null ? null : store.snapshot?.revision ?? null);
const page = shallowRef<StampedGalleryPage | null>(null);
const pending = ref(false);
const queryError = ref<string | null>(null);
let requestEpoch = 0;
let disposed = false;

// A late query cannot become an actionable page after a filter, revision or
// service generation changes. Equality (not merely >=) is required against the
// current app snapshot before any content or command can be used.
const currentPage = computed(() => usableGalleryPage(page.value, generation.value, queryKey.value, revision.value));
const allowOpen = computed(() => currentPage.value !== null && !pending.value);
const allowCommands = computed(() => allowOpen.value && store.ready && !store.busy && !store.loading);
const pageNumber = computed(() => Math.floor((currentPage.value?.offset ?? offset.value) / pageSize) + 1);
const pageCount = computed(() => currentPage.value ? Math.max(1, Math.ceil(currentPage.value.total / pageSize)) : 1);
const canNext = computed(() => !!currentPage.value && offset.value + pageSize < currentPage.value.total
  && offset.value + pageSize <= galleryLimits.offset && !pending.value);

async function refreshGallery(): Promise<void> {
  const operation = ++requestEpoch;
  const ownGeneration = generation.value;
  const baseRevision = revision.value;
  const ownKey = queryKey.value;
  const ownQuery = galleryQuerySchema.safeParse(query.value);
  const current = () => !disposed && requestEpoch === operation && generation.value === ownGeneration && queryKey.value === ownKey;
  queryError.value = null;
  if (!bridge || ownGeneration === null || baseRevision === null || !ownQuery.success) {
    page.value = null; pending.value = false;
    if (generation.value !== null) queryError.value = '图鉴查询暂不可用，请稍后刷新。';
    return;
  }
  pending.value = true;
  try {
    const parsed = galleryIpcResultSchema.safeParse(await bridge.listGallery(ownQuery.data));
    if (!current()) return;
    if (!parsed.success || !parsed.data.ok) {
      queryError.value = '未能取得有效图鉴，请刷新后重试。';
      page.value = null;
      return;
    }
    const returned = parsed.data.gallery;
    if (!returnedGalleryMatchesQuery(returned, ownQuery.data, baseRevision, revision.value)) {
      queryError.value = '图鉴状态已变化，请重新查询。';
      page.value = null;
      return;
    }
    if (returned.offset > 0 && returned.rows.length === 0) {
      // Favorites can shrink a last page. Move to a valid earlier page rather
      // than inventing results or showing an empty page as a real end state.
      offset.value = Math.max(0, Math.floor(Math.max(0, returned.total - 1) / pageSize) * pageSize);
      return;
    }
    charactersSeen.value = options(charactersSeen.value, returned.rows.map(row => row.characterId));
    routesSeen.value = options(routesSeen.value, returned.rows.flatMap(row => row.routeId ? [row.routeId] : []));
    eventsSeen.value = options(eventsSeen.value, returned.rows.flatMap(row => row.eventDefId ? [row.eventDefId] : []));
    page.value = { generation: ownGeneration, queryKey: ownKey, gallery: returned };
    // Query authority can be ahead of the asynchronously delivered app
    // projection. Refresh that projection; the page remains inaccessible
    // until both revisions agree. Never overwrite store authority locally.
    if (revision.value !== null && returned.revision > revision.value) {
      await store.refresh();
      if (current() && revision.value !== returned.revision) {
        queryError.value = '图鉴与业务快照版本尚未一致，请重新查询。';
        page.value = null;
      }
    }
  } catch {
    if (current()) { queryError.value = '图鉴服务暂不可用，请刷新后重试。'; page.value = null; }
  } finally {
    if (current()) pending.value = false;
  }
}
watch([queryKey, generation, revision], () => { void refreshGallery(); }, { immediate: true });

function exactCurrentRow(candidate: UnlockedGalleryRow): UnlockedGalleryRow | undefined {
  return exactGalleryRow(currentPage.value, candidate);
}
async function toggleFavorite(candidate: UnlockedGalleryRow): Promise<void> {
  const row = exactCurrentRow(candidate);
  if (!row || row.favorite !== candidate.favorite || !allowCommands.value) return;
  const ownGeneration = generation.value;
  const ownKey = queryKey.value;
  const success = await store.dispatch({ type: 'CG_SET_FAVORITE', payload: {
    petId: row.petId, cgId: row.cgId, variant: row.variant, favorite: !row.favorite,
  } }, row.favorite ? '已取消收藏。' : '已收藏这张纪念画面。');
  if (success && !disposed && generation.value === ownGeneration && queryKey.value === ownKey) void refreshGallery();
}

type SceneAsset = Extract<CgAssetResult, { ok: true }>['asset'];
const dialog = ref<HTMLDialogElement | null>(null);
const selection = shallowRef<{ generation: number; row: UnlockedGalleryRow } | null>(null);
const selectedRow = computed(() => selection.value && generation.value === selection.value.generation
  ? exactCurrentRow(selection.value.row) ?? null : null);
const sceneAsset = shallowRef<SceneAsset | null>(null);
const sceneLoading = ref(false);
const sceneError = ref<string | null>(null);
const imageLoaded = ref(false);
const imageEpoch = ref(0);
const markState = ref<'IDLE' | 'PENDING' | 'DONE' | 'ERROR'>('IDLE');
const zoom = ref(100);
let sceneAbort: AbortController | undefined;

function clearSceneAsset(): void {
  sceneAbort?.abort(); sceneAbort = undefined;
  sceneAsset.value = null; sceneError.value = null; sceneLoading.value = false;
  imageLoaded.value = false; imageEpoch.value++;
}
function closeScene(): void {
  clearSceneAsset(); selection.value = null; markState.value = 'IDLE'; zoom.value = 100;
  if (dialog.value?.open) dialog.value.close();
}
function onDialogClosed(): void { if (!dialog.value?.open && selection.value) closeScene(); }

async function loadScene(): Promise<void> {
  const currentSelection = selection.value;
  const row = selectedRow.value;
  if (!currentSelection || !row) return;
  clearSceneAsset(); markState.value = 'IDLE';
  const controller = new AbortController();
  sceneAbort = controller;
  sceneLoading.value = true;
  const result = await resolveBuiltinCg(row, 'image', controller.signal);
  if (disposed || controller.signal.aborted || selection.value !== currentSelection || generation.value !== currentSelection.generation) return;
  sceneLoading.value = false;
  if (result.ok) sceneAsset.value = result.asset;
  else if (result.code !== 'CANCELLED') sceneError.value = cgFailureText[result.code];
}
async function openScene(candidate: UnlockedGalleryRow): Promise<void> {
  const row = exactCurrentRow(candidate);
  const gen = generation.value;
  if (!row || gen === null || !allowOpen.value) return;
  closeScene();
  const currentSelection = { generation: gen, row };
  selection.value = currentSelection;
  await nextTick();
  if (selection.value !== currentSelection) return;
  if (!selectedRow.value) { closeScene(); return; }
  try { if (dialog.value && !dialog.value.open) dialog.value.showModal(); }
  catch { closeScene(); queryError.value = '暂时无法打开纪念画面，请重试。'; return; }
  void loadScene();
}

function sameImageEvent(event: Event): event is Event & { currentTarget: HTMLImageElement } {
  const target = event.currentTarget;
  return target instanceof HTMLImageElement && target.dataset.epoch === String(imageEpoch.value)
    && sceneAsset.value !== null && target.getAttribute('src') === sceneAsset.value.src;
}
function onImageLoad(event: Event): void {
  if (!sameImageEvent(event) || !selectedRow.value || !sceneAsset.value) return;
  if (event.currentTarget.naturalWidth !== sceneAsset.value.width || event.currentTarget.naturalHeight !== sceneAsset.value.height) {
    onImageError(event); return;
  }
  // Successful asset verification is insufficient: only actual DOM image
  // load of this exact current high-resolution view establishes first view.
  imageLoaded.value = true;
}
function onImageError(event: Event): void {
  if (!sameImageEvent(event)) return;
  sceneAsset.value = null; imageLoaded.value = false;
  sceneError.value = cgFailureText.CORRUPTED_ASSET;
}
function replayScene(): void {
  if (!sceneAsset.value || !selectedRow.value) return;
  imageLoaded.value = false; imageEpoch.value++; zoom.value = 100;
}

async function markViewed(): Promise<void> {
  const selected = selection.value;
  if (!selected || markState.value === 'PENDING' || markState.value === 'DONE') return;
  const payload = confirmedViewPayload({ selected: selected.row, current: selectedRow.value, selectedGeneration: selected.generation,
    currentGeneration: generation.value, image: sceneAsset.value, imageLoaded: imageLoaded.value, allowCommands: allowCommands.value });
  if (!payload) return;
  markState.value = 'PENDING';
  const success = await store.dispatch({ type: 'CG_MARK_VIEWED', payload }, '已记录本次首次查看。');
  if (disposed || selection.value !== selected || generation.value !== selected.generation) return;
  markState.value = success ? 'DONE' : 'ERROR';
  if (success) void refreshGallery();
}
watch([selectedRow, imageLoaded, allowCommands], () => {
  if (markState.value === 'IDLE' && imageLoaded.value && allowCommands.value && selectedRow.value) void markViewed();
});
watch(queryKey, closeScene, { flush: 'sync' });
watch(generation, (next, previous) => {
  if (next !== previous) {
    closeScene(); page.value = null; charactersSeen.value = []; routesSeen.value = []; eventsSeen.value = [];
  }
}, { flush: 'sync' });
watch(currentPage, (next) => {
  // Keep no scene from an earlier page if the authoritative filtered row no
  // longer exists. During a same-generation revision refresh, commands and
  // the high-resolution DOM are withheld until the exact row returns.
  if (next && selection.value && !selectedRow.value) closeScene();
});
onBeforeUnmount(() => { disposed = true; requestEpoch++; closeScene(); });
</script>

<template>
  <section class="panel page-intro gallery-intro">
    <span class="intro-icon"><Icon name="gallery" /></span>
    <div><h2>旅途纪念册</h2><p>每一幅画面都记录所属伙伴与首次获得的固定资源版本。未解锁只展示提示，回看不会再次发放奖励。</p></div>
    <span v-if="currentPage" class="subtle-tag">{{ currentPage.total }} 条记录</span>
    <button class="button button-secondary" type="button" :disabled="generation === null || pending" @click="refreshGallery"><Icon name="refresh" /> 刷新图鉴</button>
  </section>
  <section class="panel gallery-filters" aria-label="图鉴筛选">
    <div class="gallery-tabs" role="group" aria-label="解锁状态">
      <button v-for="item in filters" :key="item.value" type="button" class="button button-secondary" :class="{ chosen: filter === item.value }" :aria-pressed="filter === item.value" @click="filter = item.value">{{ item.label }}</button>
    </div>
    <div class="gallery-fields">
      <label>宠物 <select v-model="petFilter"><option value="">全部伙伴</option><option v-for="pet in petOptions" :key="pet.petId" :value="pet.petId">{{ pet.nickname }}</option></select></label>
      <label>角色 <select v-model="characterFilter"><option value="">全部角色</option><option v-for="character in characterOptions" :key="character" :value="character">{{ characterName(character) }}</option></select></label>
      <label>路线 <select v-model="routeFilter"><option value="">全部路线</option><option v-for="route in routeOptions" :key="route" :value="route">{{ routeName(route) }}</option></select></label>
      <label>事件 <select v-model="eventFilter"><option value="">全部事件</option><option v-for="event in eventOptions" :key="event" :value="event">{{ eventName(event) }}</option></select></label>
      <label>稀有度 <select v-model="rarityFilter"><option value="">全部稀有度</option><option v-for="rarity in rarities" :key="rarity.value" :value="rarity.value">{{ rarity.label }}</option></select></label>
    </div>
  </section>

  <div v-if="queryError" class="panel gallery-placeholder" role="alert"><h3>暂时无法读取图鉴</h3><p>{{ queryError }}</p><button class="button button-secondary" type="button" :disabled="generation === null || pending" @click="refreshGallery">重新查询</button></div>
  <div v-else-if="!currentPage" class="panel gallery-placeholder" role="status"><Icon name="clock" /><h3>{{ generation === null ? '等待本地服务' : '正在验证最新图鉴' }}</h3><p>仅展示与当前业务快照一致的记录。</p></div>
  <template v-else>
    <div v-if="currentPage.rows.length" class="gallery-grid" :aria-busy="pending">
      <CgGalleryCard v-for="row in currentPage.rows" :key="cgRowKey(row)" :row="row" :generation="generation!" :nickname="nickname(row)"
        :allow-open="allowOpen" :allow-commands="allowCommands" @open="openScene" @favorite="toggleFavorite" />
    </div>
    <div v-else class="panel gallery-placeholder"><Icon name="gallery" /><h3>没有符合筛选条件的画面</h3><p>试着更换筛选，或等待下一场旅途归来。</p></div>
    <nav class="panel gallery-pagination" aria-label="图鉴分页">
      <button class="button button-secondary" type="button" :disabled="offset === 0 || pending" @click="offset = Math.max(0, offset - pageSize)">上一页</button>
      <span>第 {{ pageNumber }} / {{ pageCount }} 页 · {{ currentPage.total }} 条</span>
      <button class="button button-secondary" type="button" :disabled="!canNext" @click="offset += pageSize">下一页</button>
    </nav>
  </template>

  <dialog ref="dialog" class="scene-dialog" @cancel.prevent="closeScene" @close="onDialogClosed" @click.self="closeScene">
    <section v-if="selection" class="scene-content" aria-label="纪念画面">
      <header class="scene-heading"><div><span class="eyebrow">旅途纪念 · {{ nickname(selection.row) }}</span><h2>{{ selection.row.title }}</h2></div><button class="button button-secondary" type="button" @click="closeScene">关闭 / 跳过</button></header>
      <div v-if="!selectedRow" class="scene-placeholder" role="status">正在确认该画面的历史身份…</div>
      <div v-else-if="sceneLoading" class="scene-placeholder" role="status">正在验证首次获得时的图像…</div>
      <div v-else-if="sceneError" class="scene-placeholder" role="alert"><Icon name="gallery" /><p>{{ sceneError }}</p><button v-if="selectedRow.assetRef.state === 'PINNED'" type="button" class="button button-secondary" @click="loadScene">重新加载固定版本</button></div>
      <div v-else-if="sceneAsset" class="scene-image-viewport">
        <img :key="imageEpoch" :src="sceneAsset.src" :alt="sceneAsset.entry.title" :data-epoch="imageEpoch" :style="{ width: `${zoom}%` }" @load="onImageLoad" @error="onImageError" />
        <span v-if="!imageLoaded" class="scene-image-wait" role="status">正在显示画面…</span>
      </div>
      <p v-if="sceneAsset && imageLoaded && selectedRow" class="scene-caption">{{ sceneAsset.entry.caption }}</p>
      <div v-else class="scene-caption muted">{{ selection.row.hint }}</div>
      <dl class="scene-history">
        <div><dt>首次获得时间</dt><dd>{{ new Date(selection.row.unlockedAt).toLocaleString('zh-CN') }}</dd></div>
        <div><dt>所属旅程</dt><dd>{{ selection.row.sourceTripId }}</dd></div>
        <div><dt>路线 · 事件</dt><dd>{{ selection.row.routeId ? routeName(selection.row.routeId) : '未知路线' }} · {{ selection.row.eventDefId ? eventName(selection.row.eventDefId) : '历史事件' }}</dd></div>
        <div><dt>固定资源版本</dt><dd>{{ selection.row.assetRef.state === 'PINNED' ? selection.row.assetRef.assetVersion : '未绑定' }}</dd></div>
      </dl>
      <div class="scene-actions">
        <label v-if="sceneAsset && selectedRow">画面缩放 <select v-model.number="zoom"><option :value="100">100%</option><option :value="150">150%</option><option :value="200">200%</option></select></label>
        <button v-if="sceneAsset && selectedRow" type="button" class="button button-secondary" @click="replayScene">重新播放</button>
        <button v-if="selectedRow" type="button" class="button button-secondary" :disabled="!allowCommands" :aria-pressed="selectedRow.favorite" @click="toggleFavorite(selectedRow)">{{ selectedRow.favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
        <button v-if="markState === 'ERROR' && selectedRow && selectedRow.viewedAt === null" type="button" class="button button-secondary" :disabled="!allowCommands || !imageLoaded" @click="markViewed">重新确认首次查看</button>
        <span v-if="selectedRow?.viewedAt !== null && selectedRow" class="muted small">已读</span>
        <span v-else-if="markState === 'PENDING'" class="muted small">确认首次查看中…</span>
      </div>
    </section>
  </dialog>
</template>

<style scoped>
.gallery-intro { flex-wrap: wrap; }
.gallery-filters { padding: 15px; display: grid; gap: 14px; }
.gallery-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.gallery-tabs .button { min-height: 34px; padding: 7px 17px; font-size: 12px; }
.gallery-tabs .button.chosen { color: var(--gold-light); background: #61483b; border-color: #ac835b; }
.gallery-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 9px; }
.gallery-fields label, .scene-actions label { display: grid; gap: 6px; font-size: 11px; color: var(--muted); min-width: 0; }
.gallery-fields select, .scene-actions select { padding: 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: #302831; min-width: 0; width: 100%; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 215px), 1fr)); gap: 14px; align-items: stretch; }
.gallery-placeholder { display: grid; justify-items: center; gap: 12px; text-align: center; padding: 32px 15px; color: var(--muted); }
.gallery-placeholder h3 { font-size: 17px; color: var(--text); }
.gallery-placeholder p { font-size: 13px; }
.gallery-placeholder .icon { width: 32px; height: 32px; color: var(--gold); }
.gallery-pagination { display: flex; justify-content: center; gap: 15px; align-items: center; flex-wrap: wrap; padding: 10px; font-size: 12px; color: var(--muted); }
.scene-dialog { max-width: min(880px, calc(100vw - 26px)); width: min(780px, calc(100vw - 26px)); max-height: calc(100vh - 24px); border: 1px solid #84645c; border-radius: 15px; padding: 0; background: #332a34; color: var(--text); box-shadow: 0 24px 60px #0b070bea; }
.scene-dialog::backdrop { background: #110e17d9; }
.scene-content { display: grid; gap: 14px; padding: clamp(12px, 3vw, 23px); }
.scene-heading { display: flex; gap: 12px; justify-content: space-between; align-items: center; }
.scene-heading h2 { font-size: 21px; margin-top: 3px; }
.scene-heading .button { white-space: nowrap; }
.scene-image-viewport { overflow: auto; max-height: 55vh; min-height: 120px; border: 1px solid var(--border); border-radius: 10px; background: #201a23; position: relative; }
.scene-image-viewport img { display: block; max-width: none; height: auto; min-width: 100%; animation: scene-fade .3s ease-out; }
@keyframes scene-fade { from { opacity: 0; } to { opacity: 1; } }
.scene-image-wait { position: absolute; top: 12px; left: 12px; color: var(--muted); }
.scene-placeholder { display: grid; place-content: center; justify-items: center; min-height: 170px; padding: 16px; text-align: center; gap: 12px; border: 1px dashed var(--border); border-radius: 10px; color: var(--muted); font-size: 13px; }
.scene-placeholder .icon { color: var(--gold); width: 30px; height: 30px; }
.scene-caption { color: #f0d9c9; font-size: 14px; line-height: 1.8; padding: 12px; border-left: 2px solid var(--gold); background: #3c303a; border-radius: 6px; }
.scene-history { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 215px), 1fr)); gap: 10px; }
.scene-history div { display: grid; gap: 4px; min-width: 0; }
.scene-history dt { color: var(--faded); font-size: 11px; }
.scene-history dd { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.scene-actions { display: flex; gap: 9px; align-items: end; flex-wrap: wrap; }
.scene-actions > label { min-width: 110px; }
@media (prefers-reduced-motion: reduce) { .scene-image-viewport img { animation: none; } }
</style>
