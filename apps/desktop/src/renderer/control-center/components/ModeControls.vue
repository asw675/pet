<script setup lang="ts">
import { computed } from 'vue';
import type { ModeFlag } from '@pet-desktop/contracts';
import { useAppStore } from '../../shared/store';
import Icon from './Icon.vue';

const store = useAppStore();
const canAct = computed(() => store.ready && !store.busy && !store.loading && !!store.snapshot);
const modes = computed(() => [
  { flag: 'doNotDisturb' as const, icon: 'moon', label: '免打扰', desc: '减少主动打扰，保留陪伴设定。', value: store.snapshot?.doNotDisturb },
  { flag: 'pausedRender' as const, icon: 'pause', label: '暂停动画', desc: '暂时停止桌宠动效，不改变养成。', value: store.snapshot?.pausedRender },
]);
function toggle(flag: ModeFlag, value: boolean | undefined, label: string) {
  if (!canAct.value || value === undefined) return;
  void store.dispatch({ type: 'APP_SET_MODE', payload: { flag, enabled: !value } }, `${label}已${value ? '关闭' : '开启'}`);
}
</script>

<template>
  <div class="mode-list" aria-label="桌面偏好">
    <div v-for="mode in modes" :key="mode.flag" class="mode-row">
      <span class="mode-icon"><Icon :name="mode.icon" /></span>
      <div class="mode-text"><strong>{{ mode.label }}</strong><small>{{ mode.desc }}</small></div>
      <button class="mode-toggle" type="button" role="switch"
        :aria-label="mode.label" :aria-checked="mode.value ?? false" :disabled="!canAct || mode.value === undefined"
        @click="toggle(mode.flag, mode.value, mode.label)">
        <span class="switch-track" :class="{ on: mode.value }"><span></span></span>
        <span class="switch-label">{{ mode.value === undefined ? '未知' : mode.value ? '开启' : '关闭' }}</span>
      </button>
    </div>
  </div>
</template>
