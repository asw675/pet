<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Interaction } from '@pet-desktop/contracts';
import { useAppStore } from '../shared/store';
import { petStatus, serviceStatusLabel } from '../shared/presentation';
import PetCanvas from './PetCanvas.vue';
import { createInteractionLease } from '../shared/interaction-lease';
import type { PetVisualReady } from '../../shared/protocol';

const store = useAppStore();
const bridge = window.petDesktop?.role === 'pet' ? window.petDesktop : undefined;
const petId = new URL(window.location.href).searchParams.get('petId');
const pet = computed(() => store.snapshot?.pets.find((entry) => entry.petId === petId));
const canAct = computed(() => store.ready && !store.busy && !store.loading && pet.value?.presence === 'HOME' && pet.value.visibility === 'VISIBLE');
const petCanvas = ref<InstanceType<typeof PetCanvas> | null>(null);
const quietMotion = computed(() => !store.ready || !store.snapshot || store.snapshot.pausedRender || store.snapshot.doNotDisturb || pet.value?.visibility !== 'VISIBLE');
const hostError = ref<string | null>(null);
const openingCenter = ref(false);
const canHit = computed(() => !quietMotion.value && pet.value?.presence === 'HOME' && pet.value.visibility === 'VISIBLE');

// A staging window can report only that its own verified visual/fallback has
// been prepared. The host, not this renderer, decides which pet window appears.
const visual = ref<Omit<PetVisualReady, 'generation'> | null>(null);
const visualReport = computed<PetVisualReady | null>(() => {
  if (!store.ready || store.serviceStatus?.stage !== 'READY' || pet.value?.presence !== 'HOME'
    || pet.value.visibility !== 'VISIBLE' || visual.value?.characterId !== pet.value.characterId) return null;
  return { ...visual.value, generation: store.serviceStatus.generation };
});
let visualReportEpoch = 0;
let visualReportTimer: number | undefined;

function clearVisualReportTimer(): void {
  if (visualReportTimer !== undefined) window.clearTimeout(visualReportTimer);
  visualReportTimer = undefined;
}

watch(() => pet.value?.characterId, (characterId) => {
  if (visual.value?.characterId !== characterId) visual.value = null;
});

const visualReportKey = computed(() => {
  const report = visualReport.value;
  return report ? `${report.generation}:${report.characterId}:${report.result}` : null;
});
watch(visualReportKey, () => {
  const report = visualReport.value;
  const epoch = ++visualReportEpoch;
  clearVisualReportTimer();
  if (!report || !bridge) return;
  const attempt = async (left: number): Promise<void> => {
    if (visualReportEpoch !== epoch) return;
    try {
      const response = await bridge.reportVisualReady(report);
      if (response.ok || visualReportEpoch !== epoch || left <= 1) return;
    } catch { if (visualReportEpoch !== epoch || left <= 1) return; }
    visualReportTimer = window.setTimeout(() => { void attempt(left - 1); }, 500);
  };
  void attempt(4);
}, { flush: 'post' });

// The window is click-through by default. Mouse moves forwarded by Electron
// enable it only over the visible portrait, drag chip or explicit buttons.
const lease = bridge ? createInteractionLease((enabled) => bridge.setInteractive(enabled), (ok) => {
  if (!ok && canHit.value && document.visibilityState === 'visible') hostError.value = '桌面命中切换暂不可用，可使用托盘';
  else if (ok && hostError.value === '桌面命中切换暂不可用，可使用托盘') hostError.value = null;
}) : undefined;
let latestMouse: { x: number; y: number } | null = null;
let leaseTimer: number | undefined;

function hitTest(renew = false): void {
  if (!latestMouse || !canHit.value || document.visibilityState !== 'visible') {
    lease?.set(false);
    return;
  }
  const { x, y } = latestMouse;
  // The adapter transforms canvas-local CSS coordinates into the declared
  // character regions, not the entire transparent canvas rectangle. Explicit drag
  // handle geometry is also accepted because native drag regions may consume
  // move events instead of exposing a regular DOM element target.
  const element = document.elementFromPoint(x, y);
  const dragHandle = document.querySelector('[data-drag]')?.getBoundingClientRect();
  const onDragHandle = dragHandle !== undefined && x >= dragHandle.left && x < dragHandle.right
    && y >= dragHandle.top && y < dragHandle.bottom;
  const interactive = Boolean(element?.closest('[data-hit]') || onDragHandle || petCanvas.value?.hitTestClient(x, y));
  lease?.set(interactive, renew);
}

function onMouseMove(event: MouseEvent): void {
  if (!event.isTrusted) return;
  latestMouse = { x: event.clientX, y: event.clientY };
  hitTest();
}

function leave(): void {
  latestMouse = null;
  lease?.reset();
}

watch(canHit, (enabled) => enabled ? hitTest() : leave(), { flush: 'sync' });

onMounted(() => {
  document.addEventListener('mousemove', onMouseMove);
  document.documentElement.addEventListener('mouseleave', leave);
  document.addEventListener('visibilitychange', leave);
  // A stationary pointer over the portrait should retain interaction, but
  // Main expires input if these rechecks stop or the cursor exits the window.
  leaseTimer = window.setInterval(() => hitTest(true), 500);
});

onBeforeUnmount(() => {
  visualReportEpoch += 1;
  clearVisualReportTimer();
  if (leaseTimer !== undefined) window.clearInterval(leaseTimer);
  document.removeEventListener('mousemove', onMouseMove);
  document.documentElement.removeEventListener('mouseleave', leave);
  document.removeEventListener('visibilitychange', leave);
  leave();
});

async function openControlCenter(): Promise<void> {
  if (openingCenter.value) return;
  hostError.value = null;
  if (!bridge) {
    hostError.value = '未连接桌宠宿主';
    return;
  }
  openingCenter.value = true;
  try {
    const result = await bridge.openControlCenter();
    if (!result.ok) hostError.value = '暂时无法打开控制中心';
  } catch {
    hostError.value = '暂时无法打开控制中心';
  } finally {
    openingCenter.value = false;
  }
}

function interact(interaction: Interaction): void {
  if (!pet.value || !canAct.value) return;
  hostError.value = null;
  if (interaction === 'PET') petCanvas.value?.playSemantic('tap.head');
  void store.dispatch({ type: 'PET_INTERACT', payload: { petId: pet.value.petId, interaction } },
    interaction === 'PET' ? '已互动，好感与心情已更新' : '已安排休息');
}

</script>

<template>
  <main class="pet-shell" @contextmenu.prevent="openControlCenter">
    <template v-if="pet">
      <div class="plate" data-hit>
        <div class="drag-handle" data-drag title="拖动桌宠窗口">⠿ <span>{{ pet.nickname }}</span></div>
        <span class="level">Lv.{{ pet.level }}</span>
        <button class="more" aria-label="打开控制中心" title="控制中心" :disabled="openingCenter" @click="openControlCenter">···</button>
      </div>
      <div class="portrait-surface">
        <PetCanvas ref="petCanvas" :character-id="pet.characterId" :activity="pet.activity" :paused="quietMotion" :interactive="canAct && canHit" @touch="interact('PET')" @visual="visual = $event" />
      </div>
      <div class="state" data-hit>
        <span class="dot" :class="{ muted: !store.ready }"></span>
        {{ store.ready ? petStatus(pet) : serviceStatusLabel(store.serviceStatus) }}
        <span class="divider"></span>
        <span title="精力">精力 {{ pet.energy }}</span>
        <span v-if="store.snapshot?.pausedRender" class="tag">已停动画</span>
        <span v-if="store.snapshot?.doNotDisturb" class="tag">免打扰</span>
      </div>
      <div class="actions" data-hit>
        <button :disabled="!canAct" @click="interact('PET')">摸头</button>
        <button :disabled="!canAct" @click="interact('REST')">休息</button>
        <button v-if="store.ready" :disabled="openingCenter" title="在控制中心选择路线并出发" @click="openControlCenter">旅行…</button>
        <button v-else :disabled="store.loading" title="重新查询本地宠物状态" @click="store.refresh()">刷新</button>
      </div>
    </template>
    <div v-else class="waiting" data-hit>
      <span>{{ petId ? serviceStatusLabel(store.serviceStatus) : '窗口未绑定宠物' }}</span>
      <small>{{ store.ready && !pet ? '找不到此宠物，请打开控制中心。' : '正在等待本地状态' }}</small>
      <button v-if="bridge && !store.ready" :disabled="store.loading" @click="store.refresh()">刷新状态</button>
      <button :disabled="openingCenter" @click="openControlCenter">打开控制中心</button>
    </div>
    <div v-if="hostError || store.error || (store.notice && !store.snapshot?.doNotDisturb)" class="feedback" :class="{ error: hostError || store.error }" role="status" data-hit>
      {{ hostError || store.error || store.notice }}
    </div>
  </main>
</template>

<style>
:root { font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; color: #fbefdc; color-scheme: dark; }
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
body { user-select: none; }
.pet-shell { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 5px; gap: 5px; pointer-events: none; }
[data-hit] { pointer-events: auto; }
.plate { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 1px 3px 1px 7px; background: #352b43eb; border: 1px solid #b4a4d16b; border-radius: 11px; box-shadow: 0 2px 8px #1b172149; max-width: 100%; }
.drag-handle { -webkit-app-region: drag; app-region: drag; padding: 4px 2px 4px 0; font-size: 12px; font-weight: 700; cursor: move; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; max-width: 130px; }
.drag-handle span { color: #fff3df; }
.level { font-size: 10px; color: #e7cc9f; white-space: nowrap; }
button { -webkit-app-region: no-drag; app-region: no-drag; border: 1px solid #b4a4d16b; font: inherit; color: #fff3df; background: #352b43ed; cursor: pointer; transition: background .16s ease, border-color .16s ease; }
button:not(:disabled):hover, button:focus-visible { border-color: #efd2a0; background: #51415c; outline: none; }
button:disabled { opacity: .62; cursor: default; }
.more { display: grid; place-items: center; width: 25px; height: 21px; border: 0; border-radius: 7px; font-size: 16px; line-height: 1; }
.portrait-surface { display: block; flex: 1; min-height: 100px; width: min(172px, 74vw); max-height: 166px; padding: 0; margin: 0; }
.state { display: flex; align-items: center; gap: 6px; background: #352b43ed; padding: 4px 8px; border-radius: 10px; font-size: 10px; border: 1px solid #b4a4d145; white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #98daa3; }
.dot.muted { background: #e3b67d; }
.divider { height: 8px; width: 1px; background: #ae9ec46b; }
.tag { color: #e3bf8a; }
.actions { display: flex; gap: 4px; }
.actions button { min-height: 26px; min-width: 48px; padding: 4px 11px; border-radius: 9px; font-size: 11px; box-shadow: 0 2px 8px #1b172135; }
.feedback { max-width: 210px; padding: 4px 7px; border-radius: 8px; background: #352b43f2; border: 1px solid #9dca9e75; font-size: 10px; line-height: 1.3; text-align: center; max-height: 45px; overflow: auto; }
.feedback.error { color: #ffd8cd; border-color: #d88c80; }
.waiting { display: flex; flex-direction: column; gap: 9px; align-items: center; padding: 13px; border-radius: 13px; text-align: center; background: #352b43ed; border: 1px solid #b4a4d16b; font-size: 13px; }
.waiting small { max-width: 160px; color: #d2c4dd; font-size: 11px; }
.waiting button { border-radius: 8px; padding: 5px 7px; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
