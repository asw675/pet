<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { proactiveLimits } from '@pet-desktop/contracts/proactive';
import type { ProactiveNotice, ProactiveNoticePage, ProactiveSettings, ProactiveTrigger } from '@pet-desktop/contracts/proactive';
import { proactiveResultSchema } from '../../../shared/proactive-ipc';
import type { ProactiveIntent, ProactiveResult } from '../../../shared/proactive-ipc';
import { formatTime } from '../../shared/presentation';
import type { AiProjection, AiScopeToken } from '../useAiProjection';

const { context } = defineProps<{ context: AiProjection }>();
const { bridge, generation, epoch, petId } = context;
const settings = shallowRef<ProactiveSettings | null>(null);
const page = shallowRef<ProactiveNoticePage | null>(null);
const enabled = ref(false), useLocalAi = ref(false), quiet = ref(true);
const quietStart = ref('22:00'), quietEnd = ref('08:00');
const savePending = ref(false), listPending = ref(false), noticePending = ref(false);
const offset = ref(0), filter = ref<'ALL' | 'UNREAD'>('ALL');
const settingsProblem = ref(''), noticesProblem = ref(''), feedback = ref('');
const limit = 10;
const triggers: Record<ProactiveTrigger, string> = { RETURNED: '旅行归来', LOW_ENERGY: '精力偏低', IDLE: '久未互动' };
const statuses = { PENDING: '正在生成', READY: '未读', ACKNOWLEDGED: '已读', DISMISSED: '已忽略' };
const responseKinds = { RULE: '角色台词', LOCAL_AI: '本机 AI', MOCK: '模拟服务' };
let settingsSequence = 0, listSequence = 0;
let unsubscribe: (() => void) | undefined;
let disposed = false;

function canApply(scope: AiScopeToken): boolean { return !disposed && context.isCurrent(scope); }

async function request(intent: ProactiveIntent): Promise<ProactiveResult | null> {
  if (!bridge) return null;
  try {
    const parsed = proactiveResultSchema.safeParse(await bridge.proactiveRequest(intent));
    if (!parsed.success || parsed.data.method !== intent.method) return null;
    if (parsed.data.ok && parsed.data.data.petId !== intent.payload.petId) return null;
    return parsed.data;
  } catch { return null; }
}

function failure(response: ProactiveResult | null): string {
  return response?.ok === false && response.error.code === 'CONFLICT'
    ? '设置已变更。刷新后重新核对。' : '暂时无法读取或修改主动陪伴设置。';
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function minutes(value: string): number | null {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

const quietStartMinutes = computed(() => minutes(quietStart.value));
const quietEndMinutes = computed(() => minutes(quietEnd.value));
const validQuiet = computed(() => !quiet.value
  || (quietStartMinutes.value !== null && quietEndMinutes.value !== null && quietStartMinutes.value !== quietEndMinutes.value));

function adopt(value: ProactiveSettings): void {
  settings.value = value;
  enabled.value = value.enabled;
  useLocalAi.value = value.useLocalAi;
  quiet.value = value.quietHours !== null;
  quietStart.value = clock(value.quietHours?.startMinute ?? 22 * 60);
  quietEnd.value = clock(value.quietHours?.endMinute ?? 8 * 60);
}

async function readSettings(): Promise<void> {
  const scope = context.token(), own = ++settingsSequence;
  if (!scope) return;
  const response = await request({ method: 'settings/get', payload: { petId: scope.petId } });
  if (!canApply(scope) || settingsSequence !== own) return;
  if (response?.ok && response.method === 'settings/get') { adopt(response.data); settingsProblem.value = ''; }
  else settingsProblem.value = failure(response);
}

async function readNotices(): Promise<void> {
  const scope = context.token(), own = ++listSequence;
  if (!scope) return;
  listPending.value = true;
  const response = await request({ method: 'notices/list', payload: { petId: scope.petId, offset: offset.value, limit, filter: filter.value } });
  if (!canApply(scope) || listSequence !== own) return;
  listPending.value = false;
  if (response?.ok && response.method === 'notices/list') { page.value = response.data; noticesProblem.value = ''; }
  else noticesProblem.value = failure(response);
}

async function save(): Promise<void> {
  const scope = context.token(), current = settings.value;
  if (!scope || !current || current.petId !== scope.petId || savePending.value || !validQuiet.value) return;
  const startMinute = quietStartMinutes.value, endMinute = quietEndMinutes.value;
  const quietHours = quiet.value && startMinute !== null && endMinute !== null ? { startMinute, endMinute } : null;
  const own = ++settingsSequence;
  savePending.value = true;
  feedback.value = '';
  const response = await request({ method: 'settings/set', payload: {
    petId: scope.petId, expectedRevision: current.revision, enabled: enabled.value, useLocalAi: enabled.value && useLocalAi.value, quietHours,
  } });
  if (!canApply(scope) || settingsSequence !== own) return;
  savePending.value = false;
  if (response?.ok && response.method === 'settings/set') {
    adopt(response.data);
    settingsProblem.value = '';
    feedback.value = '主动陪伴设置已保存。';
  } else settingsProblem.value = failure(response);
}

async function updateNotice(row: ProactiveNotice, method: 'notice/acknowledge' | 'notice/dismiss'): Promise<void> {
  const scope = context.token();
  if (!scope || !page.value?.rows.includes(row) || row.petId !== scope.petId || noticePending.value) return;
  noticePending.value = true;
  const response = await request({ method, payload: { petId: scope.petId, noticeId: row.noticeId } });
  if (!canApply(scope)) return;
  noticePending.value = false;
  if (response?.ok && (response.method === 'notice/acknowledge' || response.method === 'notice/dismiss')) await readNotices();
  else noticesProblem.value = failure(response);
}

watch([generation, epoch, petId], () => {
  settingsSequence++;
  listSequence++;
  settings.value = null;
  page.value = null;
  offset.value = 0;
  filter.value = 'ALL';
  savePending.value = false;
  listPending.value = false;
  noticePending.value = false;
  settingsProblem.value = '';
  noticesProblem.value = '';
  feedback.value = '';
  void readSettings();
  void readNotices();
}, { immediate: true });
watch([offset, filter], () => { void readNotices(); });
watch(enabled, value => { if (!value) useLocalAi.value = false; });
onMounted(() => {
  unsubscribe = bridge?.subscribeProactiveNotices(event => {
    if (event.notice.petId === petId.value && offset.value === 0) void readNotices();
  });
});
onBeforeUnmount(() => { disposed = true; unsubscribe?.(); });
</script>

<template>
  <section class="panel ai-section">
    <div class="ai-heading">
      <h3>主动陪伴</h3>
      <button type="button" class="button button-secondary" :disabled="savePending" @click="readSettings">刷新设置</button>
    </div>
    <p v-if="settingsProblem" class="ai-warning" role="alert">{{ settingsProblem }}</p>
    <p v-else-if="!settings" class="small muted">读取此伙伴的主动陪伴设置…</p>
    <form v-if="settings" class="ai-box provider-form" @submit.prevent="save">
      <fieldset :disabled="savePending" class="proactive-fields">
        <label class="checkline"><input v-model="enabled" type="checkbox" />允许此伙伴主动问候</label>
        <label class="checkline"><input v-model="useLocalAi" :disabled="!enabled" type="checkbox" />允许使用已绑定的本机或模拟模型生成问候</label>
        <p class="small muted">无可用本机模型时使用角色台词。问候使用文字气泡，并保存在下方记录。</p>
        <label class="checkline"><input v-model="quiet" type="checkbox" />设置静默时段（本机时间）</label>
        <div v-if="quiet" class="provider-budget">
          <label>开始 <input v-model="quietStart" type="time" required /></label>
          <label>结束 <input v-model="quietEnd" type="time" required /></label>
        </div>
        <p v-if="!validQuiet" class="small">请选择不同的开始和结束时间。</p>
        <div class="ai-actions"><button type="submit" class="button button-primary" :disabled="!validQuiet">保存设置</button></div>
      </fieldset>
    </form>
    <p v-if="feedback" class="ai-note" role="status">{{ feedback }}</p>
    <div class="ai-heading">
      <h3>问候记录</h3>
      <div class="ai-actions">
        <label>范围 <select v-model="filter" @change="offset = 0"><option value="ALL">全部</option><option value="UNREAD">未读</option></select></label>
        <button type="button" class="button button-secondary" :disabled="listPending" @click="readNotices">刷新记录</button>
      </div>
    </div>
    <p v-if="noticesProblem" class="ai-warning" role="alert">{{ noticesProblem }}</p>
    <div :aria-busy="listPending" class="proactive-fields">
      <p v-if="page?.rows.length === 0" class="small muted">暂无问候记录。</p>
      <article v-for="row in page?.rows ?? []" :key="row.noticeId" class="ai-box">
        <header class="ai-heading"><strong>{{ triggers[row.trigger] }}</strong><span class="small muted">{{ formatTime(row.createdAt) }} · {{ responseKinds[row.responseKind] }} · {{ statuses[row.deliveryStatus] }}</span></header>
        <p class="ai-plain">{{ row.text }}</p>
        <div v-if="row.deliveryStatus === 'READY' || row.deliveryStatus === 'ACKNOWLEDGED'" class="ai-actions">
          <button v-if="row.deliveryStatus === 'READY'" type="button" class="button button-secondary" :disabled="noticePending" @click="updateNotice(row, 'notice/acknowledge')">标为已读</button>
          <button type="button" class="button button-secondary" :disabled="noticePending" @click="updateNotice(row, 'notice/dismiss')">忽略</button>
        </div>
      </article>
    </div>
    <div v-if="page && (offset || page.rows.length === limit)" class="ai-pagination">
      <button type="button" class="button button-secondary" :disabled="!offset || listPending" @click="offset -= limit">较新</button>
      <span>第 {{ Math.floor(offset / limit) + 1 }} 页</span>
      <button type="button" class="button button-secondary" :disabled="page.rows.length < limit || listPending || offset + limit > proactiveLimits.maxOffset" @click="offset += limit">较早</button>
    </div>
  </section>
</template>

<style scoped>
.proactive-fields { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 0; border: 0; }
</style>
