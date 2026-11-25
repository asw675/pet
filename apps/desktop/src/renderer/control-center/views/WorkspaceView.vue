<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { LocalRecommendation, QuickActionView, QuickLaunchKind, Routine } from '@pet-desktop/contracts/workspace';
import { workspaceLimits } from '@pet-desktop/contracts/workspace';
import Icon from '../components/Icon.vue';
import { useWorkspaceProjection } from '../useWorkspaceProjection';
import { applyStarterRoutineTemplate, starterRoutineTemplates } from '../workspace-routine-templates';
import type { StarterRoutineTemplate } from '../workspace-routine-templates';
import { actionCanRun, historyTime, moveRoutineTarget, newRoutineDraft, outcomeText, routineDefinitionForDraft, sourceText, targetKindText, visibleRecommendationTargetIds } from '../../shared/workspace-view-policy';

const {
  generation, page, busy, querying, canAct, error, notice, approval, confirmation, canConfirm,
  runningActionId, runningRoutineId, cancelling, routineResult, cards, reload, beginConfirmation, closeConfirmation, confirm,
  selectTarget, discardApproval, saveApproval, runAction, runRoutine, cancelRoutine, markRecommendationsSeen, recommendationIntent, recommendationDraft,
} = useWorkspaceProjection();

const kind = ref<QuickLaunchKind>('WIN32_EXE');
const website = ref(''), addLabel = ref(''), addRecommendable = ref(false);
const replacing = ref<QuickActionView | null>(null);
const pickSection = ref<HTMLElement | null>(null), routineSection = ref<HTMLElement | null>(null);
const clearOnRevoke = ref(true);
const actionEdit = ref<{ actionId: string; revision: number; label: string; enabled: boolean; recommendable: boolean } | null>(null);
function startReapproval(action: QuickActionView): void {
  discardApproval(); replacing.value = { ...action }; kind.value = action.kind; website.value = '';
  void nextTick(() => pickSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}
function resetPick(): void { discardApproval(); replacing.value = null; website.value = ''; addLabel.value = ''; addRecommendable.value = false; }
async function pick(): Promise<void> {
  const selected = await selectTarget(kind.value, website.value, replacing.value ?? undefined);
  website.value = ''; // candidate text is never retained as a saved locator
  if (selected && approval.value) { addLabel.value = replacing.value?.label ?? approval.value.selection.suggestedLabel; addRecommendable.value = false; }
}
async function commitPick(): Promise<void> { if (await saveApproval(addLabel.value, addRecommendable.value)) resetPick(); }
function editAction(action: QuickActionView): void {
  actionEdit.value = { actionId: action.id, revision: action.revision, label: action.label, enabled: action.enabled, recommendable: action.recommendable };
}
function reviewAction(): void {
  const edit = actionEdit.value;
  if (!edit) return;
  beginConfirmation({ method: 'action/metadata', payload: { actionId: edit.actionId, expectedRevision: edit.revision, label: edit.label.trim(),
    enabled: edit.enabled, recommendable: edit.recommendable } }, '确认修改快捷收藏？', `保存「${edit.label.trim()}」的名称、启用状态和推荐偏好。依赖它的场景将更新修订。`);
}
function revoke(action: QuickActionView): void {
  beginConfirmation({ method: 'action/revoke', payload: { actionId: action.id, expectedRevision: action.revision, clearHistory: clearOnRevoke.value } },
    '确认撤销启动授权？', `「${action.label}」将停止可用，旧的目标身份不再保留。${clearOnRevoke.value ? '同时清除该收藏的启动历史。' : '现有历史保留至自动清理。'}重新使用必须重新原生授权。`);
}
function removeAction(action: QuickActionView): void {
  beginConfirmation({ method: 'action/delete', payload: { actionId: action.id, expectedRevision: action.revision } }, '确认删除收藏？',
    `永久删除「${action.label}」、相关历史和推荐偏好，并从依赖它的场景移除。空场景也会删除。`);
}
const actionById = (id: string) => page.value?.actions.find(action => action.id === id);
const labelFor = (id: string) => actionById(id)?.label ?? id;

const routineDraft = ref(newRoutineDraft()), editingRoutine = ref<{ id: string; revision: number } | null>(null), candidateId = ref('');
const routineName = ref<HTMLInputElement | null>(null);
const canCreateRoutine = computed(() => !!page.value && page.value.routines.length < workspaceLimits.routines);
const canChooseTemplate = computed(() => canAct.value && !editingRoutine.value && canCreateRoutine.value);
const candidates = computed(() => (page.value?.actions ?? []).filter(action => actionCanRun(action) && !routineDraft.value.targetIds.includes(action.id)));
const draftDefinition = computed(() => routineDefinitionForDraft(routineDraft.value, page.value));
watch(() => routineDraft.value.mode, mode => { if (mode === 'PARALLEL') { routineDraft.value.delayMs = 0; routineDraft.value.failurePolicy = 'CONTINUE'; } });
function resetRoutine(): void { routineDraft.value = newRoutineDraft(); editingRoutine.value = null; candidateId.value = ''; }
function useTemplate(template: StarterRoutineTemplate): void {
  if (!canChooseTemplate.value) return;
  routineDraft.value = applyStarterRoutineTemplate(template, routineDraft.value);
  void nextTick(() => routineName.value?.focus());
}
function appendTarget(): void {
  if (routineDraft.value.targetIds.length >= workspaceLimits.routineTargets || !candidates.value.some(action => action.id === candidateId.value)) return;
  routineDraft.value.targetIds.push(candidateId.value); candidateId.value = '';
}
function editRoutine(routine: Routine): void {
  editingRoutine.value = { id: routine.id, revision: routine.revision };
  routineDraft.value = { name: routine.name, targetIds: [...routine.targetIds], mode: routine.mode, delayMs: routine.delayMs, failurePolicy: routine.failurePolicy };
  void nextTick(() => routineSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}
function reviewRoutine(): void {
  const definition = draftDefinition.value;
  if (!page.value || !definition) return;
  const intent = editingRoutine.value ? { method: 'routine/update' as const, payload: { routineId: editingRoutine.value.id, expectedRevision: editingRoutine.value.revision, definition } }
    : { method: 'routine/create' as const, payload: { expectedRevision: page.value.revision, definition } };
  beginConfirmation(intent, '确认保存快捷场景？', `「${definition.name}」包含 ${definition.targetIds.map(labelFor).join(' → ')}。仅保存组合，不会启动任何目标。`);
}
function removeRoutine(routine: Routine): void {
  beginConfirmation({ method: 'routine/delete', payload: { routineId: routine.id, expectedRevision: routine.revision } }, '确认删除快捷场景？',
    `删除「${routine.name}」的组合定义，不删除任何快捷收藏。`);
}

const tracking = ref(false), retention = ref<7 | 30>(30), clearWithSettings = ref(false);
watch(() => page.value?.revision, () => {
  if (!page.value) return;
  tracking.value = page.value.settings.enabled; retention.value = page.value.settings.retentionDays; clearWithSettings.value = false;
}, { immediate: true });
function settingsReview(): void {
  if (!page.value) return;
  beginConfirmation({ method: 'recommendation/settings', payload: { expectedRevision: page.value.revision, settings: { enabled: tracking.value, retentionDays: retention.value },
    clearHistory: clearWithSettings.value } }, '确认本地习惯推荐设置？', `${tracking.value ? `仅记录本应用内的启动结果，以 5 分钟时间桶保留 ${retention.value} 天。` : '停止新增本地启动历史及习惯推荐。'}${clearWithSettings.value ? '同时清除已有历史。' : ''}`);
}
function recommendationPreference(targetId: string, mode: 'IGNORE' | 'EXCLUDE' | 'RESTORE'): void {
  if (!page.value) return;
  beginConfirmation({ method: 'recommendation/preference', payload: { expectedRevision: page.value.revision, preference: { targetId,
    ignoredUntil: mode === 'IGNORE' ? Date.now() + 7 * 86_400_000 : null, permanentlyExcluded: mode === 'EXCLUDE' } } },
    mode === 'RESTORE' ? '恢复习惯推荐？' : mode === 'IGNORE' ? '暂时忽略该建议？' : '不再推荐该收藏？',
    `${labelFor(targetId)}：${mode === 'IGNORE' ? '7 天内不再展示这项建议。' : mode === 'EXCLUDE' ? '直到你主动恢复前不再推荐。' : '恢复为可以参与本地习惯推荐的状态。'}`);
}
function runRecommendation(card: LocalRecommendation): void { const input = recommendationIntent(card); if (input?.method === 'action/run') void runAction(input.payload.actionId); }
function useSuggestion(card: LocalRecommendation): void {
  const result = recommendationDraft(card);
  if (!result) return;
  editingRoutine.value = null; routineDraft.value = result; candidateId.value = '';
  void nextTick(() => routineSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}
const weekdayText = { WEEKDAY: '工作日', WEEKEND: '周末' }, periodText = { MORNING: '上午', AFTERNOON: '下午', EVENING: '晚间', NIGHT: '夜间' };
const recSection = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null, mounted = false;
function observeCards(): void {
  observer?.disconnect(); observer = null;
  if (!mounted || !canAct.value || !recSection.value || typeof IntersectionObserver === 'undefined' || document.visibilityState !== 'visible') return;
  observer = new IntersectionObserver(entries => {
    if (!canAct.value || document.visibilityState !== 'visible') return;
    const ids = visibleRecommendationTargetIds(entries.map(entry => ({ targetId: (entry.target as HTMLElement).dataset.recommendationTarget,
      isIntersecting: entry.isIntersecting, intersectionRatio: entry.intersectionRatio })), document.visibilityState === 'visible');
    if (ids.length) void markRecommendationsSeen(ids);
  }, { threshold: [0.6] });
  for (const element of recSection.value.querySelectorAll<HTMLElement>('[data-recommendation-target]')) observer.observe(element);
}
watch([cards, canAct], () => { void nextTick(observeCards); }, { flush: 'post' });
onMounted(() => { mounted = true; document.addEventListener('visibilitychange', observeCards); void nextTick(observeCards); });
onBeforeUnmount(() => { mounted = false; observer?.disconnect(); document.removeEventListener('visibilitychange', observeCards); });

const historyFilter = ref('ALL'), historyPage = ref(0), historyPageSize = 12;
const history = computed(() => (page.value?.history ?? []).filter(row => historyFilter.value === 'ALL' || row.targetId === historyFilter.value));
const historyPageCount = computed(() => Math.max(1, Math.ceil(history.value.length / historyPageSize)));
const historyRows = computed(() => history.value.slice(historyPage.value * historyPageSize,(historyPage.value+1)*historyPageSize));
watch(historyFilter, () => { historyPage.value = 0; });
watch(historyPageCount, count => { historyPage.value = Math.min(historyPage.value,count-1); });
function clearHistory(): void {
  if (!page.value) return;
  const targetId = historyFilter.value === 'ALL' ? undefined : historyFilter.value;
  beginConfirmation({ method: 'history/clear', payload: { expectedRevision: page.value.revision, ...(targetId ? { targetId } : {}) } },
    '确认清除启动历史？', targetId ? `清除「${labelFor(targetId)}」的历史，不删除收藏。` : '清除全部本地启动历史，不删除任何快捷收藏或场景。');
}
const reasonText = { DUPLICATE: '同一目标重复', UNAVAILABLE: '未授权或停用', CHANGED: '档案或目标已变化', STOPPED: '失败后停止', CANCELLED: '已取消', POLICY_DENIED: '权限检查未通过' };
const confirmDialog = ref<HTMLDialogElement | null>(null);
watch(confirmation, value => {
  void nextTick(() => {
    const dialog = confirmDialog.value;
    if (!dialog) return;
    if (value && !dialog.open) dialog.showModal(); else if (!value && dialog.open) dialog.close();
  });
});
async function acceptConfirmation(): Promise<void> {
  const method = confirmation.value?.intent.method;
  if (await confirm()) {
    if (method === 'action/metadata' || method === 'action/delete' || method === 'action/revoke') actionEdit.value = null;
    if (method === 'routine/create' || method === 'routine/update' || method === 'routine/delete') resetRoutine();
  }
}
watch(generation, () => { replacing.value = null; website.value = ''; addLabel.value = ''; addRecommendable.value = false; actionEdit.value = null; resetRoutine(); historyFilter.value = 'ALL'; historyPage.value = 0; });
</script>

<template>
  <div class="page-intro panel workspace-intro">
    <span class="panel-symbol accent-blue"><Icon name="workspace" /></span>
    <div><span class="eyebrow">Personal workspace · 本地快捷工作台</span><h2>把常用工作组合交给小伙伴</h2><p>收藏安全验证过的本地应用、目录和网页；每次启动仍由你主动确认，不会自动在开机时运行。</p></div>
    <button type="button" class="button button-secondary" :disabled="generation === null || busy || querying" @click="reload"><Icon name="refresh" />{{ querying ? '读取中…' : '刷新' }}</button>
  </div>
  <div v-if="error" class="feedback feedback-error" role="alert"><div><strong>工作台提示</strong><p>{{ error }}</p></div><button type="button" class="button button-secondary" :disabled="busy || querying || generation === null" @click="reload">重新读取</button></div>
  <div v-if="notice" class="workspace-notice panel" role="status">{{ notice }}</div>
  <section v-if="!page" class="panel empty-state" :aria-busy="querying"><Icon name="workspace" /><h2>{{ querying ? '正在读取快捷工作台…' : '等待本地工作台档案' }}</h2><p>没有实际服务档案时，不显示模拟收藏或提供启动操作。</p></section>
  <template v-else>
    <div class="workspace-summary panel"><div><span class="small muted">可用收藏</span><strong>{{ page.actions.filter(actionCanRun).length }} / {{ page.actions.length }}</strong></div><div><span class="small muted">工作场景</span><strong>{{ page.routines.length }}</strong></div><div><span class="small muted">本地习惯推荐</span><strong>{{ page.settings.enabled ? '已开启' : '未开启' }}</strong></div><div><span class="small muted">今日建议展示</span><strong>{{ page.shownToday }} / 2</strong></div></div>

    <section ref="recSection" class="panel workspace-section">
      <div class="section-heading"><div><span class="eyebrow">Your usual rhythm</span><h2>小伙伴的今日建议</h2></div><span class="workspace-badge">{{ page.shownToday }}/2 次</span></div>
      <p class="muted small" v-if="!page.settings.enabled">习惯推荐默认关闭。若你愿意，可在本页下方开启；只分析本应用中明确启动过的收藏。</p>
      <p class="muted small" v-else-if="cards.length === 0">今天暂时没有新建议。至少三次独立的成功手动启动后才可能形成建议，不会从后台程序活动学习。</p>
      <div v-else class="workspace-grid rec-grid">
        <article v-for="card in cards" :key="card.targetId" class="workspace-card rec-card" :data-recommendation-target="card.targetId">
          <span class="workspace-badge accent-blue">{{ weekdayText[card.evidence.weekdayKind] }} · {{ periodText[card.evidence.period] }}</span><h3>{{ card.label }}</h3>
          <p class="muted small">最近 7 天手动 {{ card.evidence.count7 }} 次，30 天 {{ card.evidence.count30 }} 次；同时间段 {{ card.evidence.sameLocalPeriod }} 次。</p>
          <p v-if="card.routineSuggestion.length > 1" class="small">常一起使用：{{ card.routineSuggestion.map(labelFor).join('、') }}（共用记录 {{ card.evidence.sharedUses }}）</p>
          <div class="workspace-buttons"><button class="button button-primary" type="button" :disabled="!canAct || !recommendationIntent(card)" @click="runRecommendation(card)">启动收藏</button>
            <button v-if="card.routineSuggestion.length > 1" class="button button-secondary" type="button" :disabled="!canAct || !recommendationDraft(card)" @click="useSuggestion(card)">编辑为新场景</button></div>
          <div class="workspace-buttons subtle-actions"><button type="button" :disabled="!canAct" @click="recommendationPreference(card.targetId,'IGNORE')">忽略 7 天</button><button type="button" :disabled="!canAct" @click="recommendationPreference(card.targetId,'EXCLUDE')">不再推荐</button></div>
        </article>
      </div>
    </section>

    <section ref="pickSection" class="panel workspace-section">
      <div class="section-heading"><div><span class="eyebrow">Native approval</span><h2>{{ replacing ? `重新授权 · ${replacing.label}` : '新增快捷收藏' }}</h2></div><button v-if="replacing || approval" class="button button-secondary" type="button" :disabled="busy" @click="resetPick">取消选择</button></div>
      <p class="muted small">应用和目录必须通过系统选择器获取；网页仅允许 HTTPS，地址只是待确认的候选。系统会检查并要求授权，网页候选不会直接启动。</p>
      <div class="workspace-form">
        <label>目标类型<select v-model="kind" :disabled="!canAct || !!approval"><option value="WIN32_EXE">Windows 应用（EXE）</option><option value="FOLDER">本机目录</option><option value="HTTPS">HTTPS 网页</option></select></label>
        <label v-if="kind === 'HTTPS'">网页候选地址<input v-model.trim="website" type="url" placeholder="https://example.com/" maxlength="2048" autocomplete="off" :disabled="!canAct || !!approval" /></label>
        <button v-if="!approval" type="button" class="button button-primary" :disabled="!canAct || (kind === 'HTTPS' && !website) || (!replacing && page.actions.length >= workspaceLimits.actions)" @click="pick">{{ busy ? '等待系统确认…' : '选择并请求授权' }}</button>
      </div>
      <div v-if="approval" class="workspace-receipt"><span class="workspace-badge">等待保存 · 单次授权</span><strong>{{ approval.selection.preview }}</strong><small class="muted">{{ targetKindText[approval.selection.kind] }} · 授权在 {{ new Date(approval.selection.expiresAt).toLocaleTimeString() }} 前有效</small>
        <div v-if="!replacing" class="workspace-form"><label>收藏名称<input v-model="addLabel" maxlength="80" :disabled="busy" /></label><label class="check-field"><input v-model="addRecommendable" type="checkbox" :disabled="busy" />允许作为建议目标</label></div>
        <p v-else class="small muted">保留此收藏的名称；旧授权和相关使用证据将被新目标替换。</p>
        <div class="workspace-buttons"><button class="button button-primary" type="button" :disabled="!canAct || (!replacing && !addLabel.trim())" @click="commitPick">{{ replacing ? '保存重新授权' : '保存快捷收藏' }}</button><button class="button button-secondary" type="button" :disabled="busy" @click="resetPick">放弃授权</button></div>
      </div>
    </section>

    <section class="panel workspace-section">
      <div class="section-heading"><div><span class="eyebrow">Saved shortcuts</span><h2>快捷收藏</h2></div><span class="workspace-badge">{{ page.actions.length }}/100</span></div>
      <p v-if="page.actions.length === 0" class="small muted">还未收藏，先使用上方的系统选择和授权功能。</p>
      <label v-if="page.actions.length" class="check-field small"><input v-model="clearOnRevoke" type="checkbox" :disabled="!canAct" />撤销时同时清理对应历史</label>
      <div class="workspace-grid"><article v-for="action in page.actions" :key="action.id" class="workspace-card">
        <div class="card-title"><span class="workspace-badge">{{ targetKindText[action.kind] }}</span><span class="small" :class="actionCanRun(action) ? 'state-ok' : 'muted'">{{ !action.approved ? '已撤销' : action.enabled ? '可启动' : '已停用' }}</span></div>
        <h3>{{ action.label }}</h3><p class="muted small">{{ action.preview ?? '需要重新授权' }} · {{ action.recommendable ? '允许推荐' : '不参与推荐' }}</p>
        <div v-if="actionEdit?.actionId === action.id" class="edit-box">
          <label>名称<input v-model="actionEdit.label" maxlength="80" :disabled="!canAct" /></label>
          <label class="check-field"><input v-model="actionEdit.enabled" type="checkbox" :disabled="!canAct || !action.approved" />启用</label>
          <label class="check-field"><input v-model="actionEdit.recommendable" type="checkbox" :disabled="!canAct || !action.approved" />允许本机推荐及快捷建议</label>
          <div class="workspace-buttons"><button class="button button-primary" type="button" :disabled="!canAct || !actionEdit.label.trim()" @click="reviewAction">确认修改</button><button class="button button-secondary" type="button" :disabled="busy" @click="actionEdit = null">取消</button></div>
        </div>
        <div v-else class="workspace-buttons"><button class="button button-primary" type="button" :disabled="!canAct || !actionCanRun(action)" @click="runAction(action.id)">{{ runningActionId === action.id ? '启动确认中…' : '启动' }}</button><button class="button button-secondary" type="button" :disabled="!canAct" @click="editAction(action)">编辑</button></div>
        <div class="workspace-buttons subtle-actions"><button type="button" :disabled="!canAct" @click="startReapproval(action)">重新授权</button><button v-if="action.approved" type="button" :disabled="!canAct" @click="revoke(action)">撤销授权</button><button class="danger-text" type="button" :disabled="!canAct" @click="removeAction(action)">删除</button></div>
      </article></div>
    </section>

    <section ref="routineSection" class="panel workspace-section">
      <div class="section-heading"><div><span class="eyebrow">One-click routine</span><h2>{{ editingRoutine ? '编辑快捷场景' : '组合快捷场景' }}</h2></div><span class="workspace-badge">最多 12 个目标</span></div>
      <p class="small muted">添加并排列你已授权的收藏，可自行设置启动方式。每次运行都必须再次确认完整场景。</p>
      <div v-if="!editingRoutine" class="routine-templates">
        <h3 id="routine-templates-heading">从模板开始</h3>
        <ul class="routine-template-list" aria-labelledby="routine-templates-heading">
          <li v-for="template in starterRoutineTemplates" :key="template.id">
            <button class="button button-secondary routine-template" type="button" :disabled="!canChooseTemplate" @click="useTemplate(template)">
              <strong>{{ template.label }}</strong>
              <span class="small muted">例如{{ template.examples }}</span>
            </button>
          </li>
        </ul>
      </div>
      <div class="workspace-form"><label>场景名称<input ref="routineName" v-model="routineDraft.name" maxlength="80" placeholder="例如：晨间工作" :disabled="!canAct" /></label>
        <label>执行方式<select v-model="routineDraft.mode" :disabled="!canAct"><option value="SEQUENTIAL">串行启动</option><option value="PARALLEL">有限并行（最多 3 个）</option></select></label>
        <label>间隔（毫秒）<input v-model.number="routineDraft.delayMs" type="number" min="0" max="5000" step="100" :disabled="!canAct || routineDraft.mode === 'PARALLEL'" /></label>
        <label>失败策略<select v-model="routineDraft.failurePolicy" :disabled="!canAct || routineDraft.mode === 'PARALLEL'"><option value="CONTINUE">继续剩余目标</option><option value="STOP">停止剩余目标</option></select></label></div>
      <div class="workspace-form"><label>添加收藏<select v-model="candidateId" :disabled="!canAct || !candidates.length"><option value="">选择一个可用收藏</option><option v-for="action in candidates" :key="action.id" :value="action.id">{{ action.label }}</option></select></label><button type="button" class="button button-secondary" :disabled="!canAct || !candidateId || routineDraft.targetIds.length >= 12" @click="appendTarget">添加</button></div>
      <ol class="ordered-targets"><li v-for="(targetId,index) in routineDraft.targetIds" :key="targetId"><strong>{{ index+1 }}. {{ labelFor(targetId) }}</strong><span v-if="!actionCanRun(actionById(targetId))" class="danger-text small">不可用，请移除</span><div class="workspace-buttons"><button type="button" :disabled="!canAct || index === 0" @click="routineDraft.targetIds = moveRoutineTarget(routineDraft.targetIds,index,-1)">上移</button><button type="button" :disabled="!canAct || index === routineDraft.targetIds.length-1" @click="routineDraft.targetIds = moveRoutineTarget(routineDraft.targetIds,index,1)">下移</button><button type="button" :disabled="!canAct" @click="routineDraft.targetIds.splice(index,1)">移除</button></div></li></ol>
      <p class="small muted">{{ routineDraft.targetIds.length }}/12 · 重复目标固定跳过（无重复启动）</p>
      <div class="workspace-buttons"><button class="button button-primary" type="button" :disabled="!canAct || !draftDefinition || (!editingRoutine && !canCreateRoutine)" @click="reviewRoutine">{{ editingRoutine ? '保存修改' : '创建场景' }}</button><button type="button" class="button button-secondary" :disabled="busy" @click="resetRoutine">清空草稿</button></div>
      <div class="workspace-grid saved-routines"><article v-for="routine in page.routines" :key="routine.id" class="workspace-card"><div class="card-title"><span class="workspace-badge">{{ routine.mode === 'SEQUENTIAL' ? '串行' : '并行' }}</span><span class="small muted">{{ routine.targetIds.length }} 项</span></div><h3>{{ routine.name }}</h3><p class="small muted">{{ routine.targetIds.map(labelFor).join(' → ') }}</p><p class="small">{{ routine.mode === 'SEQUENTIAL' ? `间隔 ${routine.delayMs}ms` : '最多 3 个并行' }} · {{ routine.failurePolicy === 'STOP' ? '失败后停止' : '继续剩余' }}</p>
        <div class="workspace-buttons"><button type="button" class="button button-primary" :disabled="!canAct" @click="runRoutine(routine.id)">{{ runningRoutineId === routine.id ? '正在运行…' : '运行场景' }}</button><button type="button" class="button button-secondary" :disabled="!canAct" @click="editRoutine(routine)">编辑</button><button type="button" class="button button-secondary" :disabled="!canAct" @click="removeRoutine(routine)">删除</button><button v-if="runningRoutineId === routine.id" type="button" class="button button-secondary" :disabled="cancelling" @click="cancelRoutine">{{ cancelling ? '取消请求中…' : '取消剩余任务' }}</button></div>
      </article></div>
      <div v-if="routineResult" class="workspace-receipt"><strong>{{ page.routines.find(row => row.id === routineResult?.routineId)?.name ?? '已运行场景' }} · 调度结果 {{ routineResult.cancelled ? '（用户取消）' : '' }}</strong><ol class="ordered-targets"><li v-for="target in routineResult.targets" :key="target.targetId"><span>{{ labelFor(target.targetId) }}</span><span :class="target.outcome === 'ACCEPTED' ? 'state-ok' : 'muted'">{{ outcomeText[target.outcome] }}{{ target.reason ? ` · ${reasonText[target.reason]}` : '' }}</span></li></ol><p class="small muted">「系统已接受」只表示系统接收请求；不代表外部应用或网页已加载完成。未确认的结果不会自动重试。</p></div>
    </section>

    <section class="panel workspace-section"><div class="section-heading"><div><span class="eyebrow">Local privacy</span><h2>本地习惯推荐与隐私</h2></div></div>
      <p class="small muted">默认关闭。启用后只保留本应用内、你主动授权的启动结果（目标 ID、结果、来源、5 分钟时间桶、本地时区偏移）；不监听外部程序，不读取键盘、窗口、浏览器历史或进行自动启动。</p>
      <div class="workspace-form"><label class="check-field"><input v-model="tracking" type="checkbox" :disabled="!canAct" />启用本地习惯记录与推荐</label><label>历史保留<select v-model.number="retention" :disabled="!canAct"><option :value="7">7 天</option><option :value="30">30 天</option></select></label><label class="check-field"><input v-model="clearWithSettings" type="checkbox" :disabled="!canAct" />同时清除现有历史</label><button type="button" class="button button-primary" :disabled="!canAct" @click="settingsReview">保存设置</button></div>
      <div v-if="page.preferences.length" class="preferences-list"><h3>建议屏蔽列表</h3><div v-for="pref in page.preferences" :key="pref.targetId" class="workspace-inline"><span>{{ labelFor(pref.targetId) }} · {{ pref.permanentlyExcluded ? '不再推荐' : `忽略至 ${new Date(pref.ignoredUntil ?? 0).toLocaleDateString()}` }}</span><button type="button" class="button button-secondary" :disabled="!canAct" @click="recommendationPreference(pref.targetId,'RESTORE')">恢复推荐</button></div></div>
    </section>
    <section class="panel workspace-section history-section"><div class="section-heading"><div><span class="eyebrow">Local launch history</span><h2>启动记录</h2></div><span class="workspace-badge">{{ page.history.length }} 条</span></div>
      <div class="workspace-form"><label>按收藏查询<select v-model="historyFilter" :disabled="busy"><option value="ALL">全部收藏</option><option v-for="action in page.actions" :key="action.id" :value="action.id">{{ action.label }}</option></select></label><button class="button button-secondary" type="button" :disabled="!canAct || !history.length" @click="clearHistory">{{ historyFilter === 'ALL' ? '清除全部历史' : '清除此收藏历史' }}</button></div>
      <p v-if="!history.length" class="small muted">当前没有保留的启动记录。</p>
      <div v-else class="history-table"><div class="history-row history-head"><span>目标</span><span>来源 / 结果</span><span>时间桶</span></div><div v-for="fact in historyRows" :key="`${fact.targetId}:${fact.runId}`" class="history-row"><span>{{ labelFor(fact.targetId) }}</span><span>{{ sourceText[fact.source] }} · {{ outcomeText[fact.outcome] }}</span><span>{{ historyTime(fact) }}</span></div></div>
      <div v-if="historyPageCount > 1" class="workspace-buttons"><button type="button" class="button button-secondary" :disabled="historyPage === 0" @click="historyPage--">上一页</button><span class="small muted">{{ historyPage+1 }}/{{ historyPageCount }}</span><button type="button" class="button button-secondary" :disabled="historyPage+1 >= historyPageCount" @click="historyPage++">下一页</button></div>
    </section>
  </template>
  <dialog ref="confirmDialog" class="workspace-confirm" aria-labelledby="workspace-confirm-title" @cancel.prevent="closeConfirmation" @close="closeConfirmation"><div v-if="confirmation"><h2 id="workspace-confirm-title">{{ confirmation.title }}</h2><p>{{ confirmation.details }}</p><p v-if="!canConfirm" class="danger-text small">档案已变化，请关闭并重新确认。</p><div class="workspace-buttons"><button type="button" class="button button-primary" :disabled="!canConfirm" @click="acceptConfirmation">确认操作</button><button type="button" class="button button-secondary" @click="closeConfirmation">取消</button></div></div></dialog>
</template>

<style scoped>
.routine-templates {
  margin-top: 16px;
}
.routine-template-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.routine-template {
  display: grid;
  justify-content: stretch;
  justify-items: start;
  align-content: start;
  gap: 3px;
  width: 100%;
  height: 100%;
  text-align: start;
  white-space: normal;
}
.workspace-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;padding:18px;margin-bottom:16px}.workspace-summary>div{display:grid;gap:5px}.workspace-summary strong{font-size:1.15rem}.workspace-section{padding:20px;margin-bottom:16px;min-width:0}.workspace-section h3,.workspace-card p{margin:0}.workspace-section>.section-heading{margin-bottom:10px}.workspace-form{display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-top:14px}.workspace-form label,.edit-box label{display:grid;gap:5px;font-size:.82rem;color:inherit;min-width:0;max-width:100%}.workspace-form input:not([type=checkbox]),.workspace-form select,.edit-box input:not([type=checkbox]){font:inherit;color:inherit;background:rgba(91,114,141,.08);border:1px solid rgba(110,137,169,.4);border-radius:8px;padding:8px 10px;min-width:130px;max-width:100%}.workspace-form label:has(input[type=url]){flex:1;min-width:200px}.workspace-form .check-field,.check-field{display:flex!important;align-items:center;gap:7px}.check-field input{accent-color:#6782b7}.workspace-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.workspace-card{display:grid;align-content:start;gap:10px;padding:15px;border:1px solid rgba(111,140,174,.26);border-radius:12px;overflow-wrap:anywhere}.card-title,.workspace-inline{display:flex;justify-content:space-between;align-items:center;gap:8px}.workspace-badge{font-size:.7rem;border:1px solid rgba(111,140,174,.25);border-radius:20px;padding:4px 9px;white-space:nowrap;justify-self:start}.workspace-buttons{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.workspace-buttons .button{white-space:normal}.subtle-actions button,.ordered-targets button{background:transparent;border:0;border-radius:6px;padding:5px 7px;font:inherit;color:inherit;cursor:pointer;font-size:.78rem}.subtle-actions button:not(:disabled):hover,.ordered-targets button:not(:disabled):hover{background:rgba(111,140,174,.15)}.subtle-actions button:disabled,.ordered-targets button:disabled{opacity:.4}.state-ok{color:#3b9879}.danger-text{color:#b8536c!important}.workspace-notice{padding:12px 18px;margin-bottom:14px;color:#357f77}.workspace-receipt,.edit-box{display:grid;gap:9px;border:1px dashed rgba(111,140,174,.5);border-radius:10px;padding:14px;margin-top:14px;background:rgba(105,137,170,.06)}.ordered-targets{padding:0;list-style:none;display:grid;gap:6px;margin:12px 0}.ordered-targets li{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;background:rgba(111,140,174,.08);border-radius:8px;font-size:.84rem}.saved-routines,.preferences-list{margin-top:18px}.preferences-list .workspace-inline{padding:8px 0;border-bottom:1px solid rgba(111,140,174,.18);font-size:.84rem;flex-wrap:wrap}.history-table{display:grid;gap:1px;margin:14px 0;overflow-wrap:anywhere}.history-row{display:grid;grid-template-columns:1fr 1.45fr 1.6fr;gap:10px;padding:9px 8px;font-size:.78rem;border-bottom:1px solid rgba(111,140,174,.16)}.history-head{font-weight:700;background:rgba(111,140,174,.1)}.workspace-confirm{max-width:min(520px,92vw);border:1px solid rgba(111,140,174,.45);border-radius:15px;padding:24px;color:inherit;background:var(--panel-bg,#fff);box-shadow:0 18px 55px #19203530}.workspace-confirm::backdrop{background:#14213d55}.workspace-confirm p{white-space:pre-wrap;overflow-wrap:anywhere}.workspace-confirm .workspace-buttons{margin-top:20px;justify-content:flex-end}@media(max-width:720px){.workspace-grid{grid-template-columns:1fr}.workspace-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.workspace-section{padding:14px}.history-row{grid-template-columns:1fr 1.2fr;gap:4px}.history-row span:last-child{grid-column:1/-1}.history-head span:last-child{grid-column:auto}}
</style>
