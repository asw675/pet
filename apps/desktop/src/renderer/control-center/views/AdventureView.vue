<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useAppStore } from '../../shared/store';
import { petStatus, routeName } from '../../shared/presentation';
import { useNow } from '../useNow';
import Icon from '../components/Icon.vue';
import TripCard from '../components/TripCard.vue';
import PetPortrait from '../../shared/PetPortrait.vue';

const routeId = 'morning-dew-meadow'; // The service's current POC route identifier.
const store = useAppStore();
const pets = computed(() => store.snapshot?.pets ?? []);
const activeTrips = computed(() => pets.value.filter((pet) => pet.trip?.status === 'TRAVELING'));
const now = useNow();

function start(petId: string, nickname: string) {
  if (!store.ready || store.busy || store.loading || pets.value.find((pet) => pet.petId === petId)?.presence !== 'HOME') return;
  void store.dispatch({ type: 'TRIP_START', payload: { petId, routeId } }, `${nickname}踏上了新的旅程`);
}
</script>

<template>
  <section aria-labelledby="route-heading">
    <header class="section-heading"><div><span class="eyebrow">旅行准备</span><h2 id="route-heading">探索路线</h2></div><span class="subtle-tag">当前演示路线</span></header>
    <div class="route-panel panel">
      <div class="route-landscape" aria-hidden="true">
        <svg viewBox="0 0 560 240" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#373841"/><stop offset="1" stop-color="#8c7770"/></linearGradient><linearGradient id="hills" x2="0" y2="1"><stop stop-color="#697b67"/><stop offset="1" stop-color="#334b41"/></linearGradient></defs>
          <rect width="560" height="240" fill="url(#sky)"/>
          <circle cx="426" cy="58" r="30" fill="#e8bf88" opacity=".85"/>
          <circle cx="64" cy="40" r="2" fill="#eaddcb"/><circle cx="142" cy="67" r="2" fill="#eaddcb"/><circle cx="334" cy="36" r="2" fill="#eaddcb"/>
          <path d="M0 135 110 65 202 131 292 74 402 142 492 83 560 122V240H0Z" fill="#605c63"/>
          <path d="M0 152Q110 97 221 160T450 136Q504 114 560 153V240H0Z" fill="#53635b"/>
          <path d="M0 181Q100 127 213 185T438 169Q503 151 560 176V240H0Z" fill="url(#hills)"/>
          <path d="M280 240q70-30 30-49t42-25" fill="none" stroke="#d4b386" stroke-width="17" opacity=".75"/>
          <path d="M30 237v-46m0 13-16-13m16 25 17-14M501 235v-42m0 11-14-12m14 23 17-13" stroke="#d1b586" stroke-width="3" fill="none"/>
          <g fill="#e7c392"><circle cx="14" cy="190" r="3"/><circle cx="48" cy="202" r="3"/><circle cx="486" cy="192" r="3"/><circle cx="518" cy="202" r="3"/></g>
          <g fill="#d9c7a4" opacity=".7"><circle cx="90" cy="217" r="2"/><circle cx="120" cy="193" r="2"/><circle cx="445" cy="224" r="2"/><circle cx="390" cy="191" r="2"/></g>
        </svg>
        <span class="landscape-mark">✧  星伴旅途</span>
      </div>
      <div class="route-details">
        <p class="eyebrow">当前可提交的路线</p><h3>{{ routeName(routeId) }}</h3>
        <p class="muted">请选择一位在家的伙伴出发。实际出发条件和回程时间由本地业务服务确认。</p>
        <div v-if="pets.length" class="departure-list">
          <div v-for="pet in pets" :key="pet.petId" class="departure-row">
            <span class="mini-portrait" aria-hidden="true"><PetPortrait :character-id="pet.characterId" :paused="true" :away="pet.presence !== 'HOME'" /></span>
            <div class="departure-info"><strong>{{ pet.nickname }}</strong><small>{{ petStatus(pet) }} · 精力 {{ pet.energy }}/100</small></div>
            <button class="button button-primary" type="button" :disabled="!store.ready || store.busy || store.loading || pet.presence !== 'HOME'" @click="start(pet.petId, pet.nickname)">{{ pet.presence === 'HOME' ? '出发' : '旅途中' }}</button>
          </div>
        </div>
        <p v-else class="side-empty">等待本地宠物快照，暂时无法出发。</p>
      </div>
    </div>
  </section>
  <section aria-labelledby="active-heading" class="page-section">
    <header class="section-heading"><div><span class="eyebrow">归家倒计时</span><h2 id="active-heading">当前旅行</h2></div><RouterLink to="/adventure/reports" class="panel-link">旅行报告 <Icon name="arrow" /></RouterLink></header>
    <div class="panel trip-list" v-if="activeTrips.length"><TripCard v-for="pet in activeTrips" :key="pet.petId" :pet="pet" :now="now" /></div>
    <div v-else class="panel empty-state compact-empty"><Icon name="map" /><h3>{{ store.snapshot ? '此刻没有进行中的旅行' : '等待旅行快照' }}</h3><p>出发后会显示服务确认的归家时间；到达预计时间后等待服务确认。</p></div>
  </section>
</template>
