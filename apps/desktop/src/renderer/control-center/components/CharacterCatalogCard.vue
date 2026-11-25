<script setup lang="ts">
import { computed } from 'vue';
import type { CharacterCatalogPage, CharacterCatalogRow } from '@pet-desktop/contracts';
import { canOfferAcquisition, characterCoinCost } from '../../shared/character-view-policy';
import PetPortrait from '../../shared/PetPortrait.vue';
import Icon from './Icon.vue';

const props = defineProps<{ row: CharacterCatalogRow; catalog: CharacterCatalogPage; allowCommands: boolean; paused: boolean }>();
const emit = defineEmits<{ acquire: [characterId: string] }>();
const eligible = computed(() => canOfferAcquisition(props.row, props.catalog));
const cost = computed(() => characterCoinCost(props.row));
const availabilityText = computed(() => {
  switch (props.row.availability) {
    case 'AVAILABLE': return eligible.value ? '可以领取' : '状态待核验';
    case 'ALREADY_OWNED': return '已拥有';
    case 'CAPACITY_REACHED': return '伙伴容量已满';
    case 'UNMET_REQUIREMENT': return '探索条件未达成';
    case 'INSUFFICIENT_COINS': return '游戏金币不足';
  }
});
const attributes = [
  { key: 'hp', label: '生命' }, { key: 'atk', label: '攻击' }, { key: 'def', label: '防御' },
  { key: 'spd', label: '速度' }, { key: 'luk', label: '幸运' },
] as const;
function acquire(): void { if (props.allowCommands && eligible.value) emit('acquire', props.row.characterId); }
</script>

<template>
  <article class="panel template-card">
    <div class="template-art" :class="`profession-${row.profession.toLowerCase()}`">
      <div class="art-motif" aria-hidden="true">✧</div>
      <div class="template-portrait" aria-hidden="true"><PetPortrait :character-id="row.characterId" :paused="paused" /></div>
      <span class="template-availability" :class="{ 'template-available': eligible }">{{ availabilityText }}</span>
      <span class="template-art-caption">{{ row.species }} · {{ row.professionLabel }}</span>
    </div>
    <div class="template-content">
      <header class="template-heading"><div><span class="eyebrow">角色模板 · {{ row.species }}</span><h3>{{ row.displayName }}</h3></div><span class="subtle-tag">{{ row.professionLabel }}</span></header>
      <p class="template-description">{{ row.background }}</p>
      <div class="template-details"><span class="eyebrow">人格</span><p>{{ row.personality.summary }}</p>
        <div class="template-tags"><span v-for="trait in row.personality.traits" :key="trait">{{ trait }}</span></div>
        <p v-if="row.personality.likes.length" class="small muted"><strong>偏好：</strong>{{ row.personality.likes.join('、') }}</p>
        <p class="small muted"><strong>语气设定：</strong>{{ row.personality.speechStyle }}</p>
      </div>
      <div class="template-details"><span class="eyebrow">冒险倾向</span><div class="template-tags adventure-tags"><span v-for="focus in row.adventureFocus" :key="focus">{{ focus }}</span></div></div>
      <div class="template-details">
        <span class="eyebrow">模板基础属性 · Lv.1</span>
        <div class="template-stats"><span v-for="attribute in attributes" :key="attribute.key"><small>{{ attribute.label }}</small><strong>{{ row.baseStats[attribute.key] }}</strong><small class="growth">+{{ row.growthPerLevel[attribute.key] }}/级</small></span></div>
      </div>
      <section class="template-access" aria-label="角色获取条件">
        <template v-if="row.unlock.kind === 'STARTER'">
          <p>初始角色 · 免费取得（0 游戏金币）</p>
        </template>
        <template v-else>
          <p class="template-unlock-line"><Icon name="coin" /><strong>{{ cost }} 游戏金币</strong><span>当前余额 {{ catalog.walletCoins }}</span></p>
          <div class="template-progress-label"><span>探索结算次数</span><strong>{{ catalog.settledTrips }} / {{ row.unlock.requiredSettledTrips }}</strong></div>
          <progress :value="Math.min(catalog.settledTrips, row.unlock.requiredSettledTrips)" :max="row.unlock.requiredSettledTrips" aria-label="领取所需探索结算次数" />
          <p class="small muted">完成所需结算并备齐游戏内金币后才能领取。</p>
        </template>
        <p v-if="row.instances.length" class="template-owned">已拥有 {{ row.instances.length }} 位独立伙伴：{{ row.instances.map(x => x.nickname).join('、') }}</p>
        <button type="button" class="button button-primary acquire-button" :disabled="!eligible || !allowCommands" @click="acquire">{{ eligible ? '查看领取确认' : availabilityText }}</button>
      </section>
    </div>
  </article>
</template>

<style scoped>
.template-card { display: flex; flex-direction: column; overflow: hidden; height: 100%; }
.template-art { height: 202px; position: relative; isolation: isolate; display: grid; place-items: center; overflow: hidden; border-bottom: 1px solid var(--border); background: radial-gradient(ellipse at 50% 42%, #6a505d, #352735 72%); }
.template-art.profession-ranger { background: radial-gradient(ellipse at 50% 42%, #5b6b5c, #2d3935 72%); }
.template-art.profession-mechanical_support { background: radial-gradient(ellipse at 50% 42%, #597286, #303b4a 72%); }
.art-motif { position: absolute; z-index: -1; inset: 16px auto auto 50%; transform: translateX(-50%); width: 148px; height: 148px; display: grid; place-items: center; border: 1px solid #fff1cf55; border-radius: 50%; box-shadow: 0 0 0 9px #fff1cf0c; color: #fff1cf55; font-size: 130px; }
.template-portrait { width: min(76%, 190px); height: 178px; margin-top: 5px; }
.template-availability { position: absolute; top: 10px; left: 10px; color: #f3e2d8; background: #302630dd; font-size: 11px; border: 1px solid #977880; border-radius: 7px; padding: 6px 8px; }
.template-availability.template-available { color: #3b3425; background: #e7c895; border-color: #f3d6a2; font-weight: 650; }
.template-art-caption { position: absolute; bottom: 7px; color: #f1dfd5; font-size: 10px; letter-spacing: .055em; }
.template-content { display: flex; flex-direction: column; flex: 1; gap: 13px; padding: 15px; }
.template-heading { display: flex; align-items: start; justify-content: space-between; gap: 7px; }
.template-heading h3 { font-size: 22px; margin-top: 3px; color: var(--gold-light); }
.template-heading .subtle-tag { font-size: 10px; white-space: normal; text-align: right; }
.template-description, .template-details p { font-size: 12px; color: var(--muted); line-height: 1.65; overflow-wrap: anywhere; }
.template-details { display: grid; gap: 6px; }
.template-details .eyebrow { font-size: 11px; }
.template-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.template-tags span { font-size: 10px; background: #443540; border: 1px solid #624d5c; border-radius: 12px; color: #eacfcf; padding: 3px 7px; }
.adventure-tags span { background: #35433b; color: #b7d1b9; border-color: #566b57; }
.template-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
.template-stats > span { display: grid; gap: 4px; justify-items: center; background: #251f27; border-radius: 5px; border: 1px solid var(--border-subtle); padding: 7px 1px; min-width: 0; }
.template-stats small { color: var(--muted); font-size: 10px; }
.template-stats strong { font-size: 14px; }
.template-stats .growth { color: #a9c3a8; font-size: 9px; white-space: nowrap; }
.template-access { display: grid; gap: 7px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); }
.template-access p { font-size: 12px; color: var(--gold-light); line-height: 1.6; }
.template-access p.small { color: var(--muted); font-size: 11px; }
.template-unlock-line { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.template-unlock-line .icon { width: 14px; height: 14px; }
.template-unlock-line span { margin-left: auto; color: var(--muted); font-size: 10px; }
.template-progress-label { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; color: var(--muted); }
.template-progress-label strong { color: var(--gold-light); }
.template-access progress { margin-top: 0; }
.template-access p.template-owned { color: #a8c8a9; }
.acquire-button { width: 100%; }
</style>
