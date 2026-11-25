<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Activity } from '@pet-desktop/contracts';
import { loadBuiltinPack } from '../asset-packs/builtin-registry';
import { CanvasRenderer } from '../rendering/canvas-renderer';
import { semanticIdForActivity } from '../rendering/action-controller';
import type { HitRegion, MouthSample, RenderProfile } from '../rendering/contract';
import PetPortrait from '../shared/PetPortrait.vue';

const props = defineProps<{
  characterId: string;
  activity: Activity | null;
  paused: boolean;
  interactive: boolean;
}>();
const emit = defineEmits<{
  touch: [region: string];
  visual: [report: { characterId: string; result: 'READY' | 'FALLBACK' }];
}>();
const surface = ref<HTMLCanvasElement | null>(null);
const hasFrame = ref(false);
const loadState = ref<'loading' | 'ready' | 'failed'>('loading');

// GPU/Canvas objects and clocks remain outside reactive state and Pinia.
let renderer: CanvasRenderer | null = null;
let mounted = false;
let loadAbort: AbortController | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest: number | null = null;
let lastFrame: number | null = null;
let lastDpr = 0;
let motionPreference: MediaQueryList | null = null;
let profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };

function resize(): void {
  if (!renderer || !surface.value) return;
  const bounds = surface.value.getBoundingClientRect();
  lastDpr = window.devicePixelRatio || 1;
  if (bounds.width > 0 && bounds.height > 0) renderer.resize(bounds.width, bounds.height, lastDpr);
}

function stopFrames(): void {
  if (frameRequest !== null) window.cancelAnimationFrame(frameRequest);
  frameRequest = null;
  lastFrame = null;
}

function active(): boolean {
  return mounted && !!renderer && !props.paused && document.visibilityState === 'visible';
}

function frame(now: number): void {
  frameRequest = null;
  if (!active() || !renderer) return;
  if ((window.devicePixelRatio || 1) !== lastDpr) resize();
  if (lastFrame === null) {
    lastFrame = now;
    renderer.tick(0);
  } else if (now - lastFrame >= 1000 / profile.maxFps - 0.5) {
    // Visibility/pausing resets the clock; one slow frame cannot trigger a
    // giant accumulated animation catch-up unrelated to game time.
    renderer.tick(Math.min(0.25, (now - lastFrame) / 1000));
    lastFrame = now;
  }
  frameRequest = window.requestAnimationFrame(frame);
}

function syncAnimation(): void {
  if (!renderer) return;
  renderer.setPaused(!active());
  if (!active()) stopFrames();
  else if (frameRequest === null) frameRequest = window.requestAnimationFrame(frame);
}

function syncQuality(): void {
  const reducedMotion = motionPreference?.matches ?? false;
  profile = { maxFps: reducedMotion ? 15 : 30, resolutionScale: 1, reducedMotion };
  renderer?.setQuality(profile);
  resize();
}

async function replacePack(): Promise<void> {
  const instance = renderer;
  if (!instance || !mounted) return;
  loadAbort?.abort();
  const request = new AbortController();
  loadAbort = request;
  const characterId = props.characterId;
  loadState.value = 'loading';
  try {
    const pack = await loadBuiltinPack(characterId, request.signal);
    await instance.loadPack(pack, request.signal);
    if (!mounted || loadAbort !== request || request.signal.aborted) return;
    // A successful preparation/bitmap decode is the only point at which the
    // visual becomes current. A previous character is never a hit target for
    // the new character's authoritative UI.
    hasFrame.value = true;
    loadState.value = 'ready';
    instance.setBaseAction(semanticIdForActivity(props.activity));
    resize();
    syncAnimation();
    await nextTick();
    if (mounted && loadAbort === request && !request.signal.aborted) emit('visual', { characterId, result: 'READY' });
  } catch {
    if (!mounted || loadAbort !== request || request.signal.aborted) return;
    // The adapter retains the previous prepared resource on failure. On an
    // initial failure or identity change, show the requested character's
    // non-interactive SVG fallback, never an old character under a new name.
    if (instance.activeCharacterId !== characterId) hasFrame.value = false;
    loadState.value = 'failed';
    await nextTick();
    if (mounted && loadAbort === request && !request.signal.aborted) emit('visual', { characterId, result: 'FALLBACK' });
  }
}

function hitTestClient(x: number, y: number): HitRegion | null {
  if (!props.interactive || !renderer || !surface.value || !hasFrame.value
    || loadState.value !== 'ready' || renderer.activeCharacterId !== props.characterId) return null;
  const bounds = surface.value.getBoundingClientRect();
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return null;
  return renderer.hitTest(x - bounds.left, y - bounds.top);
}

function onClick(event: MouseEvent): void {
  if (!event.isTrusted) return;
  const region = hitTestClient(event.clientX, event.clientY);
  if (region) emit('touch', region.id);
}

function playSemantic(semanticId: string): void {
  if (!renderer || props.paused || renderer.activeCharacterId !== props.characterId || loadState.value !== 'ready') return;
  // Visual requests never act as domain command receipts or gate gameplay.
  void renderer.play({ requestId: crypto.randomUUID(), semanticId, loop: false, priority: 10, blendMs: 0 });
}

function setVoiceMouth(sample: MouthSample | null): void {
  if (!renderer) return;
  if (!sample || !active() || renderer.activeCharacterId !== props.characterId || loadState.value !== 'ready') {
    renderer.clearMouth(); return;
  }
  renderer.setMouth(sample);
}

defineExpose({ hitTestClient, playSemantic, setVoiceMouth });

watch(() => props.characterId, () => { void replacePack(); });
watch(() => props.activity, (activity) => renderer?.setBaseAction(semanticIdForActivity(activity)));
watch(() => props.paused, syncAnimation);

onMounted(async () => {
  mounted = true;
  if (!surface.value) return;
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  syncQuality();
  const instance = new CanvasRenderer();
  try {
    await instance.init(surface.value, profile);
    if (!mounted) { instance.destroy(); return; }
    renderer = instance;
    instance.setBaseAction(semanticIdForActivity(props.activity));
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(surface.value);
    resize();
    document.addEventListener('visibilitychange', syncAnimation);
    window.addEventListener('resize', resize);
    motionPreference.addEventListener('change', syncQuality);
    syncAnimation();
    await replacePack();
  } catch {
    instance.destroy();
    if (renderer === instance) renderer = null;
    if (mounted) {
      loadState.value = 'failed';
      await nextTick();
      if (mounted) emit('visual', { characterId: props.characterId, result: 'FALLBACK' });
    }
  }
});

onBeforeUnmount(() => {
  mounted = false;
  loadAbort?.abort();
  stopFrames();
  resizeObserver?.disconnect();
  document.removeEventListener('visibilitychange', syncAnimation);
  window.removeEventListener('resize', resize);
  motionPreference?.removeEventListener('change', syncQuality);
  renderer?.destroy();
  renderer = null;
});
</script>

<template>
  <div class="pet-visual" :data-load-state="loadState">
    <canvas ref="surface" class="pet-canvas" :class="{ 'frame-visible': hasFrame }" aria-label="角色动画" @click="onClick" />
    <div v-if="!hasFrame" class="initial-fallback" aria-hidden="true">
      <PetPortrait :character-id="characterId" :sleeping="activity === 'REST' || activity === 'SLEEP'" :paused="paused" />
    </div>
    <small v-if="loadState === 'failed'" class="resource-notice" role="status">角色素材暂不可用</small>
  </div>
</template>

<style scoped>
.pet-visual { position: relative; width: 100%; height: 100%; min-height: 100px; overflow: hidden; }
.pet-canvas { display: block; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
.pet-canvas.frame-visible { opacity: 1; pointer-events: auto; }
.initial-fallback { position: absolute; inset: 0; pointer-events: none; }
.resource-notice { position: absolute; bottom: 1px; left: 50%; transform: translateX(-50%); white-space: nowrap; border-radius: 6px; padding: 2px 5px; background: #352b43dd; font-size: 10px; pointer-events: none; }
</style>
