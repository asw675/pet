<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { EquipmentSlot, InventoryEquipmentInstance } from '@pet-desktop/contracts/inventory';
import {
  availableEquipmentDefinition, declaredEffectText, equipmentName, equipmentSlots, equippedPetName,
  itemKindLabel, itemUseBlockReason, legacyPageOffset, materialText, rarityLabel, slotLabel, stackDefinition, statsText,
} from '../../shared/inventory-view-policy';
import PetPortrait from '../../shared/PetPortrait.vue';
import Icon from '../components/Icon.vue';
import InventoryConfirmDialog from '../components/InventoryConfirmDialog.vue';
import { useInventoryProjection } from '../useInventoryProjection';

const {
  store, generation, page, pending, queryError, allowCommands, reload, changeLegacyPage, quote,
  attempted, executing, confirmable, quoteFor, beginQuote, confirmQuote, closeQuote, onModalError,
} = useInventoryProjection();
const selectedPetId = ref('');
watch(generation, () => { selectedPetId.value = ''; }, { flush: 'sync' });
watch(page, current => {
  if (!current || current.pets.some(pet => pet.petId === selectedPetId.value)) return;
  selectedPetId.value = current.pets.find(pet => pet.petId === store.snapshot?.primaryPetId)?.petId ?? current.pets[0]?.petId ?? '';
}, { immediate: true });
const selectedPet = computed(() => page.value?.pets.find(pet => pet.petId === selectedPetId.value));
const actualPet = computed(() => store.snapshot?.pets.find(pet => pet.petId === selectedPetId.value));
const loadout = computed(() => equipmentSlots.map(slot => {
  const equipped = selectedPet.value?.equipped.find(value => value.slot === slot);
  return { slot, instance: equipped ? page.value?.instances.find(instance => instance.instanceId === equipped.instanceId) : undefined };
}));
const stats = computed(() => {
  const values = selectedPet.value?.stats;
  return values ? [['HP', values.hp], ['ATK', values.atk], ['DEF', values.def], ['SPD', values.spd], ['LUK', values.luk]] : [];
});

const search = ref('');
const stackFilter = ref<'ALL' | 'MATERIAL' | 'CONSUMABLE' | 'GIFT' | 'LEGACY'>('ALL');
const slotFilter = ref<'ALL' | EquipmentSlot>('ALL');
const pageSize = 9;
const stackPage = ref(0);
const equipmentPage = ref(0);
const termMatches = (...values: string[]): boolean => {
  const query = search.value.trim().toLocaleLowerCase();
  return query === '' || values.some(value => value.toLocaleLowerCase().includes(query));
};
const stacks = computed(() => {
  const current = page.value;
  if (!current) return [];
  return current.stacks.map(stack => ({ stack, item: stackDefinition(current, stack) })).filter(({ stack, item }) => {
    if (stackFilter.value === 'LEGACY' ? stack.definitionState !== 'LEGACY_UNKNOWN'
      : stackFilter.value !== 'ALL' && item?.kind !== stackFilter.value) return false;
    return termMatches(stack.itemId, item?.displayName ?? '');
  });
});
const instances = computed(() => {
  const current = page.value;
  if (!current) return [];
  return current.instances.map(instance => ({ instance, definition: availableEquipmentDefinition(current, instance) })).filter(({ instance, definition }) => {
    const slot = definition?.equipment.slot ?? instance.equipped?.slot;
    return (slotFilter.value === 'ALL' || slotFilter.value === slot)
      && termMatches(instance.instanceId, instance.definitionId, equipmentName(current, instance));
  });
});
const stackPageCount = computed(() => Math.max(1, Math.ceil(stacks.value.length / pageSize)));
const equipmentPageCount = computed(() => Math.max(1, Math.ceil(instances.value.length / pageSize)));
const visibleStacks = computed(() => stacks.value.slice(stackPage.value * pageSize, (stackPage.value + 1) * pageSize));
const visibleInstances = computed(() => instances.value.slice(equipmentPage.value * pageSize, (equipmentPage.value + 1) * pageSize));
watch([generation, search, stackFilter], () => { stackPage.value = 0; });
watch([generation, search, slotFilter], () => { equipmentPage.value = 0; });
watch(stackPageCount, count => { stackPage.value = Math.min(stackPage.value, count - 1); });
watch(equipmentPageCount, count => { equipmentPage.value = Math.min(equipmentPage.value, count - 1); });

function equip(instance: InventoryEquipmentInstance): void {
  if (selectedPet.value) beginQuote({ type: 'EQUIPMENT_EQUIP', petId: selectedPet.value.petId, instanceId: instance.instanceId });
}
function unequip(instance: InventoryEquipmentInstance): void {
  if (instance.equipped) beginQuote({ type: 'EQUIPMENT_UNEQUIP', petId: instance.equipped.petId, slot: instance.equipped.slot });
}
function canEquip(instance: InventoryEquipmentInstance): boolean {
  return !!selectedPet.value && !!quoteFor({ type: 'EQUIPMENT_EQUIP', petId: selectedPet.value.petId, instanceId: instance.instanceId });
}
function canUnequip(instance: InventoryEquipmentInstance): boolean {
  return !!instance.equipped && !!quoteFor({ type: 'EQUIPMENT_UNEQUIP', petId: instance.equipped.petId, slot: instance.equipped.slot });
}
function useItem(itemId: string): void {
  if (selectedPet.value) beginQuote({ type: 'ITEM_USE', petId: selectedPet.value.petId, itemId });
}
function canUse(itemId: string): boolean {
  return !!selectedPet.value && !!quoteFor({ type: 'ITEM_USE', petId: selectedPet.value.petId, itemId });
}
function navigateLegacy(direction: -1 | 1): void {
  stackFilter.value = 'LEGACY';
  stackPage.value = 0;
  changeLegacyPage(direction);
}
</script>

<template>
  <div class="page-intro panel">
    <span class="panel-symbol accent-blue"><Icon name="bag" /></span>
    <div><span class="eyebrow">Shared inventory · 装备与物品</span><h2>共享背包</h2><p>库存、实例、角色属性和强化报价均来自本地服务；背包操作不重新计算已经出发的旅程。</p></div>
    <RouterLink class="button button-secondary" to="/shop"><Icon name="shop" />前往商店</RouterLink>
  </div>
  <div v-if="queryError" class="feedback feedback-error" role="alert">
    <div><strong>无法更新背包档案</strong><p>{{ queryError }}</p></div>
    <button type="button" class="button button-secondary" :disabled="pending || store.busy" @click="reload">重新查询</button>
  </div>
  <section v-if="!page" class="panel empty-state" :aria-busy="pending">
    <Icon name="bag" /><h2>{{ pending ? '正在读取共享背包…' : '等待一致的背包档案' }}</h2>
    <p>没有取得同一业务修订的实际库存前，不显示模拟物品或开放操作。</p>
    <button type="button" class="button button-primary" :disabled="pending || store.loading || store.busy" @click="reload"><Icon name="refresh" />刷新档案</button>
  </section>
  <template v-else>
    <div class="inventory-summary panel">
      <div><span class="small muted">金币</span><strong>{{ page.walletCoins }}</strong></div>
      <div><span class="small muted">可识别物品种类</span><strong>{{ page.stacks.filter(item => item.definitionState === 'AVAILABLE' && item.quantity > 0).length }}</strong></div>
      <div><span class="small muted">装备实例</span><strong>{{ page.instances.length }}</strong></div>
      <div><span class="small muted">目录版本</span><strong>v{{ page.catalogVersion }}</strong></div>
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || store.loading" @click="reload"><Icon name="refresh" />{{ pending ? '更新中…' : '刷新背包' }}</button>
    </div>

    <section class="panel loadout-panel">
      <div class="section-heading"><div><span class="eyebrow">Companion equipment</span><h2>角色属性和装备</h2></div>
        <label class="pet-select"><span>选择角色</span><select v-model="selectedPetId" :disabled="pending || store.busy">
          <option v-if="page.pets.length === 0" value="">暂无角色</option>
          <option v-for="pet in page.pets" :key="pet.petId" :value="pet.petId">{{ pet.nickname }} · Lv.{{ pet.progression.level }}</option>
        </select></label>
      </div>
      <template v-if="selectedPet && actualPet">
        <div class="loadout-body">
          <div class="loadout-portrait">
            <PetPortrait :character-id="selectedPet.characterId" :away="actualPet.presence !== 'HOME'" :paused="!!store.snapshot?.pausedRender" />
            <span class="level-badge">Lv.{{ selectedPet.progression.level }}</span>
          </div>
          <div class="loadout-info">
            <h3>{{ selectedPet.nickname }} <span class="subtle-tag">{{ actualPet.presence === 'HOME' ? '在家' : '旅行中' }}</span></h3>
            <div class="loadout-power">战斗力 <strong>{{ selectedPet.battlePower }}</strong><span class="muted small">好感阶段 {{ selectedPet.bondStage }}</span></div>
            <div v-if="stats.length" class="loadout-stats"><div v-for="[name, value] in stats" :key="name"><small>{{ name }}</small><strong>{{ value }}</strong></div></div>
            <p v-else class="muted small">历史角色属性暂不可用，未用现行数据替换其档案。</p>
            <template v-if="selectedPet.progression.xpRequiredForNextLevel !== null">
              <progress :value="selectedPet.progression.xpInLevel" :max="selectedPet.progression.xpRequiredForNextLevel" aria-label="当前等级经验进度"></progress>
              <p class="small muted">本级经验 {{ selectedPet.progression.xpInLevel }} / {{ selectedPet.progression.xpRequiredForNextLevel }} · 累计 {{ selectedPet.progression.cumulativeXp }}</p>
            </template>
            <p v-else class="small muted">已达到当前规则等级上限 · 累计经验 {{ selectedPet.progression.cumulativeXp }}</p>
            <p v-if="actualPet.presence !== 'HOME'" class="small travel-note">可以准备下一程装备；当前旅程的战斗快照保持不变。物品使用需要角色在家。</p>
          </div>
        </div>
        <div class="loadout-slots">
          <article v-for="entry in loadout" :key="entry.slot" class="slot-card">
            <strong>{{ slotLabel[entry.slot] }}</strong>
            <template v-if="entry.instance">
              <span>{{ equipmentName(page, entry.instance) }} +{{ entry.instance.enhancement }}</span>
              <small class="muted">{{ statsText(entry.instance.bonus) }}</small>
              <button type="button" class="button button-secondary" :disabled="!canUnequip(entry.instance)" @click="unequip(entry.instance)">卸下</button>
            </template>
            <p v-else class="muted small">空槽位</p>
          </article>
        </div>
      </template>
      <p v-else class="side-empty">请选择已有角色，或先在宠物馆领取角色。</p>
    </section>

    <div class="inventory-search">
      <label><span>筛选物品或装备</span><input v-model="search" maxlength="80" type="search" placeholder="物品名 / 实例 ID" /></label>
    </div>
    <section class="inventory-section">
      <header class="section-heading inventory-filter"><div><span class="eyebrow">Material and supplies</span><h2>物品 <small>{{ stacks.length }} 项</small></h2></div>
        <label><span>类别</span><select v-model="stackFilter">
          <option value="ALL">全部</option><option value="MATERIAL">材料</option><option value="CONSUMABLE">消耗品</option>
          <option value="GIFT">礼物</option><option value="LEGACY">历史未识别</option>
        </select></label>
      </header>
      <aside v-if="page.legacyStackTotal > 0" class="panel archive-toolbar">
        <div><strong>历史存档 · {{ page.legacyStackTotal }} 项</strong><p class="muted small">本次查询显示历史记录 {{ page.legacyStackOffset + 1 }}–{{ page.legacyStackOffset + page.stacks.filter(row => row.definitionState === 'LEGACY_UNKNOWN').length }}。可识别库存始终完整返回；旧档不占用现行物品容量，也不借用现行定义。</p></div>
        <div class="archive-actions">
          <button type="button" class="button button-secondary" :disabled="pending || store.busy || legacyPageOffset(page, -1) === undefined" @click="navigateLegacy(-1)">历史上一页</button>
          <button type="button" class="button button-secondary" :disabled="pending || store.busy || legacyPageOffset(page, 1) === undefined" @click="navigateLegacy(1)">历史下一页</button>
        </div>
      </aside>
      <div v-if="visibleStacks.length" class="inventory-grid">
        <article v-for="{ stack, item } in visibleStacks" :key="stack.itemId" class="panel item-card">
          <div class="item-card-heading"><span class="panel-symbol" :class="{ 'accent-rose': item?.kind === 'GIFT', 'accent-blue': item?.kind === 'CONSUMABLE' }"><Icon :name="item?.kind === 'GIFT' ? 'heart' : 'bag'" /></span>
            <div><h3>{{ item?.displayName ?? stack.itemId }}</h3><span class="small muted">{{ item ? itemKindLabel[item.kind] : '历史未识别物品' }}</span></div>
            <strong class="quantity">×{{ stack.quantity }}</strong></div>
          <p class="muted small">{{ item?.description ?? '保留原始库存身份，未使用现行定义替代历史物品。' }}</p>
          <p v-if="item" class="effect-label">{{ declaredEffectText(item) }}</p>
          <template v-if="item?.kind === 'CONSUMABLE' || item?.kind === 'GIFT'">
            <button type="button" class="button button-primary" :disabled="!canUse(stack.itemId)" @click="useItem(stack.itemId)">{{ item.kind === 'GIFT' ? '赠送给当前角色' : '为当前角色使用' }}</button>
            <span v-if="itemUseBlockReason(item, actualPet, stack.quantity)" class="muted small">{{ itemUseBlockReason(item, actualPet, stack.quantity) }}</span>
          </template>
          <span v-else-if="stack.definitionState === 'LEGACY_UNKNOWN'" class="muted small">暂不可使用或转换。</span>
          <span v-else class="muted small">保存在共享仓库，无直接使用操作。</span>
        </article>
      </div>
      <div v-else class="panel compact-empty empty-state"><Icon name="bag" /><p>没有符合筛选条件的实际库存物品。</p></div>
      <div v-if="stackPageCount > 1" class="inventory-paging"><button type="button" class="button button-secondary" :disabled="stackPage === 0" @click="stackPage--">上一页</button>
        <span>{{ stackPage + 1 }} / {{ stackPageCount }}</span><button type="button" class="button button-secondary" :disabled="stackPage + 1 >= stackPageCount" @click="stackPage++">下一页</button></div>
    </section>

    <section class="inventory-section">
      <header class="section-heading inventory-filter"><div><span class="eyebrow">Individual equipment instances</span><h2>装备实例 <small>{{ instances.length }} 件</small></h2></div>
        <label><span>槽位</span><select v-model="slotFilter"><option value="ALL">全部槽位</option><option v-for="slot in equipmentSlots" :key="slot" :value="slot">{{ slotLabel[slot] }}</option></select></label>
      </header>
      <div v-if="visibleInstances.length" class="inventory-grid">
        <article v-for="{ instance, definition } in visibleInstances" :key="instance.instanceId" class="panel item-card equipment-card">
          <header class="item-card-heading"><span class="panel-symbol accent-blue"><Icon name="spark" /></span><div><h3>{{ equipmentName(page, instance) }} +{{ instance.enhancement }}</h3>
            <span v-if="definition" class="small muted">{{ rarityLabel[definition.rarity] }} · {{ slotLabel[definition.equipment.slot] }}</span><span v-else class="small muted">历史定义暂不可用</span></div></header>
          <span class="instance-id">{{ instance.instanceId }}</span>
          <p class="small muted">归属：{{ equippedPetName(page, instance) }}</p>
          <p v-if="instance.bonus" class="effect-label">{{ statsText(instance.bonus) }}</p>
          <div class="instance-quote">
            <p v-if="instance.upgrade.ok">强化 +{{ instance.upgrade.toEnhancement }}：{{ instance.upgrade.cost.coins }} 金币 · {{ materialText(page, instance.upgrade.cost.materials) }}</p>
            <p v-else>{{ instance.upgrade.reason === 'MAX_ENHANCEMENT' ? '已达强化上限' : '强化报价不可用' }}</p>
            <p v-if="instance.upgrade.ok && !instance.upgrade.affordable" class="quote-unavailable">金币或材料不足</p>
            <p v-if="instance.salvage.canSalvage">分解产出：{{ materialText(page, instance.salvage.materials) }}</p>
            <p v-else-if="instance.equipped">请先卸下，再考虑分解。</p>
          </div>
          <div class="equipment-actions">
            <button v-if="!instance.equipped" type="button" class="button button-primary" :disabled="!canEquip(instance)" @click="equip(instance)">穿戴给当前角色</button>
            <button v-else type="button" class="button button-secondary" :disabled="!canUnequip(instance)" @click="unequip(instance)">卸下</button>
            <button type="button" class="button button-secondary" :disabled="!quoteFor({ type: 'EQUIPMENT_UPGRADE', instanceId: instance.instanceId })"
              @click="beginQuote({ type: 'EQUIPMENT_UPGRADE', instanceId: instance.instanceId })">强化</button>
            <button type="button" class="button button-secondary danger" :disabled="!quoteFor({ type: 'EQUIPMENT_SALVAGE', instanceId: instance.instanceId })"
              @click="beginQuote({ type: 'EQUIPMENT_SALVAGE', instanceId: instance.instanceId })">分解</button>
          </div>
        </article>
      </div>
      <div v-else class="panel compact-empty empty-state"><Icon name="spark" /><p>没有符合条件的装备实例。从商店购买时会创建独立装备。</p>
        <RouterLink class="button button-secondary" to="/shop">查看商店</RouterLink></div>
      <div v-if="equipmentPageCount > 1" class="inventory-paging"><button type="button" class="button button-secondary" :disabled="equipmentPage === 0" @click="equipmentPage--">上一页</button>
        <span>{{ equipmentPage + 1 }} / {{ equipmentPageCount }}</span><button type="button" class="button button-secondary" :disabled="equipmentPage + 1 >= equipmentPageCount" @click="equipmentPage++">下一页</button></div>
    </section>
    <p v-if="!allowCommands" class="muted small" role="status">正在等待最新业务状态，库存操作暂不可用。</p>
  </template>
  <InventoryConfirmDialog :quote="quote" :attempted="attempted" :executing="executing" :confirmable="confirmable"
    @confirm="confirmQuote" @cancel="closeQuote()" @modal-error="onModalError" />
</template>

<style scoped>
.inventory-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 12px; align-items: center; padding: 16px; margin-bottom: 19px; }
.inventory-summary strong, .inventory-summary span { display: block; overflow-wrap: anywhere; }
.inventory-summary strong { font-size: 17px; font-variant-numeric: tabular-nums; margin-top: 5px; color: var(--gold-light); }
.loadout-panel { display: grid; gap: 15px; padding: 17px; margin-bottom: 18px; }
.loadout-panel .section-heading { margin-bottom: 0; align-items: center; flex-wrap: wrap; }
.pet-select, .inventory-filter label, .inventory-search label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
select, input { min-width: 0; background: #271f29; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
select:focus-visible, input:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.loadout-body { display: grid; grid-template-columns: minmax(94px, 155px) minmax(0, 1fr); gap: 15px; background: #2a222a; border: 1px solid var(--border-subtle); border-radius: 12px; padding: 10px; }
.loadout-portrait { display: grid; place-items: center; position: relative; background: radial-gradient(circle, #65515d, #3b303b); border: 1px solid #594650; border-radius: 11px; padding: 4px; }
.loadout-portrait :deep(.portrait) { max-width: 130px; height: 116px; }
.loadout-portrait .level-badge { position: absolute; bottom: 4px; right: 5px; }
.loadout-info { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 3px; }
.loadout-info h3 { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; overflow-wrap: anywhere; }
.loadout-power { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--muted); }
.loadout-power strong { color: var(--gold-light); font-size: 20px; }
.loadout-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; }
.loadout-stats > div { display: grid; gap: 5px; padding: 7px; background: #382c36; border-radius: 8px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.loadout-stats small { color: var(--blue); }
.loadout-stats strong { color: #e1d7e5; }
.travel-note { color: #dfc9a5; }
.loadout-slots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.slot-card { padding: 12px; display: grid; gap: 7px; min-width: 0; background: #292229; border-radius: 10px; border: 1px solid var(--border); }
.slot-card > strong { color: var(--gold); font-size: 12px; }
.slot-card > span, .slot-card > small { overflow-wrap: anywhere; }
.slot-card .button { min-height: 28px; }
.inventory-search { display: flex; flex-wrap: wrap; margin: 24px 0 16px; }
.inventory-filter { align-items: center; }
.inventory-section { margin: 24px 0; }
.archive-toolbar { padding: 10px 13px; margin-bottom: 12px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 9px; }
.archive-toolbar strong { color: var(--gold); font-size: 12px; }
.archive-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.archive-actions .button { min-height: 30px; }
.inventory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 12px; align-items: stretch; }
.item-card { display: grid; align-content: start; gap: 10px; padding: 14px; min-width: 0; overflow-wrap: anywhere; }
.item-card-heading { display: flex; align-items: center; gap: 9px; min-width: 0; }
.item-card-heading h3 { font-size: 14px; }
.item-card-heading > div { flex: 1; min-width: 0; }
.quantity { color: var(--gold-light); font-variant-numeric: tabular-nums; }
.effect-label { font-size: 11px; color: #b7cee3; background: #32313c; border: 1px solid #494b61; border-radius: 7px; padding: 8px; line-height: 1.55; }
.instance-id { font-size: 10px; color: var(--faded); }
.instance-quote { font-size: 11px; line-height: 1.65; color: var(--gold); display: grid; gap: 3px; }
.quote-unavailable { color: #e0a4a2; }
.equipment-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.equipment-actions .button { min-height: 31px; flex: 1 1 auto; padding: 8px; }
.danger { color: #eab5b3; border-color: #83514e; }
.inventory-paging { margin: 12px 0 0; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 12px; color: var(--muted); }
@media (max-width: 680px) {
  .inventory-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .inventory-summary .button { grid-column: 1 / -1; }
  .loadout-body { grid-template-columns: 100px minmax(0, 1fr); }
  .loadout-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .loadout-slots { grid-template-columns: 1fr; }
}
@media (max-width: 430px) {
  .loadout-body { grid-template-columns: 1fr; }
  .loadout-portrait { max-height: 130px; }
  .inventory-filter { flex-wrap: wrap; }
  .archive-toolbar { grid-template-columns: 1fr; }
}
</style>
