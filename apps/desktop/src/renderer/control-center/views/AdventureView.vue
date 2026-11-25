<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { petStatus } from '../../shared/presentation';
import {
  confirmDeparture, createDepartureConfirmation, createTripPreparationPayload,
  suppliesText, travelDuration, travelItemLabel, travelReasonText, travelRiskLabel, travelSupplyCount,
} from '../../shared/travel-view-policy';
import type { DepartureConfirmation } from '../../shared/travel-view-policy';
import { useActiveTravelProjection, useDeparturePreview, useTravelCatalogProjection } from '../useTravelProjection';
import { useNow } from '../useNow';
import Icon from '../components/Icon.vue';
import TripCard from '../components/TripCard.vue';
import PetPortrait from '../../shared/PetPortrait.vue';

const context = useTravelCatalogProjection();
const { activeTravel, activeTravelFailed } = useActiveTravelProjection();
const travelNodeLabels = { GATHER: '采集', BATTLE: '战斗', EVENT: '事件' } as const;
const { store, generation, catalog, pending: catalogPending, queryError: catalogError, available, reload } = context;
const pets = computed(() => store.snapshot?.pets ?? []);
const activeTrips = computed(() => pets.value.filter(pet => pet.trip?.status === 'TRAVELING'));
const now = useNow();
const petId = ref('');
const routeId = ref('');
const drafts = ref<Map<string, string>>(new Map());
const selectedPet = computed(() => pets.value.find(pet => pet.petId === petId.value));
const selectedRoute = computed(() => catalog.value?.routes.find(route => route.routeId === routeId.value));

watch(generation, () => { petId.value = ''; routeId.value = ''; drafts.value.clear(); }, { flush: 'sync' });
watch([catalog, pets], ([current, currentPets]) => {
  if (!current) return;
  if (!current.routes.some(route => route.routeId === routeId.value)) routeId.value = current.routes[0]?.routeId ?? '';
  if (!currentPets.some(pet => pet.petId === petId.value)) {
    petId.value = currentPets.find(pet => pet.petId === store.snapshot?.primaryPetId)?.petId ?? currentPets[0]?.petId ?? '';
  }
}, { immediate: true });
watch(routeId, () => { drafts.value.clear(); }, { flush: 'sync' });
let lastRequirements: string | undefined;
watch(selectedRoute, (route) => {
  if (!route) return;
  const signature = JSON.stringify([route.routeId, route.contentVersion, route.requiredSupplies]);
  if (lastRequirements !== signature) { drafts.value.clear(); lastRequirements = signature; }
}, { flush: 'sync' });

function chooseRoute(id: string): void {
  if (catalog.value?.routes.some(route => route.routeId === id)) routeId.value = id;
}
function editSupply(itemId: string, event: Event): void {
  if (!(event.target instanceof HTMLInputElement) || !selectedRoute.value?.requiredSupplies.some(supply => supply.itemId === itemId)) return;
  drafts.value.set(itemId, event.target.value);
}
function fillSupplies(): void {
  if (!selectedRoute.value) return;
  drafts.value = new Map(selectedRoute.value.requiredSupplies.map(supply => [supply.itemId, String(supply.quantity)]));
}
const payload = computed(() => createTripPreparationPayload(catalog.value, store.snapshot, petId.value, routeId.value,
  [...drafts.value.entries()].map(([itemId, value]) => ({ itemId, value }))));
const draftKey = computed(() => JSON.stringify([petId.value, routeId.value, [...drafts.value.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
const { stamp, preview, stale, pending: previewPending, queryError: previewError, canPreview, requestPreview, invalidate } =
  useDeparturePreview(context, payload, draftKey);
const previewAllowed = computed(() => available.value && !previewPending.value);
const departureCandidate = computed(() => createDepartureConfirmation(stamp.value, generation.value, store.snapshot,
  catalog.value, payload.value, previewAllowed.value));

const confirmation = shallowRef<DepartureConfirmation | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const submitting = ref(false);
const attempted = ref(false);
const dialogError = ref<string | null>(null);
let disposed = false;
const confirmable = computed(() => confirmation.value !== null && !attempted.value && !submitting.value
  && confirmDeparture(confirmation.value, stamp.value, generation.value, store.snapshot, catalog.value, payload.value, previewAllowed.value) !== undefined);
function closeConfirmation(force = false): void {
  if (submitting.value && !force) return;
  confirmation.value = null;
  submitting.value = false; attempted.value = false;
  if (dialog.value?.open) dialog.value.close();
}
async function requestConfirmation(): Promise<void> {
  const fresh = createDepartureConfirmation(stamp.value, generation.value, store.snapshot, catalog.value, payload.value, previewAllowed.value);
  if (!fresh || submitting.value) return;
  dialogError.value = null; confirmation.value = fresh; attempted.value = false;
  await nextTick();
  if (disposed || confirmation.value !== fresh) return;
  try {
    if (!dialog.value) throw new Error('Missing departure dialog');
    if (!dialog.value.open) dialog.value.showModal();
  } catch { closeConfirmation(true); dialogError.value = '无法打开出发确认，请重新查询。'; }
}
function onDialogClosed(): void { if (confirmation.value && !dialog.value?.open) closeConfirmation(); }
function cancelDialog(event: Event): void { event.preventDefault(); closeConfirmation(); }
async function depart(): Promise<void> {
  const chosen = confirmation.value;
  if (!chosen || attempted.value || submitting.value) return;
  const intent = confirmDeparture(chosen, stamp.value, generation.value, store.snapshot, catalog.value, payload.value, previewAllowed.value);
  if (!intent) return;
  attempted.value = true; submitting.value = true;
  const success = await store.dispatch({ type: 'TRIP_START_PREPARED', payload: intent }, '出发已由本地服务确认。');
  if (disposed || confirmation.value !== chosen || generation.value !== chosen.generation) return;
  submitting.value = false; invalidate();
  if (success) { closeConfirmation(true); void context.refreshCatalog(); }
  else dialogError.value = '本次出发未确认；请刷新状态并重新选择。不会自动重复提交。';
}
watch([generation, draftKey], () => { closeConfirmation(true); dialogError.value = null; }, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; closeConfirmation(true); });
</script>

<template>
  <div class="page-intro panel">
    <span class="panel-symbol accent-blue"><Icon name="map" /></span>
    <div><span class="eyebrow">Expedition preparation</span><h2>探索路线与出发准备</h2><p>选择角色和路线、准备补给，查询由本地服务确认的出发条件。每次新旅程独立冻结战力、装备与路线版本。</p></div>
    <RouterLink to="/adventure/reports" class="button button-secondary">旅行报告 <Icon name="arrow" /></RouterLink>
  </div>
  <div v-if="catalogError || previewError || dialogError" class="feedback feedback-error" role="alert">
    <div><strong>暂时无法完成旅行准备</strong><p>{{ previewError ?? catalogError ?? dialogError }}</p></div>
    <button type="button" class="button button-secondary" :disabled="catalogPending || store.busy" @click="reload">刷新目录</button>
  </div>
  <section v-if="!catalog" class="panel empty-state" :aria-busy="catalogPending">
    <Icon name="map" /><h2>{{ catalogPending ? '正在读取实际路线…' : '等待路线目录' }}</h2>
    <p>未取得同一业务修订的路线目录前不提供模拟路线或直接开始旅行。</p>
    <button type="button" class="button button-primary" :disabled="catalogPending || store.loading || store.busy" @click="reload"><Icon name="refresh" />读取目录</button>
  </section>
  <template v-else>
    <section aria-labelledby="route-heading">
      <header class="section-heading"><div><span class="eyebrow">可探索地区</span><h2 id="route-heading">探索路线 <small>{{ catalog.routes.length }}</small></h2></div>
        <span class="subtle-tag">目录 v{{ catalog.routeCatalogVersion }}</span></header>
      <div class="route-selection-grid">
        <article v-for="route in catalog.routes" :key="route.routeId" class="panel route-option" :class="{ chosen: routeId === route.routeId }">
          <div class="route-decoration" :class="`risk-${route.risk.toLowerCase()}`" aria-hidden="true"><Icon name="map" /><span>✧</span><span>⋆</span></div>
          <div class="route-option-body">
            <div class="route-option-heading"><h3>{{ route.title }}</h3><span class="subtle-tag">{{ travelRiskLabel[route.risk] }}</span></div>
            <p class="small muted">{{ route.description }}</p>
            <dl class="route-stat-grid"><div><dt>建议等级</dt><dd>{{ route.minLevel }}–{{ route.recommendedMaxLevel }}</dd></div>
              <div><dt>全程时长</dt><dd>{{ travelDuration(route.durationMs) }}</dd></div>
              <div><dt>精力消耗</dt><dd>{{ route.energyCost10 / 10 }}</dd></div></dl>
            <p class="small muted">入场补给：{{ suppliesText(route.requiredSupplies) }}</p>
            <p class="small muted">可能掉落：{{ route.rewardItemIds.map(travelItemLabel).join('、') || '无已声明物品' }}</p>
            <p v-if="route.cgIds.length" class="small cg-note">可能记录 CG：{{ route.cgIds.join('、') }}，最终以服务结算为准。</p>
            <button type="button" class="button" :class="routeId === route.routeId ? 'button-primary' : 'button-secondary'"
              :aria-pressed="routeId === route.routeId" :disabled="store.busy || submitting" @click="chooseRoute(route.routeId)">
              {{ routeId === route.routeId ? '当前选中' : '选择路线' }}</button>
          </div>
        </article>
      </div>
    </section>
    <section class="panel preparation-panel page-section" aria-labelledby="prep-heading">
      <header class="section-heading"><div><span class="eyebrow">Prepare · 明确选择</span><h2 id="prep-heading">准备出发</h2></div>
        <button class="button button-secondary" type="button" :disabled="catalogPending || store.busy || store.loading" @click="reload"><Icon name="refresh" />{{ catalogPending ? '更新中…' : '刷新目录' }}</button></header>
      <div class="preparation-columns">
        <div class="preparation-block">
          <label for="travel-pet">选择出发角色</label>
          <select id="travel-pet" v-model="petId" :disabled="store.busy || submitting">
            <option v-if="pets.length === 0" value="">没有可选择角色</option>
            <option v-for="pet in pets" :key="pet.petId" :value="pet.petId">{{ pet.nickname }} · Lv.{{ pet.level }} · {{ petStatus(pet) }}</option>
          </select>
          <div v-if="selectedPet" class="travel-pet-summary">
            <span class="mini-portrait" aria-hidden="true"><PetPortrait :character-id="selectedPet.characterId" :paused="true" :away="selectedPet.presence !== 'HOME'" /></span>
            <div><strong>{{ selectedPet.nickname }}</strong><p class="small muted">{{ petStatus(selectedPet) }} · 实例 {{ selectedPet.petId }}</p><p class="small muted">精力 {{ selectedPet.energy }}/100 · 健康 {{ selectedPet.healthPoints }}/100</p></div>
          </div>
          <p v-else class="side-empty">请先领取角色，再准备出发。</p>
        </div>
        <div v-if="selectedRoute" class="preparation-block">
          <div><label>所选路线 · {{ selectedRoute.title }}</label><p class="small muted">补给数量须与入场要求匹配；仅为出发物资成本，不声明额外战斗收益。</p></div>
          <div v-if="selectedRoute.requiredSupplies.length" class="supply-list">
            <label v-for="supply in selectedRoute.requiredSupplies" :key="supply.itemId" class="supply-row">
              <span><strong>{{ travelItemLabel(supply.itemId) }}</strong><small class="muted">需求 {{ supply.quantity }} · 共享库存 {{ travelSupplyCount(catalog, supply.itemId) }}</small></span>
              <input type="number" inputmode="numeric" step="1" min="0" :max="supply.quantity" :value="drafts.get(supply.itemId) ?? '0'"
                :disabled="store.busy || submitting" :aria-label="`选择 ${travelItemLabel(supply.itemId)} 数量`" @input="editSupply(supply.itemId, $event)" />
            </label>
            <button type="button" class="button button-secondary" :disabled="store.busy || submitting" @click="fillSupplies">选齐所需补给</button>
            <RouterLink to="/shop" class="panel-link">补给不足？前往商店 <Icon name="arrow" /></RouterLink>
          </div>
          <p v-else class="side-empty">此路线无须选择或消耗补给。</p>
        </div>
      </div>
      <p v-if="selectedRoute && selectedPet && !payload && !catalogPending" class="supply-warning" role="status">补给选择或角色/路线条件无效。数量须是 0 到所需数量之间的整数。</p>
      <button class="button button-primary preview-button" type="button" :disabled="!canPreview || submitting" @click="requestPreview"><Icon name="report" />{{ previewPending ? '正在查询…' : '查询实际出发条件' }}</button>
      <section v-if="preview" class="preview-panel" :class="{ eligible: preview.eligible }" aria-label="本地服务出发报价">
        <div class="preview-heading"><div><span class="eyebrow">Authority preview</span><h3>{{ preview.eligible ? '当前符合出发条件' : '当前不能出发' }}</h3></div><span class="subtle-tag">修订 {{ preview.revision }}</span></div>
        <dl v-if="preview.route" class="preview-costs">
          <div><dt>路线</dt><dd>{{ preview.route.title }} · v{{ preview.route.contentVersion }}</dd></div>
          <div><dt>实际报价 · 精力</dt><dd>{{ preview.energyCost10 / 10 }}</dd></div>
          <div><dt>实际计划时长</dt><dd>{{ travelDuration(preview.durationMs) }}</dd></div>
          <div><dt>已选补给</dt><dd>{{ preview.selectedSupplies.length ? suppliesText(preview.selectedSupplies) : '未选择' }}</dd></div>
          <div><dt>拟扣补给</dt><dd>{{ preview.supplyConsumption.length === 0 && preview.route.requiredSupplies.length > 0 ? '选择尚不完整' : suppliesText(preview.supplyConsumption) }}</dd></div>
        </dl>
        <ul v-if="preview.reasons.length" class="preview-reasons"><li v-for="(reason, index) in preview.reasons" :key="index">{{ travelReasonText(reason) }}</li></ul>
        <p class="small muted">此查询不扣除物资。实际出发须再次确认，并由服务在同一事务重新核对。</p>
        <button type="button" class="button button-primary" :disabled="!departureCandidate || submitting" @click="requestConfirmation">确认出发条件</button>
      </section>
      <p v-else-if="stale" class="supply-warning" role="status">之前的出发报价与当前业务状态不再一致。请重新查询条件。</p>
      <p v-else-if="!previewPending" class="small muted">需要先查询本地服务的实际出发条件，不能直接使用旧路线或客户端推算成本出发。</p>
    </section>
  </template>
  <section aria-labelledby="active-heading" class="page-section">
    <header class="section-heading"><div><span class="eyebrow">归家倒计时</span><h2 id="active-heading">当前旅行</h2></div><RouterLink to="/adventure/reports" class="panel-link">旅行报告 <Icon name="arrow" /></RouterLink></header>
    <div v-if="activeTrips.length" class="panel trip-list">
      <div v-for="pet in activeTrips" :key="pet.petId">
        <TripCard :pet="pet" :now="now" />
        <template v-for="trip in activeTravel?.rows.filter(row => row.petId === pet.petId)" :key="trip.tripId">
          <ol class="journey-steps" :aria-label="`${pet.nickname}的旅行路线`">
            <li v-for="(node, index) in trip.nodes" :key="node.nodeId"
              :aria-current="trip.phase === 'OUTBOUND' && index === trip.nodeIndex ? 'step' : undefined">
              {{ travelNodeLabels[node.kind] }} · {{ index < trip.nodeIndex ? '已结算'
                : trip.phase === 'RETURNING' ? '未到达' : index === trip.nodeIndex ? '进行中' : '待经过' }}
            </li>
          </ol>
          <small v-if="trip.phase === 'RETURNING'" class="muted">已踏上归途</small>
        </template>
      </div>
      <small v-if="activeTravelFailed" class="muted" role="status">暂时无法读取路线节点，仍可查看归家时间。</small>
    </div>
    <div v-else class="panel empty-state compact-empty"><Icon name="map" /><h3>{{ store.snapshot ? '此刻没有进行中的旅行' : '等待旅行快照' }}</h3><p>出发后会显示服务确认的预计归家时间；到达该时间后仍需等待服务确认结算。</p></div>
  </section>
  <dialog ref="dialog" class="departure-dialog" aria-labelledby="departure-title" @cancel="cancelDialog" @close="onDialogClosed">
    <section v-if="confirmation" class="departure-dialog-content">
      <header><span class="eyebrow">旅行出发 · 消耗确认</span><h2 id="departure-title">确认踏上 {{ confirmation.title }}</h2></header>
      <dl class="departure-rows">
        <div><dt>角色</dt><dd>{{ confirmation.petName }}（{{ confirmation.payload.petId }}）</dd></div>
        <div><dt>当前精力</dt><dd>{{ confirmation.energyNow }}</dd></div>
        <div><dt>消耗精力</dt><dd>{{ confirmation.energyCost10 / 10 }}</dd></div>
        <div><dt>预计剩余精力</dt><dd>{{ Math.round((confirmation.energyNow - confirmation.energyCost10 / 10) * 10) / 10 }}</dd></div>
        <div><dt>消耗补给</dt><dd>{{ suppliesText(confirmation.supplies) }}</dd></div>
        <div><dt>计划时长</dt><dd>{{ travelDuration(confirmation.durationMs) }}</dd></div>
        <div><dt>路线内容版本 / 目录版本</dt><dd>{{ confirmation.routeContentVersion }} / {{ confirmation.catalogVersion }}</dd></div>
        <div><dt>确认状态修订</dt><dd>{{ confirmation.revision }}</dd></div>
      </dl>
      <p class="supply-warning">只有本地服务确认后才扣除物资、生成旅行与冻结战力。提前召回或其他结果由旅行规则结算；此次出发不是物资产出的保证。</p>
      <p v-if="submitting" role="status" class="small muted">正在等待本地服务确认…</p>
      <p v-else-if="attempted" role="alert" class="supply-warning">出发尚未确认，请关闭并重新查询，不会自动重复提交。</p>
      <p v-else-if="!confirmable" role="status" class="supply-warning">当前状态或实际报价已变化，请关闭后重新查询条件。</p>
      <div class="departure-controls"><button type="button" class="button button-secondary" :disabled="submitting" @click="closeConfirmation()">取消</button>
        <button type="button" class="button button-primary" :disabled="!confirmable || submitting" @click="depart">确认消耗并出发</button></div>
    </section>
  </dialog>
</template>

<style scoped>
.journey-steps { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 8px 0 12px; padding-inline-start: 24px; font-size: .85rem; }
.journey-steps [aria-current='step'] { font-weight: 650; }
.route-selection-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 14px; align-items: stretch; }
.route-option { overflow: hidden; display: flex; flex-direction: column; border-color: var(--border); }
.route-option.chosen { border-color: #a6805e; box-shadow: 0 4px 22px #a6805e24; }
.route-decoration { min-height: 66px; display: flex; justify-content: center; align-items: center; position: relative; overflow: hidden; color: #f2deb2; background: #496354; }
.route-decoration.risk-medium { background: linear-gradient(120deg, #355149, #5b7673); }
.route-decoration.risk-high { background: linear-gradient(120deg, #494154, #76647b); }
.route-decoration::before { content: ''; width: 96px; height: 96px; border: 1px solid #f6d9ad66; border-radius: 50%; box-shadow: 0 0 0 12px #f6d9ad19; position: absolute; }
.route-decoration .icon { width: 30px; height: 30px; z-index: 1; }
.route-decoration > span { font-size: 13px; margin: 0 12px; }
.route-option-body { padding: 14px; display: grid; gap: 10px; align-content: start; flex: 1; overflow-wrap: anywhere; }
.route-option-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.route-stat-grid { margin: 0; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 5px; }
.route-stat-grid > div { background: #292229; border: 1px solid var(--border-subtle); border-radius: 7px; padding: 8px; }
.route-stat-grid dt { color: var(--muted); font-size: 10px; }
.route-stat-grid dd { color: var(--gold-light); font-size: 11px; font-weight: 630; margin: 4px 0 0; }
.cg-note { color: #d8b9d8; }
.preparation-panel { display: grid; gap: 14px; padding: 17px; }
.preparation-columns { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.preparation-block { padding: 13px; display: grid; align-content: start; gap: 10px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: #292229; }
.preparation-block label { color: var(--gold-light); font-size: 12px; font-weight: 620; }
.preparation-block select, .preparation-block input { min-width: 0; background: #261f27; border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px; }
.preparation-block select:focus-visible, .preparation-block input:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.travel-pet-summary { display: flex; align-items: center; gap: 11px; }
.travel-pet-summary > div { min-width: 0; overflow-wrap: anywhere; }
.travel-pet-summary .mini-portrait { width: 55px; height: 60px; flex: 0 0 auto; }
.supply-list { display: grid; gap: 8px; }
.supply-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.supply-row span { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.supply-row small { font-size: 10px; }
.supply-row input { width: 68px; flex: 0 0 auto; }
.preview-button { width: fit-content; justify-self: end; }
.preview-panel { border: 1px solid #7b5a43; background: #3d2e2a; border-radius: 11px; display: grid; gap: 12px; padding: 14px; }
.preview-panel.eligible { border-color: #58775c; background: #2e3c34; }
.preview-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 7px; }
.preview-heading h3 { font-size: 16px; margin-top: 4px; }
.preview-costs, .departure-rows { margin: 0; display: grid; gap: 7px; }
.preview-costs > div, .departure-rows > div { display: grid; grid-template-columns: minmax(85px,.8fr) minmax(0,1.3fr); gap: 10px; align-items: baseline; font-size: 12px; }
.preview-costs dt, .departure-rows dt { color: var(--muted); }
.preview-costs dd, .departure-rows dd { color: var(--gold-light); margin: 0; overflow-wrap: anywhere; font-weight: 620; text-align: right; }
.preview-reasons { margin: 0; padding: 0 0 0 19px; color: #f0c4a5; font-size: 12px; line-height: 1.65; }
.supply-warning { color: #f0c4a5; background: #49332d; border: 1px solid #76523f; padding: 9px 11px; border-radius: 7px; font-size: 12px; line-height: 1.65; }
.departure-dialog { width: min(490px, calc(100vw - 24px)); max-height: calc(100vh - 24px); border: 1px solid #93755d; background: #342b32; color: var(--text); border-radius: 15px; padding: 0; }
.departure-dialog::backdrop { background: #110e17db; }
.departure-dialog-content { display: grid; gap: 14px; padding: 18px; }
.departure-dialog-content h2 { color: var(--gold-light); font-size: 20px; margin-top: 4px; }
.departure-rows { background: #292229; border: 1px solid var(--border); border-radius: 9px; padding: 13px; }
.departure-controls { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
@media (max-width: 690px) { .preparation-columns { grid-template-columns: 1fr; } }
</style>
