<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { EventListQuery, EventOccurrenceView } from '@pet-desktop/contracts/events';
import {
  chosenEventLabel, confirmEventChoice, createEventChoiceConfirmation, eventChoiceWindowOpen, eventDeadlineText,
  eventPageOffset, eventQueryKey, eventRarityLabel, eventRewardText, eventStatusLabel, eventTriggerLabel, hasUnlockedEventArt,
} from '../../shared/event-view-policy';
import type { EventChoiceConfirmation } from '../../shared/event-view-policy';
import { useEventProjection } from '../useEventProjection';
import { useNow } from '../useNow';
import Icon from '../components/Icon.vue';

const filter = ref<EventListQuery['filter']>('PENDING');
const petFilter = ref('');
const offset = ref(0);
const limit = 8;
watch([filter, petFilter], () => { offset.value = 0; }, { flush: 'sync' });
const query = computed<EventListQuery>(() => ({ filter: filter.value, offset: offset.value, limit,
  ...(petFilter.value ? { petId: petFilter.value } : {}) }));
const context = useEventProjection(query, next => { offset.value = next; }, () => {
  filter.value = 'PENDING'; petFilter.value = ''; offset.value = 0;
});
const { store, generation, stamp, page, pending, queryError, allowCommands, reload } = context;
const pets = computed(() => store.snapshot?.pets ?? []);
const pageNumber = computed(() => Math.floor((page.value?.offset ?? 0) / limit) + 1);
const pageCount = computed(() => Math.ceil((page.value?.total ?? 0) / limit));
const now = useNow();
const dialog = ref<HTMLDialogElement | null>(null);
const confirmation = shallowRef<EventChoiceConfirmation | null>(null);
const executing = ref(false);
const attempted = ref(false);
const modalError = ref<string | null>(null);
let disposed = false;
const key = computed(() => eventQueryKey(query.value));
const confirmable = computed(() => !!confirmation.value && !attempted.value && !executing.value
  && !!confirmEventChoice(confirmation.value, stamp.value, generation.value, store.snapshot, query.value, now.value, allowCommands.value));

function displayTime(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? `时间戳 ${ms}` : date.toLocaleString('zh-CN', { hour12: false });
}
function petName(event: EventOccurrenceView): string {
  return pets.value.find(pet => pet.petId === event.petId && pet.characterId === event.characterId)?.nickname ?? event.characterId;
}
function isAway(event: EventOccurrenceView): boolean {
  return pets.value.some(pet => pet.petId === event.petId && pet.characterId === event.characterId && pet.presence === 'AWAY');
}
function changePage(direction: -1 | 1): void {
  if (!page.value || pending.value || store.busy) return;
  const next = eventPageOffset(page.value, direction);
  if (next !== undefined) offset.value = next;
}
function choiceFor(event: EventOccurrenceView, choiceId: string, displayNow = now.value): EventChoiceConfirmation | undefined {
  return createEventChoiceConfirmation(stamp.value, generation.value, store.snapshot, query.value,
    event.occurrenceId, choiceId, displayNow, allowCommands.value && !executing.value);
}
function closeChoice(force = false): void {
  if (executing.value && !force) return;
  confirmation.value = null; attempted.value = false; executing.value = false;
  if (dialog.value?.open) dialog.value.close();
}
watch([generation, key], () => { closeChoice(true); modalError.value = null; }, { flush: 'sync' });
async function openChoice(event: EventOccurrenceView, choiceId: string): Promise<void> {
  const quote = choiceFor(event, choiceId, Date.now());
  if (!quote || confirmation.value) return;
  confirmation.value = quote; attempted.value = false; modalError.value = null;
  await nextTick();
  if (disposed || confirmation.value !== quote) return;
  try {
    if (!dialog.value) throw new Error('missing modal');
    dialog.value.showModal();
  } catch {
    closeChoice(true); modalError.value = '无法开启确认窗口，选择未提交。';
  }
}
async function choose(): Promise<void> {
  const quote = confirmation.value;
  if (!quote || attempted.value || executing.value || !dialog.value?.open) return;
  const payload = confirmEventChoice(quote, stamp.value, generation.value, store.snapshot, query.value, Date.now(), allowCommands.value);
  if (!payload) return;
  // Store stamps the current expectedRevision synchronously. The exact
  // confirmation/revision gate above must pass immediately before dispatch.
  attempted.value = true; executing.value = true;
  const success = await store.dispatch({ type: 'EVENT_CHOOSE', payload }, '事件选择已由本地服务确认。');
  if (disposed || confirmation.value !== quote || generation.value !== quote.generation) return;
  executing.value = false;
  if (success) { closeChoice(true); void context.refreshEvents(); }
}
function onCancel(event: Event): void {
  event.preventDefault(); closeChoice();
}
function onDialogClose(): void {
  if (!dialog.value?.open) closeChoice();
}
onBeforeUnmount(() => { disposed = true; closeChoice(true); });
</script>

<template>
  <div class="page-intro panel">
    <span class="panel-symbol accent-rose"><Icon name="report" /></span>
    <div><span class="eyebrow">Story inbox · 本地事件</span><h2>事件箱与故事记录</h2><p>每个伙伴都有独立经历。这里收藏本地服务已经触发的事件，等待你的选择，或回顾真实的结局与奖励。</p></div>
    <RouterLink class="button button-secondary" to="/gallery">事件图鉴 <Icon name="arrow" /></RouterLink>
  </div>
  <div class="panel event-toolbar">
    <label><span>角色</span><select v-model="petFilter" :disabled="store.busy || executing">
      <option value="">全部伙伴</option><option v-for="pet in pets" :key="pet.petId" :value="pet.petId">{{ pet.nickname }}（{{ pet.petId }}）</option>
    </select></label>
    <label><span>状态</span><select v-model="filter" :disabled="store.busy || executing">
      <option value="PENDING">待选择</option><option value="HISTORY">已完成故事</option><option value="ALL">所有事件</option>
    </select></label>
    <span v-if="page" class="small muted">该角色范围待选择 {{ page.pendingTotal }} 条 · 当前筛选 {{ page.total }} 条</span>
    <button type="button" class="button button-secondary" :disabled="pending || store.busy || store.loading" @click="reload"><Icon name="refresh" />{{ pending ? '读取中…' : '刷新事件' }}</button>
  </div>
  <div v-if="queryError || modalError" class="feedback feedback-error" role="alert">
    <div><strong>无法更新事件箱</strong><p>{{ queryError ?? modalError }}</p></div>
    <button type="button" class="button button-secondary" :disabled="pending || store.busy" @click="modalError = null; reload()">重新查询</button>
  </div>
  <section v-if="!page" class="panel empty-state" :aria-busy="pending">
    <Icon name="report" /><h2>{{ pending ? '正在读取伙伴的故事…' : '等待一致的事件档案' }}</h2>
    <p>只显示真实事件，不在界面生成随机结果，也不会替你选择。</p>
    <button type="button" class="button button-primary" :disabled="pending || store.busy || store.loading" @click="reload">重新查询</button>
  </section>
  <template v-else>
    <div v-if="page.rows.length" class="event-list">
      <article v-for="event in page.rows" :key="event.occurrenceId" class="panel event-card">
        <header class="event-heading">
          <span class="panel-symbol" :class="{ 'accent-rose': event.status === 'PENDING', 'accent-blue': event.status !== 'PENDING' }"><Icon name="spark" /></span>
          <div class="event-title"><span class="eyebrow">{{ petName(event) }} · {{ event.petId }}</span><h3>{{ event.title }}</h3><p class="small muted">{{ eventTriggerLabel[event.trigger] }} · {{ displayTime(event.occurredAt) }}</p></div>
          <div class="event-badges"><span class="subtle-tag">{{ eventRarityLabel[event.rarity] }}</span><span :class="event.status === 'PENDING' ? 'subtle-tag' : 'status-pill status-home'">{{ eventStatusLabel[event.status] }}</span></div>
        </header>
        <p class="event-narrative">{{ event.narrative }}</p>
        <section v-if="event.status === 'PENDING'" class="event-branch">
          <header class="branch-heading"><strong>想怎样回应？</strong><span class="small muted">{{ eventDeadlineText(event, now) }}</span></header>
          <p class="small muted">截止：{{ displayTime(event.deadlineAt) }}（倒计时仅显示，结算时钟由服务决定）</p>
          <p v-if="isAway(event)" class="small muted">伙伴正在出门，也可以回应这个已经发生的故事。</p>
          <p v-if="!eventChoiceWindowOpen(event, now)" class="event-note" role="status">显示时间已到截止点。请等待服务处理或刷新；此处不会自动选择、发放奖励或重新抽取。</p>
          <div class="event-choices">
            <button v-for="choice in event.choices" :key="choice.choiceId" type="button" class="button button-secondary"
              :disabled="!choiceFor(event, choice.choiceId)" @click="openChoice(event, choice.choiceId)">{{ choice.label }} <Icon name="arrow" /></button>
          </div>
        </section>
        <section v-else class="event-branch event-result">
          <header class="branch-heading"><strong>{{ event.status === 'EXPIRED' ? '服务已按超时规则完成' : '故事结局' }}</strong><time class="small muted">{{ displayTime(event.resolvedAt) }}</time></header>
          <p class="small muted">已记录选择：{{ chosenEventLabel(event) }}</p>
          <p class="event-narrative">{{ event.resultText }}</p>
          <div class="event-rewards"><span class="eyebrow">真实已入账效果</span>
            <span v-for="(reward, index) in event.rewards" :key="index" class="reward-pill">{{ eventRewardText(reward) }}</span>
            <span v-if="!event.rewards.length" class="small muted">没有记录到账奖励。</span>
          </div>
        </section>
        <div v-if="event.artState !== 'NONE'" class="event-art">
          <RouterLink v-if="hasUnlockedEventArt(event)" to="/gallery" class="panel-link"><Icon name="gallery" /> 查看已收藏 CG <Icon name="arrow" /></RouterLink>
          <span v-else-if="event.artState === 'UNAVAILABLE'" class="small muted">故事 CG 资源尚不可用，不记为已收藏。</span>
          <span v-else class="small muted">这条故事没有已解锁的 CG 记录。</span>
        </div>
        <details class="event-provenance">
          <summary>事件档案</summary><dl>
            <div><dt>事件实例</dt><dd>{{ event.occurrenceId }}</dd></div>
            <div><dt>内容与版本</dt><dd>{{ event.eventId }} · v{{ event.eventVersion }}</dd></div>
            <div><dt>角色模板</dt><dd>{{ event.characterId }}</dd></div>
            <div v-if="event.trigger === 'TRIP_RETURNED'"><dt>旅行来源</dt><dd>{{ event.routeId }} · {{ event.sourceTripId }}</dd></div>
            <div v-if="event.actionId"><dt>记录动作</dt><dd>{{ event.actionId }}</dd></div>
          </dl>
        </details>
      </article>
    </div>
    <section v-else class="panel empty-state"><Icon name="report" />
      <h2>{{ filter === 'PENDING' ? '目前没有待选择的事件' : '暂无符合条件的故事' }}</h2>
      <p>事件由实际陪伴、成长或旅行触发；不用一直点击刷新来抽取新事件。</p>
      <button v-if="filter === 'PENDING'" type="button" class="button button-secondary" @click="filter = 'HISTORY'">回顾已完成故事</button>
    </section>
    <div v-if="pageCount > 1" class="event-pagination">
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || eventPageOffset(page, -1) === undefined" @click="changePage(-1)">上一页</button>
      <span>{{ pageNumber }} / {{ pageCount }} · {{ page.total }} 条真实事件</span>
      <button type="button" class="button button-secondary" :disabled="pending || store.busy || eventPageOffset(page, 1) === undefined" @click="changePage(1)">下一页</button>
    </div>
    <p v-if="!allowCommands" class="small muted" role="status">等待最新状态，选择暂不可提交。</p>
  </template>
  <dialog ref="dialog" class="event-confirm" aria-labelledby="event-confirm-title" @cancel="onCancel" @close="onDialogClose">
    <section v-if="confirmation" class="event-confirm-content">
      <header><span class="eyebrow">本地服务 · 故事选择确认</span><h2 id="event-confirm-title">{{ confirmation.title }}</h2></header>
      <dl class="confirmation-rows">
        <div><dt>伙伴</dt><dd>{{ confirmation.petName }}（{{ confirmation.petId }}）</dd></div>
        <div><dt>选择</dt><dd>{{ confirmation.choiceLabel }}</dd></div>
        <div><dt>截止</dt><dd>{{ displayTime(confirmation.deadlineAt) }}</dd></div>
        <div><dt>事件版本 / 状态修订</dt><dd>v{{ confirmation.eventVersion }} / {{ confirmation.revision }}</dd></div>
      </dl>
      <p class="event-note">确认后选择不可撤销。具体故事结局、奖励及 CG 由服务提交的真实记录决定；旅途中回应也不会改写出发时的冻结战斗档案。</p>
      <p v-if="executing" class="small muted" role="status">等待本地服务确认…</p>
      <p v-else-if="attempted" class="event-note" role="alert">操作结果未确认。请关闭并查询真实事件状态，不会自动重试。</p>
      <p v-else-if="!confirmable" class="event-note" role="status">事件、服务修订或选择时限已变化，请关闭后重新确认。</p>
      <div class="confirmation-actions">
        <button type="button" class="button button-secondary" :disabled="executing" @click="closeChoice()">取消</button>
        <button type="button" class="button button-primary" :disabled="!confirmable || executing" @click="choose">确认这个选择</button>
      </div>
    </section>
  </dialog>
</template>

<style scoped>
.event-toolbar { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 14px; margin-bottom: 17px; }
.event-toolbar label { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.event-toolbar select { min-width: 0; max-width: min(240px,65vw); background: #261f27; color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 8px; }
.event-toolbar select:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.event-list { display: grid; gap: 15px; }
.event-card { min-width: 0; overflow-wrap: anywhere; padding: 16px; display: grid; gap: 13px; }
.event-heading { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.event-title { flex: 1 1 180px; min-width: 0; display: grid; gap: 3px; }
.event-title h3 { font-size: 17px; color: var(--gold-light); }
.event-badges { display: flex; gap: 5px; flex-wrap: wrap; }
.event-narrative { line-height: 1.8; white-space: pre-wrap; font-size: 13px; }
.event-branch { background: #292229; border: 1px solid var(--border-subtle); padding: 12px; border-radius: 10px; display: grid; gap: 9px; }
.branch-heading { display: flex; align-items: center; justify-content: space-between; gap: 5px; flex-wrap: wrap; }
.branch-heading strong { color: var(--gold-light); font-size: 13px; }
.event-choices { display: grid; gap: 7px; }
.event-choices button { justify-content: space-between; text-align: left; white-space: normal; min-height: 35px; line-height: 1.6; }
.event-choices button svg { flex-shrink: 0; }
.event-rewards { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; border-top: 1px solid var(--border-subtle); padding-top: 9px; }
.reward-pill { font-size: 11px; border: 1px solid #66513e; color: #e7c59b; background: #43352e; border-radius: 7px; padding: 5px 8px; overflow-wrap: anywhere; }
.event-art { padding: 2px 0; }
.event-provenance summary { color: var(--gold); font-size: 12px; cursor: pointer; }
.event-provenance summary:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
.event-provenance dl, .confirmation-rows { margin: 10px 0 0; padding: 11px; border-radius: 8px; border: 1px solid var(--border-subtle); background: #292229; display: grid; gap: 8px; }
.event-provenance dl > div, .confirmation-rows > div { display: grid; grid-template-columns: minmax(80px,.8fr) minmax(0,1.4fr); gap: 8px; font-size: 12px; line-height: 1.5; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; text-align: right; color: var(--text); }
.event-pagination { display: flex; justify-content: center; gap: 10px; align-items: center; flex-wrap: wrap; padding: 15px; color: var(--muted); font-size: 12px; }
.event-note { background: #49332d; color: #f2cfb0; border: 1px solid #76523f; border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.6; }
.event-confirm { width: min(530px,calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; overflow: auto; color: var(--text); background: #342b32; border: 1px solid #93755d; border-radius: 15px; box-shadow: 0 24px 55px #100911c9; }
.event-confirm::backdrop { background: #110e17dc; }
.event-confirm-content { padding: 20px; display: grid; gap: 13px; }
.event-confirm-content h2 { margin-top: 5px; color: var(--gold-light); font-size: 22px; overflow-wrap: anywhere; }
.confirmation-rows { margin: 0; }
.confirmation-rows dd { font-weight: 600; color: var(--gold-light); }
.confirmation-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; }
</style>
