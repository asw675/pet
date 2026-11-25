<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { charactersIpcResultSchema } from '@pet-desktop/contracts';
import type { PetSnapshot } from '@pet-desktop/contracts';
import { useAppStore } from '../../shared/store';
import { catalogMatchesSnapshot, confirmCharacterQuote, createCharacterQuote, prepareNicknameChange, usableCharacterCatalog } from '../../shared/character-view-policy';
import type { CharacterAcquisitionQuote, NicknameDecision, NicknameDraft, StampedCharacterCatalog } from '../../shared/character-view-policy';
import CharacterCatalogCard from '../components/CharacterCatalogCard.vue';
import Icon from '../components/Icon.vue';
import PetCard from '../components/PetCard.vue';

const store = useAppStore();
const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
const pets = computed(() => store.snapshot?.pets ?? []);
const visibleCount = computed(() => pets.value.filter((pet) => pet.visibility === 'VISIBLE').length);
const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
const revision = computed(() => generation.value === null ? null : store.snapshot?.revision ?? null);
const canAct = computed(() => generation.value !== null && !store.busy && !store.loading);
const paused = computed(() => !store.ready || !!store.snapshot?.pausedRender || !!store.snapshot?.doNotDisturb);

// The owned cards continue to display the actual AppSnapshot. Draft inputs
// never modify the projected nickname, and belong to one pet and generation.
const drafts = ref(new Map<string, NicknameDraft>());
const nicknameInput = (pet: PetSnapshot): string => {
  const draft = drafts.value.get(pet.petId);
  return draft?.generation === generation.value && draft.originalNickname === pet.nickname ? draft.input : pet.nickname;
};
const renameDecision = (pet: PetSnapshot): NicknameDecision => {
  const draft = drafts.value.get(pet.petId);
  return draft ? prepareNicknameChange(draft, generation.value, store.snapshot, canAct.value) : { ok: false, reason: 'UNCHANGED' };
};
const nicknameInvalid = (pet: PetSnapshot): boolean => {
  const decision = renameDecision(pet);
  return !decision.ok && decision.reason === 'INVALID';
};
function editNickname(pet: PetSnapshot, event: Event): void {
  const gen = generation.value;
  if (!canAct.value || gen === null || !(event.target instanceof HTMLInputElement)) return;
  const current = pets.value.find(candidate => candidate.petId === pet.petId);
  if (!current || current.nickname !== pet.nickname) return;
  drafts.value.set(pet.petId, { generation: gen, petId: pet.petId, originalNickname: current.nickname, input: event.target.value });
}
function cancelNickname(petId: string): void { drafts.value.delete(petId); }
watch([pets, generation], () => {
  for (const [petId, draft] of drafts.value) {
    if (draft.generation !== generation.value || !pets.value.some(pet => pet.petId === petId && pet.nickname === draft.originalNickname)) {
      drafts.value.delete(petId);
    }
  }
}, { flush: 'sync' });

async function submitNickname(pet: PetSnapshot): Promise<void> {
  const change = renameDecision(pet);
  if (!change.ok) return;
  const ownGeneration = generation.value;
  const success = await store.dispatch({ type: 'PET_RENAME', payload: change.payload }, '昵称已由本地服务保存。');
  if (!disposed && success && generation.value === ownGeneration) {
    cancelNickname(pet.petId);
    void refreshCatalog();
  }
}

// Template metadata is a separate, read-only service projection. No static
// client definitions are used to invent ownership, availability or prices.
const stamp = shallowRef<StampedCharacterCatalog | null>(null);
const pending = ref(false);
const catalogError = ref<string | null>(null);
const catalogIndex = ref(0);
const pageSize = 9;
let requestEpoch = 0;
let disposed = false;
const catalog = computed(() => usableCharacterCatalog(stamp.value, generation.value, store.snapshot));
const allowCatalogCommands = computed(() => !!catalog.value && !pending.value && canAct.value);
const pageCount = computed(() => Math.max(1, Math.ceil((catalog.value?.rows.length ?? 0) / pageSize)));
const visibleTemplates = computed(() => catalog.value?.rows.slice(catalogIndex.value * pageSize, (catalogIndex.value + 1) * pageSize) ?? []);
watch(catalog, (next) => { if (next && catalogIndex.value >= pageCount.value) catalogIndex.value = pageCount.value - 1; });

async function refreshCatalog(): Promise<void> {
  const operation = ++requestEpoch;
  const gen = generation.value;
  const baseRevision = revision.value;
  const current = () => !disposed && requestEpoch === operation && generation.value === gen;
  catalogError.value = null;
  if (!bridge || gen === null || baseRevision === null) {
    stamp.value = null; pending.value = false;
    if (gen !== null) catalogError.value = '角色档案查询暂不可用，请稍后刷新。';
    return;
  }
  pending.value = true;
  try {
    const parsed = charactersIpcResultSchema.safeParse(await bridge.listCharacters());
    if (!current()) return;
    if (!parsed.success || !parsed.data.ok) {
      catalogError.value = '未取得有效角色档案，请重新查询。'; stamp.value = null; return;
    }
    const response = parsed.data;
    const incoming = response.characters;
    const live = store.snapshot;
    if (!live || incoming.revision < baseRevision || incoming.revision < live.revision
      || !catalogMatchesSnapshot(incoming, response.snapshot)
      || (incoming.revision === live.revision && !catalogMatchesSnapshot(incoming, live))) {
      catalogError.value = '角色档案与当前业务快照不一致，请刷新。'; stamp.value = null; return;
    }
    stamp.value = { generation: gen, catalog: incoming };
    if (incoming.revision > live.revision) {
      // Query may advance the authority ahead of its snapshot push. Hold
      // the page until the existing AppStore has confirmed the same revision.
      await store.refresh();
      if (current() && !catalog.value) {
        catalogError.value = '角色档案仍在等待一致的业务快照，请重新查询。'; stamp.value = null;
      }
    }
  } catch {
    if (current()) { catalogError.value = '角色档案服务暂不可用，请刷新后重试。'; stamp.value = null; }
  } finally { if (current()) pending.value = false; }
}

// Explicit two-step acquisition. The confirmation freezes exactly the
// visible service price, catalog version, eligibility and authority revision.
const quote = shallowRef<CharacterAcquisitionQuote | null>(null);
const claimDialog = ref<HTMLDialogElement | null>(null);
const claimAttempted = ref(false);
const claimPending = ref(false);
const claimPayload = computed(() => quote.value && !claimAttempted.value
  ? confirmCharacterQuote(quote.value, stamp.value, generation.value, store.snapshot, allowCatalogCommands.value) : undefined);

function closeQuote(force = false): void {
  if (claimPending.value && !force) return;
  quote.value = null; claimAttempted.value = false; claimPending.value = false;
  if (claimDialog.value?.open) claimDialog.value.close();
}
function onDialogClosed(): void { if (!claimDialog.value?.open && quote.value) closeQuote(true); }
async function chooseCharacter(characterId: string): Promise<void> {
  const current = createCharacterQuote(stamp.value, generation.value, store.snapshot, characterId, allowCatalogCommands.value);
  if (!current || claimPending.value) return;
  closeQuote(true);
  quote.value = current;
  await nextTick();
  if (disposed || quote.value !== current) return;
  try { if (claimDialog.value && !claimDialog.value.open) claimDialog.value.showModal(); }
  catch { closeQuote(true); catalogError.value = '暂时无法打开领取确认，请稍后重试。'; }
}
async function confirmAcquisition(): Promise<void> {
  const selected = quote.value;
  const payload = claimPayload.value;
  if (!selected || !payload) return;
  claimAttempted.value = true;
  claimPending.value = true;
  const success = await store.dispatch({ type: 'PET_ACQUIRE', payload }, '角色领取已由本地服务确认。');
  if (disposed || quote.value !== selected || generation.value !== selected.generation) return;
  claimPending.value = false;
  if (success) { closeQuote(true); void refreshCatalog(); }
  // A failed/unknown result requires a fresh projection and new confirmation;
  // never retry this gesture automatically or change the displayed wallet.
}
watch(generation, (next, previous) => {
  if (next !== previous) { stamp.value = null; catalogIndex.value = 0; closeQuote(true); }
}, { flush: 'sync' });
watch([generation, revision, () => store.snapshot?.walletCoins], () => { void refreshCatalog(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; requestEpoch++; closeQuote(true); drafts.value.clear(); });
</script>

<template>
  <div class="page-intro panel">
    <span class="intro-icon"><Icon name="pet" /></span>
    <div><h2>已拥有的伙伴</h2><p>切换主宠不会重置宠物数据。显示设置与旅途状态分别保存。</p></div>
    <div v-if="store.snapshot" class="intro-numbers"><div><strong>{{ pets.length }}</strong><small>伙伴</small></div><div><strong>{{ visibleCount }}</strong><small>设置为显示</small></div></div>
  </div>
  <div v-if="store.snapshot && pets.length" class="pet-grid owned-grid">
    <div v-for="pet in pets" :key="pet.petId" class="owned-instance">
      <PetCard :pet="pet" />
      <form class="panel nickname-form" :aria-label="`修改${pet.nickname}的昵称`" @submit.prevent="submitNickname(pet)">
        <label :for="`nickname-${pet.petId}`">改名 · 实例独立</label>
        <div class="nickname-controls">
          <input :id="`nickname-${pet.petId}`" type="text" :value="nicknameInput(pet)" :disabled="!canAct" maxlength="80" required autocomplete="off" @input="editNickname(pet, $event)" />
          <button type="submit" class="button button-secondary" :disabled="!renameDecision(pet).ok">保存昵称</button>
        </div>
        <p v-if="drafts.has(pet.petId) && nicknameInvalid(pet)" class="nickname-invalid" role="status">请输入 1–80 个有效字符，不包含控制字符或换行。</p>
        <div v-if="drafts.has(pet.petId)" class="nickname-note"><span>保存成功后档案才会更新。</span><button type="button" class="text-button" :disabled="store.busy" @click="cancelNickname(pet.petId)">取消编辑</button></div>
        <p v-else class="nickname-note">昵称与角色模板名称分开保存。</p>
      </form>
    </div>
  </div>
  <div v-else class="panel empty-state"><Icon name="pet" /><h2>{{ store.snapshot ? '暂无伙伴' : '等待宠物档案' }}</h2><p>{{ store.snapshot ? '当前快照中尚无宠物实例。' : '本地服务返回快照后，可以查看宠物状态。' }}</p></div>

  <section class="panel page-intro template-intro">
    <span class="intro-icon"><Icon name="spark" /></span>
    <div><h2>角色模板库</h2><p>浏览人形幻想女主角的职业、背景、人设与探索能力。领取使用游戏内条件，不涉及现实货币；拥有的伙伴仍是独立档案。</p></div>
    <span v-if="catalog" class="subtle-tag">目录版本 {{ catalog.catalogVersion }} · {{ catalog.rows.length }} 个角色</span>
    <button type="button" class="button button-secondary" :disabled="generation === null || pending" @click="refreshCatalog"><Icon name="refresh" /> 刷新</button>
  </section>
  <div v-if="catalogError" class="panel template-placeholder" role="alert"><h3>无法确认角色模板</h3><p>{{ catalogError }}</p><button type="button" class="button button-secondary" :disabled="pending || generation === null" @click="refreshCatalog">重新查询</button></div>
  <div v-else-if="!catalog" class="panel template-placeholder" role="status"><Icon name="clock" /><h3>{{ generation === null ? '等待本地角色档案' : '正在核对角色目录' }}</h3><p>只有与当前业务快照一致的目录才允许领取。</p></div>
  <template v-else>
    <div class="catalog-summary"><span>已完成探索结算 <strong>{{ catalog.settledTrips }}</strong> 次</span><span>共享游戏金币 <strong>{{ catalog.walletCoins }}</strong></span><span>当前展示均为角色模板资料</span></div>
    <div v-if="visibleTemplates.length" class="template-grid" :aria-busy="pending">
      <CharacterCatalogCard v-for="row in visibleTemplates" :key="row.characterId" :row="row" :catalog="catalog" :allow-commands="allowCatalogCommands" :paused="paused" @acquire="chooseCharacter" />
    </div>
    <div v-else class="panel template-placeholder"><Icon name="spark" /><h3>本地角色目录暂为空</h3><p>未返回模板时不展示虚构的获取条件。</p></div>
    <nav v-if="pageCount > 1" class="panel template-pagination" aria-label="角色模板分页">
      <button type="button" class="button button-secondary" :disabled="catalogIndex === 0 || pending" @click="catalogIndex--">上一页</button>
      <span>第 {{ catalogIndex + 1 }} / {{ pageCount }} 页 · {{ catalog.rows.length }} 个角色</span>
      <button type="button" class="button button-secondary" :disabled="catalogIndex >= pageCount - 1 || pending" @click="catalogIndex++">下一页</button>
    </nav>
  </template>

  <dialog ref="claimDialog" class="claim-dialog" @cancel.prevent="closeQuote()" @close="onDialogClosed">
    <section v-if="quote" class="claim-content" aria-label="确认领取角色">
      <header><span class="eyebrow">确认游戏内领取</span><h2>邀请 {{ quote.displayName }} 成为伙伴</h2></header>
      <p class="muted small">此操作会创建新的独立角色实例，不更改其他伙伴的身份。不包含现实货币支付。</p>
      <dl class="claim-breakdown">
        <div><dt>所需游戏金币</dt><dd>{{ quote.coinCost }}</dd></div>
        <div><dt>确认时余额</dt><dd>{{ quote.walletCoins }}</dd></div>
        <div><dt>预计领取后余额</dt><dd>{{ quote.walletCoins - quote.coinCost }}</dd></div>
        <div><dt>探索结算条件</dt><dd>{{ quote.unlockKind === 'STARTER' ? '初始角色' : `${quote.settledTrips} / ${quote.requiredSettledTrips} 次` }}</dd></div>
        <div><dt>目录版本</dt><dd>{{ quote.catalogVersion }}</dd></div>
      </dl>
      <p v-if="claimPending" class="claim-info" role="status">正在等待本地服务确认…</p>
      <p v-else-if="claimAttempted" class="claim-warning" role="alert">本次领取尚未确认。请关闭并刷新档案后重新选择，不会自动重复提交。</p>
      <p v-else-if="!claimPayload" class="claim-warning" role="status">当前游戏状态或目录版本已变化。请关闭窗口并重新确认最新领取条件。</p>
      <div class="claim-actions"><button type="button" class="button button-secondary" :disabled="claimPending" @click="closeQuote()">取消</button><button type="button" class="button button-primary" :disabled="!claimPayload || claimPending" @click="confirmAcquisition">确认领取 · {{ quote.coinCost }} 游戏金币</button></div>
    </section>
  </dialog>
</template>

<style scoped>
.owned-instance { min-width: 0; display: grid; gap: 8px; }
.nickname-form { padding: 11px; display: grid; gap: 7px; }
.nickname-form label { font-size: 11px; color: var(--gold); letter-spacing: .04em; }
.nickname-controls { display: flex; gap: 8px; align-items: center; }
.nickname-controls input { flex: 1; width: 100%; min-width: 0; background: #261f27; border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px; }
.nickname-controls input:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
.nickname-controls .button { min-height: 34px; white-space: nowrap; padding: 6px 9px; font-size: 11px; }
.nickname-note { font-size: 10px; color: var(--muted); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.nickname-note .text-button { padding: 1px 4px; font-size: 10px; color: var(--gold); }
.nickname-invalid { color: #e6a5a4; font-size: 11px; }
.template-intro { margin-top: 20px; flex-wrap: wrap; }
.catalog-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 15px; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.catalog-summary strong { color: var(--gold-light); margin: 0 2px; }
.template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 275px), 1fr)); align-items: stretch; gap: 15px; }
.template-placeholder { display: grid; justify-items: center; gap: 10px; padding: 28px 15px; text-align: center; }
.template-placeholder .icon { width: 29px; height: 29px; color: var(--gold); }
.template-placeholder h3 { font-size: 16px; }.template-placeholder p { color: var(--muted); font-size: 12px; }
.template-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px; padding: 11px; color: var(--muted); font-size: 12px; }
.claim-dialog { width: min(460px, calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; border-radius: 15px; border: 1px solid #93755d; background: #342b32; color: var(--text); box-shadow: 0 24px 55px #100911c9; }
.claim-dialog::backdrop { background: #110e17d9; }
.claim-content { display: grid; gap: 15px; padding: 19px; }
.claim-content h2 { font-size: 22px; margin-top: 4px; color: var(--gold-light); }
.claim-breakdown { margin: 0; display: grid; gap: 8px; padding: 14px; border: 1px solid var(--border); border-radius: 9px; background: #292229; }
.claim-breakdown > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.claim-breakdown dt { color: var(--muted); font-size: 12px; }.claim-breakdown dd { margin: 0; color: var(--gold-light); font-weight: 600; font-size: 13px; }
.claim-warning { color: #deb0a6; font-size: 12px; line-height: 1.7; }.claim-info { color: var(--muted); font-size: 12px; }
.claim-actions { display: flex; justify-content: flex-end; align-items: center; gap: 7px; flex-wrap: wrap; }
</style>
