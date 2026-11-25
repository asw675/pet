<script setup lang="ts">
import { computed } from 'vue';
import type { PetSnapshot, Interaction } from '@pet-desktop/contracts';
import { useAppStore } from '../../shared/store';
import { petStatus } from '../../shared/presentation';
import PetPortrait from '../../shared/PetPortrait.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ pet: PetSnapshot; featured?: boolean }>(), { featured: false });
const store = useAppStore();
const primary = computed(() => store.snapshot?.primaryPetId === props.pet.petId);
const canAct = computed(() => store.ready && !store.busy && !store.loading);
const stats = computed(() => [
  { name: '心情', value: props.pet.moodScore, style: 'mood' },
  { name: '健康', value: props.pet.healthPoints, style: 'health' },
  { name: '精力', value: props.pet.energy, style: 'energy' },
  { name: '好感', value: props.pet.bond, style: 'bond' },
]);
const visible = computed(() => props.pet.visibility === 'VISIBLE');
const scoreText = (value: number) => String(Math.round(value * 10) / 10);

function select() {
  if (!canAct.value || primary.value) return;
  void store.dispatch({ type: 'PET_SELECT', payload: { petId: props.pet.petId } }, `已将${props.pet.nickname}设为主宠`);
}
function interact(interaction: Interaction) {
  if (!canAct.value || props.pet.presence !== 'HOME') return;
  void store.dispatch({ type: 'PET_INTERACT', payload: { petId: props.pet.petId, interaction } },
    interaction === 'PET' ? `已摸摸${props.pet.nickname}的头` : interaction === 'WAKE'
      ? `${props.pet.nickname}已唤醒` : `${props.pet.nickname}开始休息，体力将逐渐恢复`);
}
function toggleVisibility() {
  if (!canAct.value) return;
  void store.dispatch({ type: 'PET_SET_VISIBILITY', payload: { petId: props.pet.petId, visibility: visible.value ? 'HIDDEN' : 'VISIBLE' } },
    `已更新${props.pet.nickname}的桌面显示设置`);
}
</script>

<template>
  <article class="pet-card panel" :class="{ featured, 'pet-card-primary': primary }">
    <div class="pet-card-art" :class="{ 'art-fluffy': pet.characterId === 'fluffy-ranger', 'art-away': pet.presence !== 'HOME' }">
      <span class="art-stars" aria-hidden="true">✧　⋆　✧</span>
      <span v-if="primary" class="primary-badge"><Icon name="spark" />主宠</span>
      <div class="portrait-frame" aria-hidden="true">
        <PetPortrait :character-id="pet.characterId" :sleeping="pet.activity === 'REST' || pet.activity === 'SLEEP'"
          :away="pet.presence !== 'HOME'" :paused="!store.ready || !!store.snapshot?.pausedRender || !!store.snapshot?.doNotDisturb" />
      </div>
      <span class="art-caption">角色 · {{ pet.presence === 'HOME' ? '在家' : '旅途中' }}</span>
    </div>
    <div class="pet-card-body">
      <div class="pet-card-header">
        <div><p class="eyebrow">伴侣档案</p><h2>{{ pet.nickname }}</h2></div>
        <span class="level-badge">Lv. {{ pet.level }}</span>
      </div>
      <div class="pet-status-row">
        <span class="status-pill" :class="pet.presence === 'HOME' ? 'status-home' : 'status-travel'"><span class="status-dot"></span>{{ petStatus(pet) }}</span>
        <span class="muted small">{{ visible ? '设置为显示' : '设置为隐藏' }}</span>
        <span class="xp-label">经验 {{ pet.xp }}</span>
      </div>
      <div class="stats-grid">
        <div v-for="stat in stats" :key="stat.name" class="stat" :class="'stat-' + stat.style">
          <div><span>{{ stat.name }}</span><strong>{{ scoreText(stat.value) }}<small>/100</small></strong></div>
          <progress :value="stat.value" :max="100" :aria-label="pet.nickname + stat.name" />
        </div>
      </div>
      <div class="pet-actions" aria-label="宠物操作">
        <button class="button button-primary" type="button" :disabled="!canAct || pet.presence !== 'HOME'" @click="interact('PET')"><Icon name="heart" />摸摸头</button>
        <button v-if="pet.activity === 'REST' || pet.activity === 'SLEEP'" class="button button-secondary" type="button" :disabled="!canAct || pet.presence !== 'HOME'" @click="interact('WAKE')"><Icon name="moon" />唤醒</button>
        <button v-else class="button button-secondary" type="button" :disabled="!canAct || pet.presence !== 'HOME'" @click="interact('REST')"><Icon name="moon" />休息</button>
        <button class="button button-secondary" type="button" :disabled="!canAct || primary" @click="select">{{ primary ? '当前主宠' : '设为主宠' }}</button>
        <button class="button button-secondary" type="button" :disabled="!canAct" @click="toggleVisibility">{{ visible ? '隐藏桌宠' : '显示桌宠' }}</button>
      </div>
      <p v-if="pet.presence !== 'HOME'" class="small muted">旅途中不能摸头或休息，请等待归家。</p>
    </div>
  </article>
</template>
