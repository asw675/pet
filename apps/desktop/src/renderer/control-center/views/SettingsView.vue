<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { defaultHostShortcutBindings, hostShortcutBindingsSchema, hostShortcutIds } from '@pet-desktop/contracts/host-shortcuts';
import type { HostShortcutBindings, HostShortcutId } from '@pet-desktop/contracts/host-shortcuts';
import { hostSettingsResultSchema, hostShortcutBindingsResultSchema, periodicBackupStatusSchema, restoreBackupResultSchema, restoreBackupStatusSchema } from '../../../shared/host-settings-ipc';
import type { HostSettings, HostShortcutBindingsView } from '../../../shared/host-settings-ipc';
import { diagnosticsExportResultSchema } from '../../../shared/diagnostics-ipc';
import {
  backupViewResultSchema, hostPreferencesViewResultSchema, hostScalePercents, preferenceDraft, preferenceSaveMatches,
  preferenceSavePayload, resolveBackupRestoreViewBridge, resolveHostPreferencesViewBridge, resolveHostSettingsViewBridge,
} from '../../shared/host-settings-view-policy';
import type { HostPreferenceEdit, HostPreferencesView, HostSettingsViewBridge } from '../../shared/host-settings-view-policy';
import { useAppStore } from '../../shared/store';
import { serviceStatusLabel } from '../../shared/presentation';
import Icon from '../components/Icon.vue';
import ModeControls from '../components/ModeControls.vue';
import CharacterPacksPanel from '../components/CharacterPacksPanel.vue';

const store = useAppStore();
const bridge = resolveHostSettingsViewBridge(window.petDesktop);
const preferencesBridge = resolveHostPreferencesViewBridge(window.petDesktop);
const restoreBridge = resolveBackupRestoreViewBridge(window.petDesktop);
const host = ref<HostSettings | null>(null);
const hostBusy = ref(false), hostError = ref('');
const preferences = ref<HostPreferencesView | null>(null), draft = ref<HostPreferenceEdit | null>(null);
const preferenceBusy = ref(false), preferenceFeedback = ref('');
const backupBusy = ref(false), backupFeedback = ref('');
const diagnosticsBridge = window.petDesktop?.role === 'control-center'
  && typeof window.petDesktop.exportDiagnostics === 'function' ? window.petDesktop : null;
const diagnosticsBusy = ref(false), diagnosticsFeedback = ref('');
const hotkeyBridge = window.petDesktop?.role === 'control-center'
  && typeof window.petDesktop.getHostShortcutBindings === 'function'
  && typeof window.petDesktop.saveHostShortcutBindings === 'function' ? window.petDesktop : null;
const bindingPreferences = ref<HostShortcutBindingsView | null>(null);
const bindingDraft = ref<HostShortcutBindings | null>(null);
const bindingsBusy = ref(false), bindingsFeedback = ref('');
const bindingModifiers = [
  { value: 'CommandOrControl+Shift', label: 'Ctrl + Shift' },
  { value: 'CommandOrControl+Alt', label: 'Ctrl + Alt' },
  { value: 'CommandOrControl+Alt+Shift', label: 'Ctrl + Alt + Shift' },
];
const bindingKeys = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
const restoreStatus = ref('');
const automaticBackupStatus = ref('');
const canRestore = computed(() => store.ready || (store.serviceStatus?.stage === 'UNAVAILABLE' && store.serviceStatus.generation > 0));
let mounted = true, hostEpoch = 0;
let preferenceEpoch = 0, backupEpoch = 0, restoreStatusEpoch = 0;
let automaticBackupEpoch = 0, automaticBackupPoll: number | undefined;
let recoveryGeneration: number | null = null;
const shortcutLabels = {
  OPEN_CONTROL_CENTER: '打开控制中心', TOGGLE_PET_VISIBILITY: '显示 / 隐藏桌宠', RESCUE_INTERACTION: '临时交互救援（20 秒）',
};
const shortcutStatus = {
  REGISTERED: '可用', CONFLICT: '按键冲突或系统未授予', DISABLED: '已关闭', UNSUPPORTED: '当前平台不支持',
  UNAVAILABLE: '宿主暂不可用', ERROR: '无法确认系统状态',
};
const loginReasons = {
  NON_WINDOWS: '仅支持 Windows 安装版。', DEVELOPMENT: '开发版不提供开机启动，避免启动通用 Electron 程序。',
  NOT_READY: '宿主尚未就绪。', STOPPED: '宿主正在退出。', OS_ERROR: '未能读取 Windows 的登录启动状态。',
};
const hostErrors = {
  INVALID_REQUEST: '设置请求无效。', FORBIDDEN: '当前窗口无权修改宿主设置。',
  SERVICE_UNAVAILABLE: '宿主或偏好存储暂不可用，请重新读取。',
  UNSUPPORTED: '当前平台或应用版本不支持此设置。',
  OS_REJECTED: 'Windows 未确认所请求的登录启动状态；请查看实际状态或系统启动应用设置。',
};
const preferenceSave = computed(() => preferenceSavePayload(preferences.value, draft.value));
const preferenceDirty = computed(() => preferenceSave.value !== null);
const canSetShortcuts = computed(() => host.value?.shortcuts.availability === 'READY'
  && (host.value.shortcuts.preferenceScope !== 'PERSISTED' || (store.ready && !preferenceDirty.value && !preferenceBusy.value))
  && !hostBusy.value && !backupBusy.value && !bindingsBusy.value && !bindingDraft.value);
const shortcutIssues = computed(() => host.value?.shortcuts.enabled === true &&
  host.value.shortcuts.entries.some(entry => entry.status === 'CONFLICT' || entry.status === 'ERROR'));
const login = computed(() => host.value?.loginStart ?? null);
async function hostOperation(operation: (current: HostSettingsViewBridge) => Promise<unknown>, refreshPreferences = false): Promise<void> {
  if (hostBusy.value) return;
  hostError.value = '';
  if (!bridge) { hostError.value = '请从桌宠应用的控制中心打开设置。'; return; }
  hostBusy.value = true;
  const epoch = ++hostEpoch;
  try {
    const response = hostSettingsResultSchema.safeParse(await operation(bridge));
    if (!mounted || epoch !== hostEpoch) return;
    if (!response.success) { hostError.value = '宿主返回了无法确认的设置状态。'; host.value = null; return; }
    if (response.data.ok) {
      host.value = response.data.settings;
      if (refreshPreferences) void readPreferences();
    }
    else {
      host.value = response.data.settings;
      hostError.value = hostErrors[response.data.code];
    }
  } catch {
    if (mounted && epoch === hostEpoch) { hostError.value = '无法读取或更改宿主状态，请刷新后再确认。'; host.value = null; }
  } finally { if (mounted && epoch === hostEpoch) hostBusy.value = false; }
}
function refreshHost(): void { void hostOperation(current => current.getHostSettings()); }
async function openBindingEditor(): Promise<void> {
  if (!hotkeyBridge || bindingsBusy.value || !store.ready) return;
  bindingsBusy.value = true;
  bindingsFeedback.value = '';
  const generation = store.serviceStatus?.generation;
  try {
    const reply = hostShortcutBindingsResultSchema.safeParse(await hotkeyBridge.getHostShortcutBindings());
    if (!mounted || !store.ready || store.serviceStatus?.generation !== generation) return;
    if (reply.success && reply.data.ok) {
      bindingPreferences.value = reply.data.preferences;
      bindingDraft.value = { ...reply.data.preferences.bindings };
    } else bindingsFeedback.value = '暂时无法读取已保存的热键。';
  } catch {
    if (mounted) bindingsFeedback.value = '暂时无法读取已保存的热键。';
  } finally { if (mounted) bindingsBusy.value = false; }
}
function changeBinding(id: HostShortcutId, part: 'modifier' | 'key', event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const current = bindingDraft.value?.[id];
  if (!current || !bindingDraft.value) return;
  const split = current.lastIndexOf('+');
  bindingDraft.value[id] = part === 'modifier' ? value + '+' + current.slice(split + 1) : current.slice(0, split + 1) + value;
  bindingsFeedback.value = '';
}
function closeBindingEditor(): void {
  bindingPreferences.value = null;
  bindingDraft.value = null;
  bindingsFeedback.value = '';
}
async function saveBindings(): Promise<void> {
  if (!hotkeyBridge || bindingsBusy.value || !bindingPreferences.value || !bindingDraft.value || !store.ready) return;
  const candidate = hostShortcutBindingsSchema.safeParse(bindingDraft.value);
  if (!candidate.success) {
    bindingsFeedback.value = '每项热键必须使用不同的有效组合。';
    return;
  }
  bindingsBusy.value = true;
  bindingsFeedback.value = '';
  const generation = store.serviceStatus?.generation;
  try {
    const reply = hostShortcutBindingsResultSchema.safeParse(await hotkeyBridge.saveHostShortcutBindings({
      expectedRevision: bindingPreferences.value.revision, bindings: candidate.data,
    }));
    if (!mounted || !store.ready || store.serviceStatus?.generation !== generation) return;
    if (reply.success && reply.data.ok) {
      closeBindingEditor();
      bindingsFeedback.value = '热键已保存。';
      refreshHost();
    } else if (reply.success && 'id' in reply.data) {
      bindingsFeedback.value = reply.data.code === 'CONFLICT'
        ? `「${shortcutLabels[reply.data.id]}」的新组合已被占用，当前已生效的热键继续保留。`
        : `Windows 无法验证「${shortcutLabels[reply.data.id]}」的新组合。`;
    } else if (reply.success && !reply.data.ok && reply.data.code === 'REVISION_CONFLICT') {
      closeBindingEditor();
      bindingsFeedback.value = '热键设置已更新，请重新打开改键。';
    } else bindingsFeedback.value = '暂时无法确认热键保存结果，请重试。';
  } catch {
    if (mounted) bindingsFeedback.value = '暂时无法确认热键保存结果，请重试。';
  } finally { if (mounted) bindingsBusy.value = false; }
}
function setShortcuts(enabled: boolean): void {
  if (canSetShortcuts.value) void hostOperation(current => current.setHostShortcutEnabled(enabled), true);
}
function setLoginStart(enabled: boolean): void {
  if (login.value?.availability === 'READY' && !hostBusy.value) void hostOperation(current => current.setLoginStart(enabled));
}
function preferenceError(code: string): string {
  if (code === 'REVISION_CONFLICT' || code === 'CONFLICT') return '偏好刚刚发生变化。请重新读取，确认后再保存。';
  if (code === 'FORBIDDEN') return '当前窗口无权修改偏好。';
  if (code === 'INVALID_REQUEST') return '偏好参数无效。';
  return '偏好未获确认，请重新读取实际设置。';
}
async function readPreferences(): Promise<void> {
  const epoch = ++preferenceEpoch;
  if (!preferencesBridge || !store.ready) {
    preferences.value = null; draft.value = null; preferenceBusy.value = false;
    preferenceFeedback.value = preferencesBridge ? '本地服务尚未就绪。' : '当前宿主未开放偏好保存和备份。';
    return;
  }
  preferenceBusy.value = true;
  preferenceFeedback.value = '';
  try {
    const result = hostPreferencesViewResultSchema.safeParse(await preferencesBridge.getHostPreferences());
    if (!mounted || epoch !== preferenceEpoch || !store.ready) return;
    if (!result.success || !result.data.ok) {
      preferences.value = null; draft.value = null;
      preferenceFeedback.value = result.success && !result.data.ok ? preferenceError(result.data.code) : '偏好响应无法确认。';
      return;
    }
    preferences.value = result.data.preferences; draft.value = preferenceDraft(result.data.preferences);
  } catch {
    if (mounted && epoch === preferenceEpoch) { preferences.value = null; draft.value = null; preferenceFeedback.value = '无法读取实际偏好。'; }
  } finally { if (mounted && epoch === preferenceEpoch) preferenceBusy.value = false; }
}
async function savePreferences(): Promise<void> {
  const input = preferenceSave.value;
  if (!input || !preferencesBridge || !store.ready || preferenceBusy.value || hostBusy.value || backupBusy.value) return;
  preferenceBusy.value = true; preferenceFeedback.value = '';
  const epoch = ++preferenceEpoch;
  try {
    const result = hostPreferencesViewResultSchema.safeParse(await preferencesBridge.saveHostPreferences(input));
    if (!mounted || epoch !== preferenceEpoch || !store.ready) return;
    if (!result.success || !result.data.ok || !preferenceSaveMatches(input, result.data.preferences)) {
      preferenceFeedback.value = result.success && !result.data.ok ? preferenceError(result.data.code) : '保存结果无法确认，请重新读取。';
      // No retry against a stale or ambiguous revision. Keep draft visible
      // for reference but require a fresh authority read before saving again.
      preferences.value = null;
      return;
    }
    preferences.value = result.data.preferences; draft.value = preferenceDraft(result.data.preferences);
    preferenceFeedback.value = '已保存桌宠显示偏好。';
  } catch {
    if (mounted && epoch === preferenceEpoch) { preferences.value = null; preferenceFeedback.value = '保存结果尚未确认，请重新读取。'; }
  } finally { if (mounted && epoch === preferenceEpoch) preferenceBusy.value = false; }
}
async function exportDiagnostics(): Promise<void> {
  if (!diagnosticsBridge || diagnosticsBusy.value) return;
  diagnosticsBusy.value = true;
  diagnosticsFeedback.value = '';
  try {
    const result = diagnosticsExportResultSchema.safeParse(await diagnosticsBridge.exportDiagnostics());
    if (!mounted) return;
    if (!result.success) diagnosticsFeedback.value = '无法确认导出结果。';
    else if (result.data.ok) diagnosticsFeedback.value = `已保存诊断报告，共 ${result.data.entries} 条记录。`;
    else if (result.data.code === 'DESTINATION_EXISTS') diagnosticsFeedback.value = '所选文件已存在，请选择新文件名。';
    else if (result.data.code === 'BUSY') diagnosticsFeedback.value = '请先结束当前操作，然后再导出。';
    else if (result.data.code !== 'CANCELLED') diagnosticsFeedback.value = '无法导出诊断报告。';
  } catch {
    if (mounted) diagnosticsFeedback.value = '无法导出诊断报告。';
  } finally { if (mounted) diagnosticsBusy.value = false; }
}

async function exportBackup(): Promise<void> {
  if (!preferencesBridge || !store.ready || backupBusy.value || preferenceBusy.value || hostBusy.value) return;
  backupBusy.value = true; backupFeedback.value = '';
  const epoch = ++backupEpoch;
  try {
    const result = backupViewResultSchema.safeParse(await preferencesBridge.exportBackup());
    if (!mounted || epoch !== backupEpoch) return;
    if (result.success && result.data.ok) backupFeedback.value = '备份已导出（数据库版本 ' + result.data.schemaVersion + '）。请妥善保存。';
    else if (result.success && !result.data.ok && result.data.code === 'CANCELLED') backupFeedback.value = '已取消备份导出。';
    else backupFeedback.value = '备份未获成功确认，请检查保存位置或本地服务状态；不会自动重试。';
  } catch {
    if (mounted && epoch === backupEpoch) backupFeedback.value = '备份结果无法确认。请检查保存位置后再决定是否重试。';
  } finally { if (mounted && epoch === backupEpoch) backupBusy.value = false; }
}
async function readRestoreStatus(): Promise<void> {
  const epoch = ++restoreStatusEpoch;
  if (!restoreBridge || !store.ready) return;
  const messages = {
    NONE: '', PENDING: '备份已校验，等待本地服务重启后恢复。',
    RESTORED: '上次恢复已完成。替换前的存档副本保留在应用数据目录。',
    FAILED: '上次恢复未完成，当前存档已保留。',
  };
  try {
    const result = restoreBackupStatusSchema.safeParse(await restoreBridge.getRestoreBackupStatus());
    if (mounted && epoch === restoreStatusEpoch && store.ready) {
      restoreStatus.value = result.success && result.data.ok ? messages[result.data.status] : '恢复状态暂不可用。';
    }
  } catch {
    if (mounted && epoch === restoreStatusEpoch && store.ready) restoreStatus.value = '恢复状态暂不可用。';
  }
}
async function readAutomaticBackupStatus(): Promise<void> {
  const epoch = ++automaticBackupEpoch;
  if (!restoreBridge?.getPeriodicBackupStatus || !store.ready) return;
  try {
    const parsed = periodicBackupStatusSchema.safeParse(await restoreBridge.getPeriodicBackupStatus());
    if (!mounted || epoch !== automaticBackupEpoch || !store.ready) return;
    if (!parsed.success || !parsed.data.ok) { automaticBackupStatus.value = '暂无法读取自动快照状态。'; return; }
    const { status, lastCompletedAt } = parsed.data;
    const latest = lastCompletedAt ? '最近的自动快照为 ' + new Date(lastCompletedAt).toLocaleString() + '。' : '';
    automaticBackupStatus.value = status === 'FAILED' ? latest + '自动快照暂未完成。请检查本地磁盘可用空间及文件访问权限。'
      : latest || '本地服务运行时会生成自动快照。';
  } catch {
    if (mounted && epoch === automaticBackupEpoch && store.ready) automaticBackupStatus.value = '暂无法读取自动快照状态。';
  }
}
async function restoreBackup(): Promise<void> {
  if (!restoreBridge || !canRestore.value || backupBusy.value || preferenceBusy.value || hostBusy.value) return;
  const requestedGeneration = store.serviceStatus?.stage === 'UNAVAILABLE' ? store.serviceStatus.generation : null;
  backupBusy.value = true; backupFeedback.value = '';
  const epoch = ++backupEpoch;
  try {
    const result = restoreBackupResultSchema.safeParse(await restoreBridge.restoreBackup());
    if (!mounted || epoch !== backupEpoch) return;
    if (result.success && result.data.ok) {
      if (requestedGeneration !== null) {
        recoveryGeneration = requestedGeneration;
        backupFeedback.value = '正在验证备份并尝试恢复本地服务。';
        refreshRecoveryOutcome();
      }
      return;
    }
    const code = result.success && !result.data.ok ? result.data.code : undefined;
    backupFeedback.value = code === 'CANCELLED' ? '已取消恢复。'
      : code === 'RESTART_REQUIRED' ? '备份已校验。下次启动应用时会尝试恢复。'
      : code === 'RESTORE_PREPARE_FAILED' ? '无法校验所选备份，请选择完整且版本兼容的 Pet Desktop 备份。'
      : code === 'BUSY' ? '本地服务正在使用，请在当前操作结束后重试。' : '恢复请求结果暂无法确认，请查看恢复状态。';
  } catch {
    if (mounted && epoch === backupEpoch) backupFeedback.value = '恢复请求结果暂无法确认，请查看恢复状态。';
  } finally {
    if (mounted && epoch === backupEpoch) {
      backupBusy.value = false;
      if (store.ready) void readRestoreStatus();
    }
  }
}
function refreshRecoveryOutcome(): void {
  const status = store.serviceStatus;
  if (recoveryGeneration === null || !status || status.generation <= recoveryGeneration) return;
  if (status.stage === 'READY') {
    recoveryGeneration = null;
    backupFeedback.value = '';
  } else if (status.stage === 'UNAVAILABLE') {
    recoveryGeneration = null;
    backupFeedback.value = '恢复未完成。请确认备份完整、本地文件未被占用，再选择备份重试。';
  }
}
function refreshSettings(): void { refreshRecoveryOutcome(); refreshHost(); void readPreferences(); void readRestoreStatus(); void readAutomaticBackupStatus(); }
watch(() => [store.ready, store.serviceStatus?.generation] as const, () => {
  closeBindingEditor();
  refreshSettings();
});
onMounted(() => {
  refreshSettings();
  if (restoreBridge?.getPeriodicBackupStatus) automaticBackupPoll = window.setInterval(() => { void readAutomaticBackupStatus(); }, 60_000);
});
onBeforeUnmount(() => {
  mounted = false; hostEpoch++; preferenceEpoch++; backupEpoch++; restoreStatusEpoch++; automaticBackupEpoch++;
  if (automaticBackupPoll !== undefined) window.clearInterval(automaticBackupPoll);
});
</script>

<template>
  <div class="settings-grid">
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol"><Icon name="settings" /></span><div><h2>桌面表现</h2><p>独立保存的两项模式设置</p></div></header>
      <ModeControls />
      <div v-if="draft" class="settings-note">
        <label>桌宠窗口大小
          <select v-model="draft.scalePercent" :disabled="preferenceBusy || hostBusy || backupBusy || !preferences || !store.ready">
            <option v-for="percent in hostScalePercents" :key="percent" :value="percent">{{ percent }}%</option>
          </select>
        </label>
        <label><input v-model="draft.reducedMotion" type="checkbox" :disabled="preferenceBusy || hostBusy || backupBusy || !preferences || !store.ready"> 减少动态效果</label>
        <p class="muted">保存后应用到桌宠窗口和动画偏好，不改变宠物的游戏进度。</p>
        <button class="button button-secondary side-button" type="button" :disabled="!preferenceDirty || preferenceBusy || hostBusy || backupBusy || !store.ready" @click="savePreferences">保存显示偏好</button>
      </div>
      <p v-else class="muted">{{ preferenceBusy ? '读取显示偏好…' : '显示偏好尚未确认。' }}</p>
      <button class="button button-secondary side-button" type="button" :disabled="preferenceBusy || hostBusy || backupBusy || !store.ready" @click="readPreferences">{{ preferenceDirty ? '放弃修改并重新读取' : '刷新显示偏好' }}</button>
      <p v-if="preferenceFeedback" class="muted" role="status">{{ preferenceFeedback }}</p>
      <div class="settings-note"><p>宠物的显示/隐藏与主宠选择，可前往宠物馆管理。</p><RouterLink class="panel-link" to="/pets">前往宠物馆 <Icon name="arrow" /></RouterLink></div>
    </section>
    <CharacterPacksPanel />
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-blue"><Icon name="refresh" /></span><div><h2>服务状态</h2><p>本地业务数据连接</p></div></header>
      <dl class="settings-list"><div><dt>当前连接</dt><dd>{{ serviceStatusLabel(store.serviceStatus) }}</dd></div><div><dt>快照版本</dt><dd>{{ store.snapshot?.revision ?? '未知' }}</dd></div></dl>
      <button class="button button-secondary side-button" type="button" :disabled="store.loading || store.busy" @click="store.refresh()"><Icon name="refresh" /> {{ store.loading ? '刷新中…' : '重新获取快照' }}</button>
      <div v-if="diagnosticsBridge" class="settings-note">
        <p>诊断报告包含应用版本、组件状态、随机请求编号、错误类别和耗时。</p>
        <button class="button button-secondary side-button" type="button" :disabled="diagnosticsBusy" @click="exportDiagnostics">{{ diagnosticsBusy ? '导出中…' : '导出诊断报告' }}</button>
        <p v-if="diagnosticsFeedback" class="muted" role="status">{{ diagnosticsFeedback }}</p>
      </div>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-blue"><Icon name="settings" /></span><div><h2>全局快捷键</h2><p>从任何前台应用快速唤起桌宠</p></div></header>
      <template v-if="host">
        <p class="muted">Windows 可能拒绝已被占用的组合。托盘入口始终可用。</p>
        <dl class="settings-list"><div><dt>偏好</dt><dd>{{ host.shortcuts.enabled ? '希望启用' : '关闭' }} · {{ host.shortcuts.preferenceScope === 'PERSISTED' ? '已保存' : '仅本次运行' }}</dd></div>
          <div v-for="entry in host.shortcuts.entries" :key="entry.id">
            <dt>{{ shortcutLabels[entry.id] }}<br><small>{{ entry.accelerator.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ') }}</small></dt>
            <dd>{{ shortcutStatus[entry.status] }}</dd>
          </div>
        </dl>
        <button class="button button-secondary side-button" type="button" :disabled="!canSetShortcuts" @click="setShortcuts(!host.shortcuts.enabled)">
          {{ host.shortcuts.enabled ? '关闭全局快捷键' : '启用全局快捷键' }}
        </button>
        <button v-if="shortcutIssues" class="button button-secondary side-button" type="button" :disabled="!canSetShortcuts" @click="setShortcuts(true)">重试冲突的快捷键</button>
        <button v-if="hotkeyBridge && !bindingDraft" class="button button-secondary side-button" type="button"
          :disabled="bindingsBusy || hostBusy || backupBusy || !store.ready || host.shortcuts.availability !== 'READY'"
          @click="openBindingEditor">修改全局热键</button>
        <div v-if="bindingDraft" class="settings-note">
          <div v-for="id in hostShortcutIds" :key="id" class="hotkey-edit">
            <span>{{ shortcutLabels[id] }}</span>
            <select :aria-label="shortcutLabels[id] + '的修饰键'" :disabled="bindingsBusy"
              :value="bindingDraft[id].slice(0, bindingDraft[id].lastIndexOf('+'))" @change="changeBinding(id, 'modifier', $event)">
              <option v-for="option in bindingModifiers" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select :aria-label="shortcutLabels[id] + '的按键'" :disabled="bindingsBusy"
              :value="bindingDraft[id].slice(bindingDraft[id].lastIndexOf('+') + 1)" @change="changeBinding(id, 'key', $event)">
              <option v-for="key in bindingKeys" :key="key" :value="key">{{ key }}</option>
            </select>
          </div>
          <button class="button button-secondary side-button" type="button" :disabled="bindingsBusy"
            @click="bindingDraft = { ...defaultHostShortcutBindings }">载入默认组合</button>
          <button class="button button-secondary side-button" type="button" :disabled="bindingsBusy || !store.ready" @click="saveBindings">保存热键</button>
          <button class="button button-secondary side-button" type="button" :disabled="bindingsBusy" @click="closeBindingEditor">取消</button>
        </div>
      </template>
      <p v-else class="muted">{{ hostBusy ? '读取宿主状态…' : '尚未确认快捷键状态。' }}</p>
      <button class="button button-secondary side-button" type="button" :disabled="hostBusy" @click="refreshHost"><Icon name="refresh" /> 读取实际宿主状态</button>
      <p v-if="hostError" role="status" class="muted">{{ hostError }}</p>
      <p v-if="bindingsFeedback" role="status" class="muted">{{ bindingsFeedback }}</p>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol"><Icon name="settings" /></span><div><h2>Windows 登录启动</h2><p>由你主动决定是否在登录系统时启动桌宠</p></div></header>
      <template v-if="login?.availability === 'READY'">
        <dl class="settings-list">
          <div><dt>此登录项</dt><dd>{{ login.openAtLogin ? '已配置' : '未配置' }}</dd></div>
          <div><dt>系统报告此程序会登录启动</dt><dd>{{ login.executableWillLaunchAtLogin ? '是' : '否' }}</dd></div>
        </dl>
        <p v-if="login.openAtLogin && !login.executableWillLaunchAtLogin" class="muted">已配置登录项，但系统未报告会执行。请在 Windows 启动应用设置中确认。</p>
        <p v-else-if="!login.openAtLogin && login.executableWillLaunchAtLogin" class="muted">可能存在其他参数或系统管理的启动项。关闭此登录项不会修改其他启动项。</p>
        <button class="button button-secondary side-button" type="button" :disabled="hostBusy" @click="setLoginStart(!login.openAtLogin)">
          {{ login.openAtLogin ? '关闭登录启动' : '启用登录启动' }}
        </button>
        <button v-if="login.openAtLogin && !login.executableWillLaunchAtLogin" class="button button-secondary side-button" type="button" :disabled="hostBusy" @click="setLoginStart(true)">重新启用登录启动</button>
        <p class="muted">仅在你操作时修改本应用的登录项，不会自动启动快捷工作台中的收藏。</p>
      </template>
      <p v-else class="muted">{{ login ? loginReasons[login.availability] : '尚未确认实际登录启动状态。' }}</p>
      <button class="button button-secondary side-button" type="button" :disabled="hostBusy" @click="refreshHost">刷新登录启动状态</button>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-rose"><Icon name="spark" /></span><div><h2>偏好与隐私</h2><p>分别管理数据和能力授权</p></div></header>
      <div class="settings-note"><p>AI 服务、对话记忆确认、语音配置和授权见对话中心。</p><RouterLink class="panel-link" to="/chat">AI、记忆与语音 <Icon name="arrow" /></RouterLink></div>
      <div class="settings-note"><p>快捷收藏、明确批准的启动权限、习惯推荐开关和启动历史管理见快捷工作台。</p><RouterLink class="panel-link" to="/workspace">工作台与推荐隐私 <Icon name="arrow" /></RouterLink></div>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-blue"><Icon name="report" /></span><div><h2>本地存档备份</h2><p>导出或恢复本地存档</p></div></header>
      <p class="muted">备份仅包含已提交的存档数据。文件可能包括私人对话、记忆和快捷入口记录，请选择你信任的本地保存位置。</p>
      <button class="button button-secondary side-button" type="button" :disabled="!preferencesBridge || !store.ready || backupBusy || preferenceBusy || hostBusy" @click="exportBackup">导出本地备份</button>
      <button v-if="restoreBridge" class="button button-secondary side-button" type="button" :disabled="!canRestore || backupBusy || preferenceBusy || hostBusy" @click="restoreBackup">从备份恢复</button>
      <p v-if="backupBusy" class="muted" role="status">正在等待文件选择或校验。</p>
      <p v-if="backupFeedback" class="muted" role="status">{{ backupFeedback }}</p>
      <p v-if="restoreStatus" class="muted" role="status">{{ restoreStatus }}</p>
      <p v-if="automaticBackupStatus" class="muted" role="status">{{ automaticBackupStatus }}</p>
    </section>
  </div>
</template>

<style scoped>
.hotkey-edit { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin-block: .45rem; }
.hotkey-edit > span { flex: 1 0 8rem; }
</style>
