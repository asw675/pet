<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Interaction } from '@pet-desktop/contracts';
import { useAppStore } from '../shared/store';
import { petStatus, serviceStatusLabel } from '../shared/presentation';
import PetCanvas from './PetCanvas.vue';
import { createInteractionLease } from '../shared/interaction-lease';
import { hostScalePercents } from '../../shared/host-settings-ipc';
import type { HostScale } from '../../shared/host-settings-ipc';
import type { PetVisualReady } from '../../shared/protocol';
import type { VoiceMouthNotification } from '../../shared/voice-ipc';
import type { ProactiveDesktopBubble } from '../../shared/proactive-ipc';
import { MOUTH_STALE_MS, VoiceMouthProjection } from '../rendering/voice-mouth-projection';
import type { MouthProjectionResult } from '../rendering/voice-mouth-projection';

const store = useAppStore();
const bridge = window.petDesktop?.role === 'pet' ? window.petDesktop : undefined;
const petId = new URL(window.location.href).searchParams.get('petId');
const pet = computed(() => store.snapshot?.pets.find((entry) => entry.petId === petId));
const canAct = computed(() => store.ready && !store.busy && !store.loading && pet.value?.presence === 'HOME' && pet.value.visibility === 'VISIBLE');
const petCanvas = ref<InstanceType<typeof PetCanvas> | null>(null);
const portraitSurface = ref<HTMLDivElement | null>(null);
const quietMotion = computed(() => !store.ready || !store.snapshot || store.snapshot.pausedRender || store.snapshot.doNotDisturb || pet.value?.visibility !== 'VISIBLE');
const reducedMotion = ref(false);
const hostError = ref<string | null>(null);
const openingCenter = ref(false);
const canHit = computed(() => !quietMotion.value && pet.value?.presence === 'HOME' && pet.value.visibility === 'VISIBLE');
const canUseMenu = computed(() => store.ready && !store.snapshot?.doNotDisturb
  && pet.value?.presence === 'HOME' && pet.value.visibility === 'VISIBLE');
const menuVisible = ref(false);
const dragging = ref(false);
const scalePercent = ref<HostScale | null>(null);
const changingScale = ref(false);
const canChangeScale = computed(() => !!bridge && canUseMenu.value && scalePercent.value !== null && !changingScale.value);
const minScale = hostScalePercents[0];
const maxScale = hostScalePercents[hostScalePercents.length - 1];
const proactiveBubble = ref<string | null>(null);
let unsubscribeProactive: (() => void) | undefined;
let proactiveTimeout: number | undefined;

function clearProactive(): void {
  if (proactiveTimeout !== undefined) window.clearTimeout(proactiveTimeout);
  proactiveTimeout = undefined;
  proactiveBubble.value = null;
}

function showProactive(message: ProactiveDesktopBubble): void {
  if (message !== null && message.petId !== petId) return;
  clearProactive();
  if (!message || !canHit.value || pet.value?.activity !== 'IDLE' || document.visibilityState !== 'visible') return;
  proactiveBubble.value = message.text;
  proactiveTimeout = window.setTimeout(clearProactive, 8_000);
}

// Visual-only audio-clock samples from the trusted host. The pet renderer
// owns no microphone, playback source, raw audio or AI/provider requests.
let mouth = petId ? new VoiceMouthProjection(petId) : null;
let unsubscribeRenderPreferences: (() => void) | undefined;
let unsubscribeMouth: (() => void) | undefined;
let mouthTimer: number | undefined;

function stopMouthWatchdog(): void {
  if (mouthTimer !== undefined) window.clearTimeout(mouthTimer);
  mouthTimer = undefined;
}
function applyMouth(result: MouthProjectionResult): void {
  if (result.changed) petCanvas.value?.setVoiceMouth(result.sample);
}
function clearVoiceMouth(): void {
  stopMouthWatchdog(); mouth?.retire(); petCanvas.value?.setVoiceMouth(null);
}
function scheduleMouthWatchdog(): void {
  stopMouthWatchdog();
  if (!mouth?.active) return;
  mouthTimer = window.setTimeout(() => {
    mouthTimer = undefined;
    if (!mouth) return;
    applyMouth(mouth.expire(performance.now()));
    if (mouth.active) scheduleMouthWatchdog();
  }, MOUTH_STALE_MS + 4);
}
function onVoiceMouth(event: VoiceMouthNotification): void {
  if (!mouth) return;
  const result = mouth.accept(event, performance.now(), canHit.value && document.visibilityState === 'visible');
  if (!result.changed) return;
  applyMouth(result); scheduleMouthWatchdog();
}
function onVoiceVisibility(): void {
  if (document.visibilityState !== 'visible') { clearVoiceMouth(); clearProactive(); }
}
watch(() => canHit.value && pet.value?.activity === 'IDLE', eligible => { if (!eligible) clearProactive(); }, { flush: 'sync' });
watch(canHit, enabled => { if (!enabled) clearVoiceMouth(); }, { flush: 'sync' });
watch(() => pet.value?.characterId, () => clearVoiceMouth(), { flush: 'sync' });
watch(() => store.serviceStatus?.generation, () => clearVoiceMouth(), { flush: 'sync' });

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
  if (!ok && canUseMenu.value && document.visibilityState === 'visible') hostError.value = '桌面命中切换暂不可用，可使用托盘';
  else if (ok && hostError.value === '桌面命中切换暂不可用，可使用托盘') hostError.value = null;
}) : undefined;
let latestMouse: { x: number; y: number } | null = null;
let leaseTimer: number | undefined;
let menuHideTimer: number | undefined;

type DragFinish = 'end' | 'cancel';
interface PointerDrag {
  readonly gestureId: string;
  readonly pointerId: number;
  readonly target: Element;
  readonly originX: number;
  readonly originY: number;
  moved: boolean;
  began: boolean;
  sending: boolean;
  pendingMove: boolean;
  finish?: DragFinish;
}
let pointerDrag: PointerDrag | undefined;
let suppressDragClick = false;

/** One in-flight call and one pending sample keep slow host IPC from building
 * up a queue. A fast release still sends its final move before ending. */
async function sendDrag(drag: PointerDrag): Promise<void> {
  if (!bridge || drag.sending) return;
  drag.sending = true;
  try {
    for (;;) {
      const phase = !drag.began ? 'begin'
        : drag.pendingMove && drag.finish !== 'cancel' ? 'move' : drag.finish;
      if (!phase) return;
      if (phase === 'move') drag.pendingMove = false;
      let ok = false;
      try {
        ok = (await bridge.dragPetWindow({ phase, gestureId: drag.gestureId })).ok;
      } catch { /* Retire a gesture with a lost host response. */ }
      if (phase === 'end' || phase === 'cancel') {
        if (pointerDrag === drag) {
          pointerDrag = undefined;
          hitTest(true);
        }
        return;
      }
      drag.began = true;
      if (!ok) {
        if (drag.moved && !drag.finish) hostError.value = '暂时无法拖动桌宠';
        finishPointerDrag('cancel');
        drag.finish = 'cancel';
      }
    }
  } finally { drag.sending = false; }
}

function finishPointerDrag(phase: DragFinish): void {
  const drag = pointerDrag;
  if (!drag || drag.finish) return;
  drag.finish = phase;
  dragging.value = false;
  if (drag.moved) suppressDragClick = true;
  try {
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  } catch { /* The visual surface may have already been replaced. */ }
  void sendDrag(drag);
}

function cancelPointerDrag(): void { finishPointerDrag('cancel'); }

function beginPointerDrag(event: PointerEvent): void {
  if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
  suppressDragClick = false;
  if (!bridge || pointerDrag || !canUseMenu.value || document.visibilityState !== 'visible'
    || !(event.target instanceof Element)) return;
  const target = event.target;
  const onHandle = menuVisible.value && Boolean(target.closest('[data-drag]'));
  const onModel = portraitSurface.value?.contains(target) && petCanvas.value?.hitTestClient(event.clientX, event.clientY);
  if (!onHandle && !onModel) return;
  try { target.setPointerCapture(event.pointerId); }
  catch { return; }
  clearMenuTimer();
  pointerDrag = {
    gestureId: crypto.randomUUID(), pointerId: event.pointerId, target,
    originX: event.screenX, originY: event.screenY,
    moved: false, began: false, sending: false, pendingMove: false,
  };
  void sendDrag(pointerDrag);
}

function queueDragMove(drag: PointerDrag, event: PointerEvent): void {
  if (!drag.moved && Math.hypot(event.screenX - drag.originX, event.screenY - drag.originY) < 5) return;
  if (!drag.moved) {
    dragging.value = drag.moved = true;
    clearProactive();
    hostError.value = null;
  }
  drag.pendingMove = true;
  void sendDrag(drag);
}

function onPointerMove(event: PointerEvent): void {
  const drag = pointerDrag;
  if (!event.isTrusted || !drag || drag.finish || event.pointerId !== drag.pointerId) return;
  if ((event.buttons & 1) === 0) finishPointerDrag('cancel');
  else queueDragMove(drag, event);
}

function onPointerUp(event: PointerEvent): void {
  const drag = pointerDrag;
  if (!event.isTrusted || !drag || drag.finish || event.pointerId !== drag.pointerId) return;
  latestMouse = { x: event.clientX, y: event.clientY };
  queueDragMove(drag, event);
  finishPointerDrag('end');
}

function onPointerCanceled(event: PointerEvent): void {
  if (event.isTrusted && event.pointerId === pointerDrag?.pointerId) cancelPointerDrag();
}

function suppressClickAfterDrag(event: MouseEvent): void {
  if (!event.isTrusted || !suppressDragClick || event.button !== 0 || event.detail === 0) return;
  suppressDragClick = false;
  event.preventDefault();
  event.stopPropagation();
}

function clearMenuTimer(): void {
  if (menuHideTimer !== undefined) window.clearTimeout(menuHideTimer);
  menuHideTimer = undefined;
}

function hideMenu(): void {
  clearMenuTimer();
  menuVisible.value = false;
}

function updateMenu(hovered: boolean): void {
  if (hovered) {
    clearMenuTimer();
    menuVisible.value = true;
  } else if (menuVisible.value && menuHideTimer === undefined) {
    // Keep the menu available while crossing the gap from the portrait to a button.
    menuHideTimer = window.setTimeout(hideMenu, 260);
  }
}

function contains(rect: DOMRect | undefined, x: number, y: number): boolean {
  return !!rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function hitTest(renew = false): void {
  if (!canUseMenu.value || document.visibilityState !== 'visible') {
    hideMenu();
    lease?.set(false);
    return;
  }
  if (pointerDrag && !pointerDrag.finish) return;
  if (!latestMouse) {
    updateMenu(false);
    lease?.set(false);
    return;
  }
  const { x, y } = latestMouse;
  const element = document.elementFromPoint(x, y);
  const dragHandle = menuVisible.value ? document.querySelector('[data-drag]')?.getBoundingClientRect() : undefined;
  const onDragHandle = contains(dragHandle, x, y);
  const overMenu = menuVisible.value && (onDragHandle || !!element?.closest('[data-menu-hit]'));
  const overPortrait = contains(portraitSurface.value?.getBoundingClientRect(), x, y);
  updateMenu(overPortrait || overMenu);
  // The portrait box only reveals the menu. A native input lease still requires
  // a model hit or a visible control so transparent space stays click-through.
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
  if (pointerDrag && !pointerDrag.finish) return;
  updateMenu(false);
  lease?.reset();
}

function onPointerVisibility(): void {
  cancelPointerDrag();
  leave();
  hideMenu();
}

watch([canUseMenu, canHit], ([canUse]) => {
  if (canUse) hitTest();
  else onPointerVisibility();
}, { flush: 'post' });

watch(() => store.serviceStatus?.generation, () => {
  scalePercent.value = null;
  cancelPointerDrag();
}, { flush: 'sync' });

onMounted(() => {
  unsubscribeRenderPreferences = bridge?.subscribeHostRenderPreferences(value => {
    reducedMotion.value = value.reducedMotion;
    scalePercent.value = value.scalePercent;
  });
  unsubscribeMouth = bridge?.subscribeVoiceMouth(onVoiceMouth);
  unsubscribeProactive = bridge?.subscribeProactiveBubble(showProactive);
  document.addEventListener('visibilitychange', onVoiceVisibility);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCanceled, true);
  document.addEventListener('lostpointercapture', onPointerCanceled, true);
  window.addEventListener('blur', cancelPointerDrag);
  document.documentElement.addEventListener('mouseleave', leave);
  document.addEventListener('visibilitychange', onPointerVisibility);
  // A stationary pointer over the portrait should retain interaction, but
  // Main expires input if these rechecks stop or the cursor exits the window.
  leaseTimer = window.setInterval(() => {
    const drag = pointerDrag;
    if (drag?.moved && !drag.finish) {
      drag.pendingMove = true;
      void sendDrag(drag);
    }
    hitTest(true);
  }, 500);
});

onBeforeUnmount(() => {
  unsubscribeRenderPreferences?.();
  unsubscribeMouth?.(); unsubscribeMouth = undefined;
  unsubscribeProactive?.(); clearProactive();
  clearVoiceMouth(); mouth?.dispose(); mouth = null;
  document.removeEventListener('visibilitychange', onVoiceVisibility);
  visualReportEpoch += 1;
  clearVisualReportTimer();
  if (leaseTimer !== undefined) window.clearInterval(leaseTimer);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerCanceled, true);
  document.removeEventListener('lostpointercapture', onPointerCanceled, true);
  window.removeEventListener('blur', cancelPointerDrag);
  document.documentElement.removeEventListener('mouseleave', leave);
  document.removeEventListener('visibilitychange', onPointerVisibility);
  onPointerVisibility();
});

async function changeScale(direction: 'decrease' | 'increase'): Promise<void> {
  if (!bridge || !canChangeScale.value || !menuVisible.value) return;
  changingScale.value = true;
  hostError.value = null;
  try {
    const result = await bridge.changePetScale(direction);
    if (!result.ok) hostError.value = '暂时无法调整桌宠大小';
  } catch {
    hostError.value = '暂时无法调整桌宠大小';
  } finally {
    changingScale.value = false;
  }
}

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
  clearProactive();
  hostError.value = null;
  if (interaction === 'PET') petCanvas.value?.playSemantic('tap.head');
  void store.dispatch({ type: 'PET_INTERACT', payload: { petId: pet.value.petId, interaction } },
    interaction === 'PET' ? '已互动' : interaction === 'WAKE' ? '已唤醒' : '已安排休息，体力将逐渐恢复');
}

function onModelTouch(region: string): void {
  const name = region.toLowerCase();
  if (name === 'head') interact('PET');
  else if (name === 'body' && canAct.value) {
    clearProactive();
    hostError.value = null;
    petCanvas.value?.playSemantic('tap.body');
  }
}

</script>

<template>
  <main class="pet-shell" :data-pet-menu="menuVisible ? 'visible' : 'hidden'" :data-pet-drag="dragging ? 'active' : 'idle'"
    @pointerdown.capture="beginPointerDrag" @click.capture="suppressClickAfterDrag" @contextmenu.prevent="openControlCenter">
    <template v-if="pet">
      <div v-show="menuVisible" class="plate" data-hit data-menu-hit>
        <div class="drag-handle" data-drag title="拖动桌宠窗口">⠿ <span>{{ pet.nickname }}</span></div>
        <span class="level">Lv.{{ pet.level }}</span>
        <div class="scale-controls" role="group" aria-label="桌宠大小">
          <button class="scale-button" type="button" data-pet-scale="decrease" aria-label="缩小桌宠" title="缩小桌宠"
            :disabled="!canChangeScale || scalePercent === minScale" @click="changeScale('decrease')">−</button>
          <span v-if="scalePercent !== null" class="scale-value">{{ scalePercent }}%</span>
          <button class="scale-button" type="button" data-pet-scale="increase" aria-label="放大桌宠" title="放大桌宠"
            :disabled="!canChangeScale || scalePercent === maxScale" @click="changeScale('increase')">+</button>
        </div>
        <button class="more" aria-label="打开控制中心" title="控制中心" :disabled="openingCenter" @click="openControlCenter">···</button>
      </div>
      <div ref="portraitSurface" class="portrait-surface">
        <PetCanvas ref="petCanvas" :character-id="pet.characterId" :activity="pet.activity" :paused="quietMotion"
          :reduced-motion="reducedMotion" :interactive="canAct && canHit" :dragging="dragging"
          @touch="onModelTouch" @visual="visual = $event" />
      </div>
      <p v-if="proactiveBubble" class="proactive-bubble" role="status">{{ proactiveBubble }}</p>
      <div v-show="menuVisible" class="bottom-menu">
        <div class="state" data-hit data-menu-hit>
          <span class="dot" :class="{ muted: !store.ready }"></span>
          <span>{{ store.ready ? petStatus(pet) : serviceStatusLabel(store.serviceStatus) }}</span>
          <span class="divider"></span>
          <span title="精力">精力 {{ pet.energy }}</span>
          <span v-if="store.snapshot?.pausedRender" class="tag">已停动画</span>
          <span v-if="store.snapshot?.doNotDisturb" class="tag">免打扰</span>
        </div>
        <div class="actions">
          <button data-hit data-menu-hit :disabled="!canAct" @click="interact('PET')">摸头</button>
          <button v-if="pet.activity === 'REST' || pet.activity === 'SLEEP'" data-hit data-menu-hit :disabled="!canAct" @click="interact('WAKE')">唤醒</button>
          <button v-else data-hit data-menu-hit :disabled="!canAct" @click="interact('REST')">休息</button>
          <button v-if="store.ready" data-hit data-menu-hit :disabled="openingCenter" title="在控制中心选择路线并出发" @click="openControlCenter">旅行…</button>
          <button v-else data-hit data-menu-hit :disabled="store.loading" title="重新查询本地宠物状态" @click="store.refresh()">刷新</button>
        </div>
      </div>
    </template>
    <div v-else class="waiting" data-hit>
      <span>{{ petId ? serviceStatusLabel(store.serviceStatus) : '窗口未绑定宠物' }}</span>
      <small>{{ store.ready && !pet ? '找不到此宠物，请打开控制中心。' : '正在等待本地状态' }}</small>
      <button v-if="bridge && !store.ready" :disabled="store.loading" @click="store.refresh()">刷新状态</button>
      <button :disabled="openingCenter" @click="openControlCenter">打开控制中心</button>
    </div>
    <div v-if="hostError || store.error || (menuVisible && store.notice)" class="feedback" :class="{ error: hostError || store.error }" role="status" data-hit>
      {{ hostError || store.error || store.notice }}
    </div>
  </main>
</template>

<style>
:root { font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; color: #fbefdc; color-scheme: dark; }
* { box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
body { user-select: none; }
.pet-shell { --edge: clamp(4px, 2.5vw, 9px); position: relative; width: 100%; height: 100%; display: grid; place-items: center; pointer-events: none; }
.proactive-bubble { position: absolute; z-index: 1; top: calc(var(--edge) + 34px); left: 12px; right: 12px; max-height: 5.7em; margin: 0; padding: 7px 9px; overflow: hidden; overflow-wrap: anywhere; background: #352b43f2; border: 1px solid #b4a4d199; border-radius: 10px; color: #fff3df; font-size: 12px; line-height: 1.45; pointer-events: none; }
[data-hit] { pointer-events: auto; }
.plate { position: absolute; z-index: 2; top: var(--edge); left: 50%; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 5px; min-height: 26px; padding: 1px 3px 1px 6px; background: #352b43eb; border: 1px solid #b4a4d16b; border-radius: 11px; box-shadow: 0 2px 8px #1b172149; width: max-content; max-width: calc(100% - 2 * var(--edge)); }
.drag-handle { min-width: 16px; padding: 4px 2px 4px 0; font-size: 12px; font-weight: 700; cursor: grab; touch-action: none; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; max-width: 130px; }
.drag-handle span { color: #fff3df; }
.level { font-size: 10px; color: #e7cc9f; white-space: nowrap; }
button { -webkit-app-region: no-drag; app-region: no-drag; border: 1px solid #b4a4d16b; font: inherit; color: #fff3df; background: #352b43ed; cursor: pointer; transition: background .16s ease, border-color .16s ease; }
button:not(:disabled):hover, button:focus-visible { border-color: #efd2a0; background: #51415c; outline: none; }
button:disabled { opacity: .62; cursor: default; }
.scale-controls { display: flex; align-items: center; gap: 3px; flex: none; }
.scale-value { min-width: 2.8em; color: #e7cc9f; font-size: 10px; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
.scale-button, .more { display: grid; flex: none; place-items: center; width: 22px; height: 21px; padding: 0; border-radius: 7px; font-size: 16px; line-height: 1; }
.more { border: 0; }
.portrait-surface { width: 82%; height: 76%; min-height: 0; pointer-events: auto; touch-action: none; cursor: grab; }
.pet-shell[data-pet-drag="active"] :is(.portrait-surface, .drag-handle) { cursor: grabbing; }
.portrait-surface .pet-visual { min-height: 0; }
.bottom-menu { position: absolute; z-index: 2; bottom: var(--edge); left: var(--edge); right: var(--edge); display: grid; justify-items: center; gap: 4px; }
.state { display: flex; align-items: center; gap: 5px; max-width: 100%; background: #352b43ed; padding: 3px 7px; border-radius: 10px; font-size: 10px; border: 1px solid #b4a4d145; white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #98daa3; }
.dot.muted { background: #e3b67d; }
.divider { height: 8px; width: 1px; background: #ae9ec46b; }
.tag { color: #e3bf8a; }
.actions { display: flex; gap: 4px; }
.actions button { min-height: 24px; padding: 3px clamp(4px, 4vw, 10px); border-radius: 9px; font-size: 11px; white-space: nowrap; box-shadow: 0 2px 8px #1b172135; }
.feedback { position: absolute; z-index: 3; bottom: calc(var(--edge) + 52px); width: max-content; max-width: min(210px, calc(100% - 2 * var(--edge))); padding: 4px 7px; border-radius: 8px; background: #352b43f2; border: 1px solid #9dca9e75; font-size: 10px; line-height: 1.3; text-align: center; max-height: 45px; overflow: auto; }
.feedback.error { color: #ffd8cd; border-color: #d88c80; }
.waiting { display: flex; flex-direction: column; gap: 9px; align-items: center; padding: 13px; border-radius: 13px; text-align: center; background: #352b43ed; border: 1px solid #b4a4d16b; font-size: 13px; }
.waiting small { max-width: 160px; color: #d2c4dd; font-size: 11px; }
.waiting button { border-radius: 8px; padding: 5px 7px; font-size: 11px; }
@media (max-width: 180px) {
  .plate { gap: 3px; padding-left: 4px; }
  .level, .scale-value, .state .tag { display: none; }
  .state { gap: 3px; padding: 2px 5px; }
  .scale-button, .more { width: 20px; }
}
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
