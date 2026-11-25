<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ItemDefinition, ShopOffer } from '@pet-desktop/contracts/inventory';
import {
  declaredEffectText, itemDefinition, itemKindLabel, parsePurchaseQuantity, purchaseTotal, rarityLabel, stockCount,
} from '../../shared/inventory-view-policy';
import Icon from '../components/Icon.vue';
import InventoryConfirmDialog from '../components/InventoryConfirmDialog.vue';
import { useInventoryProjection } from '../useInventoryProjection';

const {
  store, generation, page, pending, queryError, allowCommands, reload, quote,
  attempted, executing, confirmable, quoteFor, beginQuote, confirmQuote, closeQuote, onModalError,
} = useInventoryProjection();
const search = ref('');
const category = ref<'ALL' | ItemDefinition['kind']>('ALL');
const drafts = ref<Map<string, string>>(new Map());
const pageIndex = ref(0);
const pageSize = 9;
watch([generation, () => page.value?.catalogVersion ?? null], () => {
  drafts.value.clear(); pageIndex.value = 0;
}, { flush: 'sync' });
watch([search, category], () => { pageIndex.value = 0; });

const offers = computed(() => {
  const current = page.value;
  if (!current) return [];
  const query = search.value.trim().toLocaleLowerCase();
  return current.offers.flatMap(offer => {
    const item = itemDefinition(current, offer.itemId);
    if (!item || (category.value !== 'ALL' && item.kind !== category.value)
      || (query && ![item.itemId, item.displayName, item.description].some(value => value.toLocaleLowerCase().includes(query)))) return [];
    const held = item.kind === 'EQUIPMENT'
      ? current.instances.filter(instance => instance.definitionId === item.itemId && instance.definitionVersion === current.catalogVersion).length
      : stockCount(current, item.itemId);
    return [{ offer, item, held }];
  });
});
const pageCount = computed(() => Math.max(1, Math.ceil(offers.value.length / pageSize)));
const visibleOffers = computed(() => offers.value.slice(pageIndex.value * pageSize, (pageIndex.value + 1) * pageSize));
watch(pageCount, count => { pageIndex.value = Math.min(pageIndex.value, count - 1); });

function quantityText(offer: ShopOffer): string {
  return drafts.value.get(offer.offerId) ?? String(offer.minQuantity);
}
function editQuantity(offer: ShopOffer, event: Event): void {
  if (!(event.target instanceof HTMLInputElement) || !page.value?.offers.some(candidate => candidate.offerId === offer.offerId)) return;
  drafts.value.set(offer.offerId, event.target.value);
}
const quantity = (offer: ShopOffer): number | undefined => parsePurchaseQuantity(quantityText(offer), offer);
function total(offer: ShopOffer): number | undefined {
  const count = quantity(offer);
  return count === undefined ? undefined : purchaseTotal(offer, count);
}
function canBuy(offer: ShopOffer): boolean {
  const count = quantity(offer);
  return count !== undefined && !!quoteFor({ type: 'SHOP_PURCHASE', offerId: offer.offerId, quantity: count });
}
function buy(offer: ShopOffer): void {
  const count = quantity(offer);
  if (count !== undefined) beginQuote({ type: 'SHOP_PURCHASE', offerId: offer.offerId, quantity: count });
}
function purchaseIssue(offer: ShopOffer): string | undefined {
  if (quantity(offer) === undefined) return `数量须为 ${offer.minQuantity}–${offer.maxQuantity} 的整数。`;
  const cost = total(offer);
  if (cost === undefined) return '报价超出安全数值范围。';
  if (page.value && cost > page.value.walletCoins) return '当前游戏金币不足。';
  if (allowCommands.value && !canBuy(offer)) return '当前背包容量或商品条件不满足。';
  return undefined;
}
</script>

<template>
  <div class="page-intro panel">
    <span class="panel-symbol accent-rose"><Icon name="shop" /></span>
    <div><span class="eyebrow">Game shop · 本地商店</span><h2>旅行商店</h2><p>补给、礼物与装备使用共享游戏金币购买，不涉及现实货币、支付平台或自动扣款。</p></div>
    <RouterLink class="button button-secondary" to="/inventory"><Icon name="bag" />查看共享背包</RouterLink>
  </div>
  <div v-if="queryError" role="alert" class="feedback feedback-error">
    <div><strong>无法更新商店档案</strong><p>{{ queryError }}</p></div>
    <button type="button" class="button button-secondary" :disabled="pending || store.busy" @click="reload">重新查询</button>
  </div>
  <section v-if="!page" class="panel empty-state" :aria-busy="pending">
    <Icon name="shop" /><h2>{{ pending ? '正在读取游戏商店…' : '等待一致的商店档案' }}</h2>
    <p>只有本地服务返回实际商品、价格与余额后才会开放购买，不使用临时商品或假报价。</p>
    <button type="button" class="button button-primary" :disabled="pending || store.loading || store.busy" @click="reload"><Icon name="refresh" />刷新商品</button>
  </section>
  <template v-else>
    <div class="shop-summary panel"><div class="wallet"><Icon name="coin" /><span><small>可用游戏金币</small><strong>{{ page.walletCoins }}</strong></span></div>
      <div class="summary-description"><span class="small muted">商品目录 v{{ page.catalogVersion }}</span><strong>{{ page.offers.length }} 项实际商品</strong><p class="small muted">确认时重新核对报价、余额和状态修订。</p></div>
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || store.loading" @click="reload"><Icon name="refresh" />{{ pending ? '更新中…' : '刷新报价' }}</button>
    </div>
    <div class="shop-filters panel">
      <label><span>筛选类别</span><select v-model="category">
        <option value="ALL">全部商品</option><option value="MATERIAL">材料</option><option value="CONSUMABLE">消耗品</option>
        <option value="GIFT">礼物</option><option value="EQUIPMENT">装备</option></select></label>
      <label><span>搜索</span><input v-model="search" maxlength="80" type="search" placeholder="商品名称 / ID" /></label>
    </div>
    <div class="section-heading"><div><span class="eyebrow">Catalog offers</span><h2>商品 <small>{{ offers.length }} 项</small></h2></div></div>
    <div v-if="visibleOffers.length" class="shop-grid">
      <article v-for="{ offer, item, held } in visibleOffers" :key="offer.offerId" class="panel offer-card">
        <header class="offer-heading">
          <span class="panel-symbol" :class="{ 'accent-blue': item.kind === 'EQUIPMENT' || item.kind === 'CONSUMABLE', 'accent-rose': item.kind === 'GIFT' }">
            <Icon :name="item.kind === 'EQUIPMENT' ? 'spark' : item.kind === 'GIFT' ? 'heart' : 'bag'" />
          </span>
          <div><h3>{{ item.displayName }}</h3><span class="muted small">{{ itemKindLabel[item.kind] }} · {{ rarityLabel[item.rarity] }}</span></div>
        </header>
        <p class="muted small">{{ item.description }}</p>
        <p class="offer-effect">{{ declaredEffectText(item) }}</p>
        <p class="muted small">当前持有{{ item.kind === 'EQUIPMENT' ? '本版本实例' : '' }}：{{ held }} 件</p>
        <div class="offer-price"><span><Icon name="coin" /> <strong>{{ offer.priceCoins }}</strong> / 件</span>
          <label :for="`quantity-${offer.offerId}`">数量
            <input :id="`quantity-${offer.offerId}`" :value="quantityText(offer)" :min="offer.minQuantity" :max="offer.maxQuantity"
              type="number" step="1" inputmode="numeric" :disabled="!allowCommands" @input="editQuantity(offer, $event)" />
          </label>
        </div>
        <div class="total-box"><span>总价</span><strong>{{ total(offer) ?? '—' }} <small>金币</small></strong></div>
        <p v-if="purchaseIssue(offer)" class="offer-warning" role="status">{{ purchaseIssue(offer) }}</p>
        <button type="button" class="button button-primary" :disabled="!canBuy(offer)" @click="buy(offer)">确认购买条件</button>
      </article>
    </div>
    <div v-else class="panel empty-state compact-empty"><Icon name="shop" /><p>没有符合筛选条件的实际商品。</p></div>
    <div v-if="pageCount > 1" class="shop-paging"><button type="button" class="button button-secondary" :disabled="pageIndex === 0" @click="pageIndex--">上一页</button>
      <span>{{ pageIndex + 1 }} / {{ pageCount }}</span><button type="button" class="button button-secondary" :disabled="pageIndex + 1 >= pageCount" @click="pageIndex++">下一页</button></div>
    <p v-if="!allowCommands" class="muted small" role="status">等待最新状态，购买操作暂不可用。</p>
  </template>
  <InventoryConfirmDialog :quote="quote" :attempted="attempted" :executing="executing" :confirmable="confirmable"
    @confirm="confirmQuote" @cancel="closeQuote()" @modal-error="onModalError" />
</template>

<style scoped>
.shop-summary { display: grid; grid-template-columns: minmax(112px, .8fr) minmax(0, 1.6fr) auto; align-items: center; gap: 15px; padding: 16px; margin-bottom: 15px; }
.shop-summary .wallet { min-width: 0; justify-content: center; }
.summary-description { min-width: 0; display: grid; gap: 6px; overflow-wrap: anywhere; }
.summary-description strong { color: var(--gold-light); font-size: 16px; }
.shop-filters { padding: 13px; display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; align-items: center; }
.shop-filters label, .offer-price label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; min-width: 0; }
select, input { min-width: 0; max-width: 100%; padding: 8px 10px; border: 1px solid var(--border); color: var(--text); background: #271f29; border-radius: 8px; }
select:focus-visible, input:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.shop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 255px), 1fr)); gap: 14px; align-items: stretch; }
.offer-card { padding: 15px; display: grid; gap: 11px; align-content: start; min-width: 0; overflow-wrap: anywhere; }
.offer-heading { display: flex; align-items: center; gap: 10px; }
.offer-heading h3 { font-size: 15px; color: var(--gold-light); }
.offer-heading > div { min-width: 0; }
.offer-effect { font-size: 11px; line-height: 1.6; color: #bacce2; border: 1px solid #4a4b60; border-radius: 8px; background: #32313c; padding: 8px; }
.offer-price { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.offer-price > span { color: var(--gold); font-size: 12px; }
.offer-price .icon { width: 15px; height: 15px; }
.offer-price strong { font-size: 17px; }
.offer-price input { width: 74px; }
.total-box { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-radius: 8px; border: 1px solid #69533c; padding: 10px; background: #42332e; color: var(--gold); font-size: 12px; }
.total-box strong { color: var(--gold-light); font-size: 19px; font-variant-numeric: tabular-nums; text-align: right; }
.total-box small { font-size: 10px; }
.offer-warning { color: #e9b3a9; font-size: 11px; line-height: 1.5; }
.shop-paging { display: flex; justify-content: center; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; padding: 14px; }
@media (max-width: 600px) {
  .shop-summary { grid-template-columns: minmax(100px, 1fr) minmax(0, 1.5fr); }
  .shop-summary .button { grid-column: 1 / -1; }
}
</style>
