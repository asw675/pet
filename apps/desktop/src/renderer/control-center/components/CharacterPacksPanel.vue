<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { CharacterPackChanged, CharacterPackFailure, CharacterPackResult, CharacterPackRow } from '../../../shared/character-pack-ipc';
import { useAppStore } from '../../shared/store';

const store = useAppStore();
const bridge = window.petDesktop?.role === 'control-center' ? window.petDesktop : null;
const rows = ref<CharacterPackRow[]>([]);
const busy = ref(false);
const feedback = ref('');
let revision = 0;
const name: Record<CharacterPackRow['characterId'], string> = { 'star-singer': '星咏', 'fluffy-ranger': '绒绒', nova: '诺瓦' };
const failure: Record<CharacterPackFailure, string> = {
  INVALID_REQUEST: '此版本请求无效。',
  FORBIDDEN: '当前窗口或服务暂不可操作。',
  BUSY: '请先结束正在进行的操作。',
  CANCELLED: '已取消导入。',
  INVALID_PACK: '清单、资源目录、文件大小或校验值无效。',
  UNSUPPORTED_PACK: '资源包的角色、格式或应用版本不受支持。',
  VERSION_CONFLICT: '这个版本已经存在或早于内置版本。更新请使用新的版本号。',
  NOT_FOUND: '没有找到这个版本，请刷新后再操作。',
  STORAGE_ERROR: '资源包存储暂不可用。',
  LIMIT_REACHED: '该角色已达到可安装版本上限。',
};

async function refresh(): Promise<void> {
  const current = ++revision;
  if (!bridge || !store.ready) {
    rows.value = [];
    busy.value = false;
    return;
  }
  busy.value = true;
  try {
    const result = await bridge.listCharacterPacks();
    if (current !== revision) return;
    if (result.ok && result.kind === 'list') rows.value = result.rows;
    else {
      rows.value = [];
      feedback.value = result.ok ? '无法读取角色版本。' : failure[result.code];
    }
  } catch {
    if (current === revision) feedback.value = '无法读取角色版本。';
  } finally { if (current === revision) busy.value = false; }
}

async function change(operation: () => Promise<CharacterPackResult>): Promise<void> {
  if (busy.value || !store.ready) return;
  busy.value = true;
  feedback.value = '';
  const current = ++revision;
  try {
    const result = await operation();
    if (current !== revision) return;
    feedback.value = result.ok && result.kind === 'change'
      ? name[result.change.characterId] + '已选用版本 ' + result.change.packVersion + '。'
      : result.ok ? '无法确认更新结果。' : failure[result.code];
  } catch {
    if (current === revision) feedback.value = '无法确认更新结果。';
  } finally {
    if (current === revision) await refresh();
  }
}

function importPack(): void {
  if (bridge) void change(() => bridge.importCharacterPack());
}

function select(item: CharacterPackRow, event: Event): void {
  const target = event.currentTarget;
  if (!bridge || !(target instanceof HTMLSelectElement) || target.value === item.activeVersion) return;
  const requested: CharacterPackChanged = { characterId: item.characterId, packVersion: target.value };
  target.value = item.activeVersion;
  void change(() => bridge.activateCharacterPack(requested));
}

watch(() => [store.ready, store.serviceStatus?.generation] as const, () => { void refresh(); }, { immediate: true });
onBeforeUnmount(() => { revision++; });
</script>

<template>
  <section class="panel side-panel">
    <h2>角色资源包</h2>
    <p class="muted">支持导入 Live2D、序列帧或静态 PNG 资源包。Live2D 在启用本机 Cubism SDK 预览时播放，其他情况显示后备画面。</p>
    <div v-for="item in rows" :key="item.characterId" class="pack-row">
      <label :for="'pack-' + item.characterId">{{ name[item.characterId] }}</label>
      <select :id="'pack-' + item.characterId" :value="item.activeVersion"
        :disabled="busy || !store.ready || item.installedVersions.length === 0" @change="select(item, $event)">
        <option :value="item.builtinVersion">内置 {{ item.builtinVersion }}</option>
        <option v-for="version in item.installedVersions" :key="version" :value="version">{{ version }}</option>
      </select>
    </div>
    <button class="button button-secondary side-button" type="button" :disabled="!bridge || !store.ready || busy" @click="importPack">
      {{ busy ? '正在读取或校验资源…' : '导入资源包目录' }}
    </button>
    <p v-if="feedback" class="muted" role="status">{{ feedback }}</p>
  </section>
</template>

<style scoped>
.pack-row { display: grid; grid-template-columns: 1fr minmax(8rem, .8fr); gap: .65rem; align-items: center; margin: .5rem 0; }
.pack-row select { padding: .4rem .6rem; border: 1px solid #8b7fa275; border-radius: .5rem; color: inherit; background: var(--panel-bg, #fff); }
</style>
