<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { TravelReportsQuery, TripReport } from '@pet-desktop/contracts/travel';
import { routeName } from '../../shared/presentation';
import {
  battleActionSkills, battleSkillLabel, reportFactText, reportPageOffset, reportReadPayload, reportsQueryKey, returnReasonLabel,
  rewardLabel, suppliesText, travelDuration,
} from '../../shared/travel-view-policy';
import { slotLabel, statsText } from '../../shared/inventory-view-policy';
import { useTravelReportsProjection } from '../useTravelProjection';
import Icon from '../components/Icon.vue';

const filter = ref('');
const offset = ref(0);
const limit = 8;
const query = computed<TravelReportsQuery>(() => ({ offset: offset.value, limit, ...(filter.value ? { petId: filter.value } : {}) }));
watch(filter, () => { offset.value = 0; }, { flush: 'sync' });
const context = useTravelReportsProjection(query, next => { offset.value = next; }, () => { filter.value = ''; offset.value = 0; });
const { store, generation, page, pending, queryError, allowCommands, reload } = context;
const pets = computed(() => store.snapshot?.pets ?? []);
const pageNumber = computed(() => Math.floor((page.value?.offset ?? offset.value) / limit) + 1);
const pageCount = computed(() => Math.max(1, Math.ceil((page.value?.total ?? 0) / limit)));
let disposed = false;
onBeforeUnmount(() => { disposed = true; });

function petName(report: TripReport): string {
  return pets.value.find(pet => pet.petId === report.petId)?.nickname ?? '历史角色';
}
const time = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function reportTime(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? time.format(date) : `时间戳 ${at}`;
}
function changePage(direction: -1 | 1): void {
  if (!page.value || pending.value || store.busy) return;
  const next = reportPageOffset(page.value, direction);
  if (next !== undefined) offset.value = next;
}
function canMarkRead(report: TripReport): boolean {
  return reportReadPayload(page.value, store.snapshot, report, allowCommands.value) !== undefined;
}
async function markRead(report: TripReport): Promise<void> {
  const payload = reportReadPayload(page.value, store.snapshot, report, allowCommands.value);
  if (!payload) return;
  const gen = generation.value;
  const key = reportsQueryKey(query.value);
  const success = await store.dispatch({ type: 'TRIP_REPORT_READ', payload }, '旅行报告已由本地服务标为已读。');
  // Do not mutate readAt optimistically; any stale component or restarted
  // generation must discard its response. A failed gesture is never retried.
  if (success && !disposed && generation.value === gen && reportsQueryKey(query.value) === key) void context.refreshReports();
}
</script>

<template>
  <div class="page-intro panel">
    <span class="panel-symbol accent-blue"><Icon name="report" /></span>
    <div><span class="eyebrow">Historical expeditions</span><h2>已结算旅行历史</h2><p>服务保存的每一次真实旅行：归来时间、出发冻结战力、实际节点事实、已入账奖励及已读记录。</p></div>
    <RouterLink class="button button-secondary" to="/adventure/map">返回冒险地图 <Icon name="arrow" /></RouterLink>
  </div>
  <div class="panel report-toolbar">
    <label><span>角色筛选</span><select v-model="filter" :disabled="store.busy">
      <option value="">全部历史</option><option v-for="pet in pets" :key="pet.petId" :value="pet.petId">{{ pet.nickname }}（{{ pet.petId }}）</option>
    </select></label>
    <span v-if="page" class="small muted">符合查询的已结算记录 {{ page.total }} 条</span>
    <button class="button button-secondary" type="button" :disabled="pending || store.busy || store.loading" @click="reload"><Icon name="refresh" />{{ pending ? '读取中…' : '刷新报告' }}</button>
  </div>
  <div v-if="queryError" class="feedback feedback-error" role="alert"><div><strong>无法读取旅行历史</strong><p>{{ queryError }}</p></div>
    <button type="button" class="button button-secondary" :disabled="pending || store.busy" @click="reload">重新查询</button></div>
  <section v-if="!page" class="panel empty-state" :aria-busy="pending">
    <Icon name="report" /><h2>{{ pending ? '正在查询真实历史…' : '等待一致的旅行报告' }}</h2><p>未取得同一业务修订与分页的历史资料前，不会用当前宠物快照猜测旧旅行。</p>
    <button type="button" class="button button-primary" :disabled="pending || store.loading || store.busy" @click="reload">重新查询</button>
  </section>
  <template v-else>
    <div v-if="page.rows.length" class="report-list">
      <article v-for="report in page.rows" :key="report.tripId" class="panel travel-report">
        <header class="report-summary">
          <span class="panel-symbol"><Icon name="map" /></span>
          <div class="report-title">
            <span class="eyebrow">{{ petName(report) }} · 实例 {{ report.petId }}</span>
            <h3>{{ routeName(report.routeId) }} <small>v{{ report.contentVersion }}</small></h3>
            <p class="small muted">{{ report.routeId }} · {{ returnReasonLabel[report.returnReason] }}</p>
            <p class="small muted">实际归来 {{ reportTime(report.actualReturnedAt) }}</p>
            <p v-if="report.rulesVersion !== 'trip-v1' && report.returnReason === 'DEFEATED'" class="small muted">战斗受挫后在家恢复健康。</p>
          </div>
          <div class="report-actions">
            <span :class="report.readAt === null ? 'subtle-tag' : 'status-pill status-home'">{{ report.readAt === null ? '未读' : '已读' }}</span>
            <button v-if="report.readAt === null" class="button button-secondary" type="button" :disabled="!canMarkRead(report)" @click="markRead(report)">标为已读</button>
          </div>
        </header>
        <div class="report-reward-summary">
          <span class="eyebrow">已入账奖励</span>
          <template v-if="report.rewards.length">
            <span v-for="reward in report.rewards" :key="`${reward.kind}:${reward.targetId}`" class="reward-pill">
              {{ rewardLabel(reward) }} <strong>+{{ reward.amount }}</strong>
            </span>
          </template>
          <span v-else class="muted small">没有产生已入账奖励。</span>
        </div>
        <details class="report-details">
          <summary>查看完整报告、出发档案和事件记录</summary>
          <div class="report-details-body">
            <dl class="report-dates">
              <div><dt>记录身份</dt><dd>{{ report.tripId }}</dd></div>
              <div><dt>出发</dt><dd>{{ reportTime(report.startAt) }}</dd></div>
              <div><dt>原计划归来</dt><dd>{{ reportTime(report.expectedReturnAt) }}</dd></div>
              <div><dt>实际归来</dt><dd>{{ reportTime(report.actualReturnedAt) }}</dd></div>
              <div><dt>实际旅程用时</dt><dd>{{ travelDuration(report.actualReturnedAt - report.startAt) }}</dd></div>
              <div><dt>旅行规则版本</dt><dd>{{ report.rulesVersion }}</dd></div>
              <div v-if="report.readAt !== null"><dt>已读时间</dt><dd>{{ reportTime(report.readAt) }}</dd></div>
            </dl>
            <section class="departure-history">
              <h4>出发时冻结的战斗档案</h4>
              <div class="frozen-power"><span>出发战力</span><strong>{{ report.departurePower }}</strong></div>
              <template v-if="report.loadout">
                <dl class="report-dates">
                  <div><dt>出发等级</dt><dd>Lv.{{ report.loadout.level }}</dd></div>
                  <div><dt>精力成本</dt><dd>{{ report.loadout.energyCost10 / 10 }}</dd></div>
                  <div><dt>补给支出</dt><dd>{{ suppliesText(report.loadout.supplies) }}</dd></div>
                  <div><dt>路线 / 物品目录版本</dt><dd>{{ report.loadout.routeCatalogVersion }} / {{ report.loadout.itemCatalogVersion }}</dd></div>
                  <div><dt>冻结战斗属性</dt><dd>{{ report.loadout.stats ? statsText(report.loadout.stats) : '历史角色属性未知' }}</dd></div>
                </dl>
                <div v-if="report.loadout.equipment.length" class="history-equipment">
                  <article v-for="entry in report.loadout.equipment" :key="entry.instanceId" class="history-gear">
                    <span class="eyebrow">{{ slotLabel[entry.slot] }}</span><strong>{{ entry.definitionId }} +{{ entry.enhancement }}</strong>
                    <small class="muted">实例 {{ entry.instanceId }} · 定义 v{{ entry.definitionVersion }}</small>
                    <p class="small">{{ entry.bonus ? statsText(entry.bonus) : '历史装备属性未知' }}</p>
                  </article>
                </div>
                <p v-else class="small muted">这次出发档案明确记录没有穿戴装备。</p>
              </template>
              <p v-else class="legacy-note">此早期历史记录没有完整出发装备档案；等级、补给与装备等细节未知，不以现有角色或现行装备替代。</p>
            </section>
            <section>
              <h4>实际发生的节点与归来事实</h4>
              <ol class="fact-timeline">
                <li v-for="fact in report.facts" :key="fact.eventId">
                  <span class="fact-sequence">{{ fact.sequence }}</span><div>
                    <div class="fact-heading"><strong>{{ reportFactText(fact).title }}</strong><time class="small muted">{{ reportTime(fact.scheduledAt) }}</time></div>
                    <p class="small">{{ reportFactText(fact).text }}</p>
                    <details v-if="fact.type === 'BATTLE_RESOLVED' && 'battle' in fact.payload" class="battle-rounds">
                      <summary>查看战斗回合</summary>
                      <p v-if="fact.payload.battle.rulesVersion === 'battle-v3'" class="small muted">
                        职业技能 {{ battleSkillLabel[fact.payload.battle.petSkill] }}
                      </p>
                      <ol>
                        <li v-for="round in fact.payload.battle.rounds" :key="round.round">
                          <p class="small">第 {{ round.round }} 回合 · 宠物生命 {{ round.petHp }} · 敌人生命 {{ round.enemyHp }}</p>
                          <ul>
                            <li v-for="action in round.actions" :key="action.actor" class="small muted">
                              {{ action.actor === 'PET' ? '宠物' : '敌人' }}{{ action.hit ? (action.critical ? '暴击' : '命中') : '未命中' }}<template v-if="action.hit"> · 伤害 {{ action.damage }}</template>{{ battleActionSkills(action) }}
                            </li>
                          </ul>
                        </li>
                      </ol>
                    </details>
                    <p v-if="fact.type === 'RETURNING'" class="small muted">计划返程抵达 {{ reportTime(fact.payload.dueAt) }}</p>
                    <span class="fact-identity">{{ fact.eventId }}</span>
                  </div>
                </li>
              </ol>
            </section>
          </div>
        </details>
      </article>
    </div>
    <section v-else class="panel empty-state">
      <Icon name="report" /><h2>没有符合条件的已结算旅行</h2>
      <p>当前正在进行的冒险将在服务确认归家、结算后进入历史；这里不会用预计时间冒充完成。</p>
      <RouterLink class="button button-primary" to="/adventure/map">前往冒险地图 <Icon name="arrow" /></RouterLink>
    </section>
    <div v-if="pageCount > 1" class="report-pagination">
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || reportPageOffset(page, -1) === undefined" @click="changePage(-1)">上一页</button>
      <span>{{ pageNumber }} / {{ pageCount }} · {{ page.total }} 条实录</span>
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || reportPageOffset(page, 1) === undefined" @click="changePage(1)">下一页</button>
    </div>
    <p v-if="!allowCommands" class="small muted" role="status">等待最新状态，已读操作暂不可提交。</p>
  </template>
</template>

<style scoped>
.battle-rounds { margin: 8px 0; }
.battle-rounds summary { cursor: pointer; }
.battle-rounds ol, .battle-rounds ul { padding-inline-start: 22px; }
.battle-rounds p { margin: 6px 0 2px; }
.report-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 13px; padding: 14px; margin-bottom: 17px; }
.report-toolbar label { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.report-toolbar select { min-width: 0; max-width: 240px; background: #261f27; border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px; }
.report-toolbar select:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.report-list { display: grid; gap: 14px; }
.travel-report { overflow: hidden; display: grid; gap: 0; min-width: 0; }
.report-summary { display: flex; gap: 12px; align-items: center; padding: 15px; }
.report-title { flex: 1; display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.report-title h3 { font-size: 17px; color: var(--gold-light); }
.report-title h3 small { font-size: 11px; color: var(--muted); font-weight: 500; }
.report-actions { display: grid; gap: 7px; justify-items: end; flex: 0 0 auto; }
.report-reward-summary { border-block: 1px solid var(--border-subtle); padding: 10px 15px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; background: #2b2228; }
.reward-pill { font-size: 11px; padding: 5px 8px; border-radius: 7px; background: #43352e; border: 1px solid #66513e; color: #e7c59b; overflow-wrap: anywhere; }
.reward-pill strong { color: var(--gold-light); }
.report-details summary { cursor: pointer; color: var(--gold); padding: 12px 15px; font-size: 12px; }
.report-details summary:focus-visible { outline: 2px solid var(--gold); outline-offset: -3px; }
.report-details-body { padding: 0 15px 17px; display: grid; gap: 17px; min-width: 0; }
.report-details h4 { margin: 0 0 9px; font-size: 14px; color: var(--gold-light); }
.report-dates { background: #292229; border-radius: 9px; border: 1px solid var(--border-subtle); padding: 11px; margin: 0; display: grid; gap: 7px; }
.report-dates > div { display: grid; grid-template-columns: minmax(84px,.65fr) minmax(0,1.35fr); gap: 10px; align-items: baseline; font-size: 12px; }
.report-dates dt { color: var(--muted); }.report-dates dd { color: var(--text); margin: 0; font-weight: 560; overflow-wrap: anywhere; text-align: right; }
.departure-history { display: grid; gap: 10px; }
.departure-history h4 { margin: 0; }
.frozen-power { display: flex; justify-content: space-between; align-items: baseline; border: 1px solid #67513d; background: #3e312b; color: var(--gold-light); padding: 10px; border-radius: 8px; }
.frozen-power strong { font-size: 19px; }
.history-equipment { display: grid; grid-template-columns: repeat(auto-fill,minmax(min(100%,175px),1fr)); gap: 8px; }
.history-gear { background: #292229; border: 1px solid var(--border); border-radius: 8px; padding: 10px; display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.legacy-note { color: #e2c6ac; background: #46342e; border: 1px solid #71533f; padding: 10px; border-radius: 8px; font-size: 12px; line-height: 1.7; }
.fact-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.fact-timeline li { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 8px; align-items: start; position: relative; min-width: 0; }
.fact-timeline li > div { background: #292229; border-radius: 8px; border: 1px solid var(--border-subtle); padding: 10px; overflow-wrap: anywhere; }
.fact-sequence { display: grid; place-items: center; color: var(--gold-light); background: #4e3d30; border: 1px solid #735b40; width: 24px; height: 24px; border-radius: 50%; font-size: 11px; }
.fact-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 5px; margin-bottom: 4px; }
.fact-identity { color: var(--faded); font-size: 10px; display: block; margin-top: 4px; overflow-wrap: anywhere; }
.report-pagination { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 9px; color: var(--muted); font-size: 12px; padding: 15px; }
@media (max-width: 460px) { .report-summary { flex-wrap: wrap; } .report-actions { width: 100%; display: flex; align-items: center; justify-content: flex-end; } }
</style>
