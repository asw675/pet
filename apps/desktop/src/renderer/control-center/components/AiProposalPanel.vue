<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { ActionProposal } from '@pet-desktop/contracts/ai';
import type { AiIntent } from '../../../shared/ai-ipc';
import { canConfirmRest } from '../../shared/ai-view-policy';
import { routeName, formatTime } from '../../shared/presentation';
import { useAiQuery } from '../useAiProjection';
import type { AiProjection } from '../useAiProjection';
import { useAiConfirmation } from '../useAiConfirmation';
import { useNow } from '../useNow';
import AiConfirmDialog from './AiConfirmDialog.vue';
const props = defineProps<{ context: AiProjection }>();
const ctx = props.context, { petId, pet, generation, store } = ctx;
const now = useNow(), feedback = ref('');
const query = computed<Extract<AiIntent, { method: 'proposals/list' }> | undefined>(() =>
  generation.value !== null && pet.value ? { method: 'proposals/list', payload: { petId: petId.value } } : undefined);
const { data, pending, error, version, refresh } = useAiQuery(ctx, 'proposals/list', query);
const { quote, submitting, attempted, confirmable, error: confirmError, begin, close, commit, dialogError } = useAiConfirmation(ctx);
function exact(row: ActionProposal) {
  return data.value?.rows.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)) === true;
}
const available = computed(() => !!data.value && !pending.value && !submitting.value && !store.busy && !store.loading && store.ready && !ctx.chatting.value);
function rest(row: ActionProposal) {
  const scope = ctx.token(), snapshot = store.snapshot, selected = pet.value, v = version.value;
  if (!available.value || !scope || !snapshot || !selected || !exact(row) || !canConfirmRest(row, selected.petId, snapshot, Date.now())) return;
  begin({ title: '响应休息建议', detail: [`伙伴：${selected.nickname}（${selected.petId}）`, `理由：${row.reason}`, `状态修订：${snapshot.revision}`],
    warning: '你将发起普通游戏的休息互动。实际效果由游戏服务决定，不由模型提供数值；休息确认后尝试移除此建议。',
    confirmLabel: '确认让伙伴休息',
    current: () => ctx.isCurrent(scope) && version.value === v && !pending.value && !store.busy && !store.loading && store.ready
      && !ctx.chatting.value && store.snapshot?.revision === snapshot.revision && exact(row)
      && canConfirmRest(row, selected.petId, store.snapshot, now.value) && canConfirmRest(row, selected.petId, store.snapshot, Date.now()),
    perform: async () => {
      const result = await store.dispatch({ type: 'PET_INTERACT', payload: { petId: selected.petId, interaction: 'REST' } }, '休息互动已由游戏服务确认。');
      if (!ctx.isCurrent(scope) || !result) return false;
      const dismissed = await ctx.invoke({ method: 'proposal/dismiss', payload: { petId: selected.petId, proposalId: row.proposalId } });
      if (ctx.isCurrent(scope)) feedback.value = dismissed?.ok && dismissed.method === 'proposal/dismiss' && dismissed.data.changed
        ? '休息互动已确认，已移除建议。' : '休息互动已确认，移除建议未确认；请刷新建议列表。';
      return true;
    },
  });
}
function dismiss(row: ActionProposal) {
  const scope = ctx.token(), v = version.value;
  if (!scope || !available.value || !exact(row)) return;
  begin({ title: '移除此建议', detail: [`伙伴：${pet.value?.nickname}（${row.petId}）`, row.reason],
    warning: '仅移除建议记录，不执行任何游戏互动或外部操作。', confirmLabel: '移除建议',
    current: () => ctx.isCurrent(scope) && version.value === v && !!data.value && !pending.value && exact(row),
    perform: async () => {
      const result = await ctx.invoke({ method: 'proposal/dismiss', payload: { petId: row.petId, proposalId: row.proposalId } });
      return ctx.isCurrent(scope) && result?.ok === true && result.method === 'proposal/dismiss' && result.data.changed;
    },
  });
}
</script>
<template>
  <section class="panel ai-section">
    <header class="ai-heading"><div><span class="eyebrow">Suggestions only</span><h3>伙伴的建议</h3></div><button class="button button-secondary" type="button" :disabled="pending" @click="refresh">刷新建议</button></header>
    <p class="small muted">这里展示服务确认保存的建议，不是模型执行游戏或系统操作的权限。</p>
    <p v-if="error" role="alert" class="ai-warning">{{ error }}</p>
    <p v-else-if="!data" class="small muted">{{ pending ? '正在查询…' : '等待建议档案。' }}</p>
    <template v-if="data">
      <article v-for="row in data.rows" :key="row.proposalId" class="ai-box memory-row">
        <strong>{{ row.type === 'REST' ? '休息建议' : row.type === 'TRIP_SUGGESTION' ? `探索：${routeName(row.targetId)}` : '快捷操作建议（不可执行）' }}</strong>
        <p class="ai-plain">{{ row.reason }}</p><p class="small muted">来源 {{ row.conversationId }} · 有效期 {{ formatTime(row.expiresAt) }}</p>
        <div class="ai-actions">
          <button type="button" class="button button-secondary" :disabled="!available" @click="dismiss(row)">移除</button>
          <button v-if="row.type === 'REST'" type="button" class="button button-primary" :disabled="!available || !canConfirmRest(row, petId, store.snapshot, now)" @click="rest(row)">核对休息互动</button>
          <RouterLink v-else-if="row.type === 'TRIP_SUGGESTION' && now < row.expiresAt" class="button button-secondary" to="/adventure/map">去冒险地图手动准备</RouterLink>
        </div>
      </article>
      <p v-if="!data.rows.length" class="small muted">当前没有有效的已保存建议。</p>
    </template>
    <p v-if="feedback || confirmError" class="ai-note" role="status">{{ confirmError ?? feedback }}</p>
    <AiConfirmDialog :quote="quote" :submitting="submitting" :attempted="attempted" :confirmable="confirmable" :error="confirmError" @confirm="commit" @cancel="close()" @modal-error="dialogError" />
  </section>
</template>
