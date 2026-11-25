<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { MemoryRecord, PendingMemoryCandidate } from '@pet-desktop/contracts/ai';
import type { AiIntent } from '../../../shared/ai-ipc';
import { aiNextOffset, memoryDecisionIntent } from '../../shared/ai-view-policy';
import type { MemoryDraft } from '../../shared/ai-view-policy';
import { formatTime } from '../../shared/presentation';
import { useAiQuery } from '../useAiProjection';
import type { AiProjection } from '../useAiProjection';
import { useAiConfirmation } from '../useAiConfirmation';
import { useNow } from '../useNow';
import AiConfirmDialog from './AiConfirmDialog.vue';
const props = defineProps<{ context: AiProjection }>();
const ctx = props.context, { pet, petId, pets, generation, epoch, chatting } = ctx;
const offset = ref(0), candidateOffset = ref(0), limit = 8, now = useNow();
const query = computed<Extract<AiIntent, { method: 'memory/list' }> | undefined>(() => pet.value && generation.value !== null
  ? { method: 'memory/list', payload: { petId: petId.value, offset: offset.value, candidateOffset: candidateOffset.value, limit } } : undefined);
const { data, pending, error, version, refresh } = useAiQuery(ctx, 'memory/list', query);
const { quote, submitting, attempted, confirmable, error: confirmError, begin, close, commit, dialogError } = useAiConfirmation(ctx);
type MemoryRow = PendingMemoryCandidate | MemoryRecord;
const selected = shallowRef<MemoryRow | null>(null), draft = ref<MemoryDraft | null>(null), expiryText = ref(''), feedback = ref('');
const recipients = computed(() => pets.value.filter(row => row.petId !== petId.value));
const writable = computed(() => !!data.value && !pending.value && !chatting.value && !submitting.value);
const typeLabel = { PREFERENCE: '偏好', HISTORY: '经历', AGREEMENT: '约定' };
function resetEditor() { selected.value = null; draft.value = null; expiryText.value = ''; feedback.value = ''; }
watch([generation, epoch], () => { offset.value = 0; candidateOffset.value = 0; resetEditor(); }, { flush: 'sync' });
function changePage(which: 'records'|'candidates', direction: -1|1) {
  if (!data.value) return;
  const current = which === 'records' ? offset : candidateOffset;
  const rows = which === 'records' ? data.value.memories : data.value.candidates;
  const next = aiNextOffset(current.value, limit, rows.length, direction);
  if (next !== undefined) { current.value = next; resetEditor(); }
}
function exact(row: MemoryRow): boolean {
  const list = row.consentState === 'PENDING' ? data.value?.candidates : data.value?.memories;
  return list?.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)) === true;
}
function name(id: string): string { const row = pets.value.find(p => p.petId === id); return row ? `${row.nickname}（${id}）` : id; }
function localDate(value: number | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const part = (n:number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}
function openEditor(row: MemoryRow) {
  if (!writable.value || !exact(row) || (row.consentState === 'PENDING' && Date.now() >= row.expiresAt)) return;
  selected.value = row; feedback.value = '';
  // The model's proposed scope does not initialize a sharing grant.
  const confirmed = row.consentState === 'CONFIRMED';
  draft.value = { summary: row.summary, scope: confirmed ? row.scope : 'PRIVATE',
    recipients: confirmed && row.scope === 'SHARED' ? [...row.recipientPetIds] : [], pinned: confirmed && row.pinned,
    expiresAt: confirmed ? row.expiresAt : null };
  expiryText.value = localDate(draft.value.expiresAt);
}
function scopeChanged() { if (draft.value?.scope === 'PRIVATE') draft.value.recipients = []; }
function expiryChanged() {
  if (draft.value) draft.value.expiresAt = expiryText.value ? new Date(expiryText.value).getTime() : null;
}
function readGuard(extra: () => boolean = () => true) {
  const scope = ctx.token(), v = version.value;
  return () => ctx.isCurrent(scope) && version.value === v && !!data.value && !pending.value && !chatting.value && extra();
}
function confirmDecision() {
  const row = selected.value, value = draft.value, scope = ctx.token();
  if (!row || !value || !scope || !exact(row) || !writable.value) return;
  const intent = memoryDecisionIntent(row, value, ctx.store.snapshot, petId.value, Date.now());
  if (!intent) { feedback.value = '记忆内容、有效期或具名共享对象不符合规则，请调整。'; return; }
  const fingerprint = JSON.stringify(value);
  begin({
    title: row.consentState === 'PENDING' ? '确认保存这条记忆' : '修改已确认记忆',
    detail: [`所有者：${name(row.ownerPetId)}`, `记忆：${value.summary.trim()}`,
      value.scope === 'PRIVATE' ? '仅此角色（PRIVATE）' : `仅额外授权：${value.recipients.map(name).join('、')}`,
      `有效期：${value.expiresAt === null ? '未设过期' : formatTime(value.expiresAt)}`, `置顶：${value.pinned ? '是' : '否'}`],
    warning: '只有确认后的记忆摘要才可进入被授权角色的模型上下文；不会共享原始对话。若被授权的角色使用远程模型，则摘要可能随其主动对话发送，且可随时撤销共享。',
    confirmLabel: value.scope === 'SHARED' ? '授权上述具名伙伴并保存' : '仅此角色保存',
    current: readGuard(() => exact(row) && JSON.stringify(draft.value) === fingerprint
      && !!memoryDecisionIntent(row, value, ctx.store.snapshot, petId.value, now.value)
      && !!memoryDecisionIntent(row, value, ctx.store.snapshot, petId.value, Date.now())),
    perform: async () => {
      const result = await ctx.invoke(intent);
      if (!ctx.isCurrent(scope)) return false;
      if (!result?.ok) { feedback.value = ctx.problem(result); return false; }
      resetEditor(); feedback.value = '记忆已由本地服务保存。'; return true;
    },
  });
}
function confirmRemoval(row: MemoryRow, recipientId?: string) {
  const scope = ctx.token();
  if (!scope || !writable.value || !exact(row)) return;
  const pendingRow = row.consentState === 'PENDING';
  if (recipientId !== undefined && (pendingRow || row.scope !== 'SHARED' || !row.recipientPetIds.includes(recipientId))) return;
  const intent: AiIntent = pendingRow ? { method: 'memory/reject', payload: { petId: row.ownerPetId, candidateId: row.candidateId } }
    : recipientId !== undefined ? { method: 'memory/revoke', payload: { petId: row.ownerPetId, memoryId: row.memoryId, recipientPetId: recipientId } }
    : { method: 'memory/delete', payload: { petId: row.ownerPetId, memoryId: row.memoryId } };
  begin({ title: pendingRow ? '拒绝这条待确认记忆' : recipientId ? '撤销具名伙伴的记忆授权' : '删除此记忆',
    detail: [`所有者：${name(row.ownerPetId)}`, `摘要：${row.summary}`, ...(recipientId ? [`撤销对象：${name(recipientId)}`] : [])],
    warning: recipientId ? '撤销后该伙伴不再有此摘要的访问授权。不能撤回历史上已发送给模型的内容。'
      : '此操作不会删除底层对话，但待确认记录或记忆摘要及相应共享授权将从本地移除。',
    confirmLabel: pendingRow ? '拒绝候选' : recipientId ? '撤销授权' : '删除记忆',
    current: readGuard(() => exact(row)),
    perform: async () => {
      const result = await ctx.invoke(intent);
      if (!ctx.isCurrent(scope) || !result?.ok || !('changed' in result.data) || !result.data.changed) return false;
      resetEditor(); feedback.value = '本地服务已确认修改。'; return true;
    },
  });
}
function clearAll() {
  const scope = ctx.token();
  if (!scope || !writable.value) return;
  begin({ title: '清空当前角色拥有的全部记忆', detail: [name(scope.petId), '包括未展示的其他分页、待确认候选及已确认摘要和相应共享授权。'],
    warning: '不可撤销；不会删除底层历史对话，也不会清空其他角色拥有的记忆或撤回此前远程发送的内容。',
    confirmLabel: '确认清空本角色所有记忆', current: readGuard(),
    perform: async () => {
      const result = await ctx.invoke({ method: 'memory/clear', payload: { petId: scope.petId } });
      if (!ctx.isCurrent(scope) || !result?.ok || result.method !== 'memory/clear') return false;
      offset.value = 0; candidateOffset.value = 0; resetEditor(); feedback.value = `服务确认移除 ${result.data.count} 条记录。`; return true;
    },
  });
}
</script>
<template>
  <section class="panel ai-section">
    <header class="ai-heading"><div><span class="eyebrow">Memory & consent</span><h3>{{ pet?.nickname }} 的记忆管理</h3></div>
      <button type="button" class="button button-secondary" :disabled="pending || submitting" @click="refresh">刷新记忆</button></header>
    <p class="small muted">模型不会直接写入记忆。候选必须由你确认；默认只属于当前伙伴。共享需选择具体伙伴，且仅共享确认的摘要。</p>
    <p v-if="error" class="ai-warning" role="alert">{{ error }}</p><p v-else-if="!data" class="small muted">{{ pending ? '正在读取真实记忆…' : '等待本地记忆档案。' }}</p>
    <template v-if="data">
      <div class="ai-heading"><h4>待确认候选</h4><small class="muted">本页 {{ data.candidates.length }} 条</small></div>
      <p v-if="!data.candidates.length" class="small muted">这一页没有待确认候选。模型提出的内容不会自动保存。</p>
      <article v-for="row in data.candidates" :key="row.candidateId" class="ai-box memory-row">
        <div class="ai-heading"><strong>{{ typeLabel[row.type] }} · 待确认</strong><span class="subtle-tag">尚未授权</span></div>
        <p class="ai-plain">{{ row.summary }}</p>
        <p class="small muted">模型建议 {{ row.scope === 'SHARED' ? '共享' : '私有' }}（无授权效力） · 有效期至 {{ formatTime(row.expiresAt) }}</p>
        <details><summary class="small muted">来源记录</summary><p class="small ai-plain">{{ row.conversationId }} · {{ row.sourceMessageIds.join('、') }}</p></details>
        <div class="ai-actions"><button type="button" class="button button-secondary" :disabled="!writable" @click="confirmRemoval(row)">拒绝候选</button><button type="button" class="button button-primary" :disabled="!writable || now >= row.expiresAt" @click="openEditor(row)">核对并确认</button></div>
      </article>
      <div class="ai-pagination"><button type="button" class="button button-secondary" :disabled="candidateOffset === 0 || pending" @click="changePage('candidates',-1)">上一页</button><span>候选第 {{ Math.floor(candidateOffset / limit)+1 }} 页</span><button type="button" class="button button-secondary" :disabled="aiNextOffset(candidateOffset,limit,data.candidates.length,1)===undefined || pending" @click="changePage('candidates',1)">下一页</button></div>
      <div class="ai-heading"><h4>已确认记忆</h4><button type="button" class="button button-secondary" :disabled="!writable" @click="clearAll">清空本角色记忆</button></div>
      <p v-if="!data.memories.length" class="small muted">这一页没有已确认记忆。</p>
      <article v-for="row in data.memories" :key="row.memoryId" class="ai-box memory-row">
        <div class="ai-heading"><strong>{{ typeLabel[row.type] }} · {{ row.scope === 'PRIVATE' ? '私有' : '具名共享' }}{{ row.pinned ? ' · 已置顶' : '' }}</strong><span class="subtle-tag">{{ row.expiresAt && now >= row.expiresAt ? '已到有效期' : '已确认' }}</span></div>
        <p class="ai-plain">{{ row.summary }}</p>
        <p class="small muted">更新 {{ formatTime(row.updatedAt) }} · {{ row.expiresAt === null ? '未设过期' : `有效期 ${formatTime(row.expiresAt)}` }}</p>
        <div v-if="row.scope === 'SHARED'" class="ai-grants"><span class="eyebrow">具名授权对象</span><div v-for="id in row.recipientPetIds" :key="id" class="ai-heading"><span class="small ai-plain">{{ name(id) }}</span><button type="button" class="button button-secondary" :disabled="!writable" @click="confirmRemoval(row,id)">撤销</button></div></div>
        <details><summary class="small muted">来源记录</summary><p class="small ai-plain">{{ row.sourceConversationId }} · {{ row.sourceMessageIds.join('、') }}</p></details>
        <div class="ai-actions"><button type="button" class="button button-secondary" :disabled="!writable" @click="confirmRemoval(row)">删除</button><button type="button" class="button button-primary" :disabled="!writable" @click="openEditor(row)">编辑摘要、置顶与授权</button></div>
      </article>
      <div class="ai-pagination"><button type="button" class="button button-secondary" :disabled="offset === 0 || pending" @click="changePage('records',-1)">上一页</button><span>记忆第 {{ Math.floor(offset/limit)+1 }} 页</span><button type="button" class="button button-secondary" :disabled="aiNextOffset(offset,limit,data.memories.length,1)===undefined || pending" @click="changePage('records',1)">下一页</button></div>
    </template>
    <form v-if="draft && selected" class="ai-box provider-form" @submit.prevent="confirmDecision">
      <h4>{{ selected.consentState === 'PENDING' ? '核对待确认摘要' : '编辑记忆' }}</h4>
      <label>摘要<textarea v-model="draft.summary" required maxlength="512" rows="4" /></label>
      <label>授权范围<select v-model="draft.scope" @change="scopeChanged"><option value="PRIVATE">仅所有者（PRIVATE）</option><option value="SHARED">具名共享（SHARED）</option></select></label>
      <div v-if="draft.scope === 'SHARED'" class="ai-grants"><p class="small muted">只共享给以下你主动勾选的角色，不会默认授权全部角色。</p>
        <label v-for="row in recipients" :key="row.petId" class="checkline"><input v-model="draft.recipients" type="checkbox" :value="row.petId" /> {{ row.nickname }}（{{ row.petId }}）</label>
        <p v-if="!recipients.length" class="small muted">当前没有可选择的其他伙伴，请使用私有范围。</p></div>
      <label>过期时间（留空为不设置）<input v-model="expiryText" type="datetime-local" @change="expiryChanged" /></label>
      <label class="checkline"><input v-model="draft.pinned" type="checkbox" /> 置顶此摘要</label>
      <div class="ai-actions"><button type="button" class="button button-secondary" @click="resetEditor()">关闭编辑</button><button type="submit" class="button button-primary" :disabled="!writable">核对授权和内容</button></div>
    </form>
    <p v-if="feedback || confirmError" class="ai-note" role="status">{{ confirmError ?? feedback }}</p>
    <AiConfirmDialog :quote="quote" :submitting="submitting" :attempted="attempted" :confirmable="confirmable" :error="confirmError" @confirm="commit" @cancel="close()" @modal-error="dialogError" />
  </section>
</template>
