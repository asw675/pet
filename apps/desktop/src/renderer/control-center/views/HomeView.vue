<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import { useAppStore } from '../../shared/store';
import { useEventProjection } from '../useEventProjection';
import { useNow } from '../useNow';
import Icon from '../components/Icon.vue';
import PetCard from '../components/PetCard.vue';
import TripCard from '../components/TripCard.vue';
import ModeControls from '../components/ModeControls.vue';

const store = useAppStore();
const pets = computed(() => store.snapshot?.pets ?? []);
const primary = computed(() => pets.value.find((pet) => pet.petId === store.snapshot?.primaryPetId));
const companions = computed(() => pets.value.filter((pet) => pet.petId !== primary.value?.petId));
const activeTrips = computed(() => pets.value.filter((pet) => pet.trip?.status === 'TRAVELING'));
const settledTrips = computed(() => pets.value.filter((pet) => pet.trip?.status === 'SETTLED'));
const now = useNow();
const inboxQuery = computed<EventListQuery>(() => ({ filter: 'PENDING', offset: 0, limit: 1 }));
const { page: inbox, pending: inboxPending, queryError: inboxError, reload: reloadInbox } =
  useEventProjection(inboxQuery, () => {}, () => {}, { debounceMs: 250 });
</script>

<template>
  <div class="home-banner">
    <div><span class="banner-kicker"><Icon name="spark" /> 你的陪伴小屋</span><h2>{{ primary ? `今天的主宠，是${primary.nickname}。` : '经营你的星伴小屋。' }}</h2>
      <p>关心伙伴的状态，陪伴成长，偶尔一起踏上新的旅程。</p></div>
    <div class="banner-motif" aria-hidden="true"><span>✧</span><span>★</span><span>✦</span></div>
  </div>
  <div v-if="!store.snapshot" class="panel empty-state"><Icon name="pet" /><h2>等待伙伴的消息</h2><p>本地服务返回快照后，这里会显示真实的伙伴状态与养成数据。</p></div>
  <div v-else class="dashboard-grid">
    <div class="dashboard-primary">
      <section aria-labelledby="primary-heading">
        <header class="section-heading"><div><span class="eyebrow">今日陪伴</span><h2 id="primary-heading">我的主宠</h2></div><RouterLink to="/pets" class="panel-link">查看宠物馆 <Icon name="arrow" /></RouterLink></header>
        <PetCard v-if="primary" :pet="primary" featured />
        <div v-else class="panel empty-state compact-empty"><Icon name="pet" /><h3>尚未选择主宠</h3><p>前往宠物馆选择当前陪伴的伙伴。</p><RouterLink class="button button-primary" to="/pets">前往宠物馆</RouterLink></div>
      </section>
      <section aria-labelledby="companions-heading">
        <header class="section-heading"><div><span class="eyebrow">其他伙伴</span><h2 id="companions-heading">同住小屋 <small>{{ companions.length }}</small></h2></div></header>
        <div v-if="companions.length" class="companion-list"><PetCard v-for="pet in companions" :key="pet.petId" :pet="pet"/></div>
        <div v-else class="panel empty-state compact-empty"><p>当前没有其他伙伴。</p></div>
      </section>
    </div>
    <aside class="dashboard-aside" aria-label="故事、旅行和桌面偏好">
      <section class="panel side-panel">
        <header class="side-heading"><span class="panel-symbol accent-rose"><Icon name="spark" /></span><div><h2>伙伴的故事信箱</h2><p>真实待回应事件</p></div></header>
        <div v-if="inbox" class="side-empty">
          <template v-if="inbox.pendingTotal > 0"><strong>{{ inbox.pendingTotal }} 件故事等你回应</strong><p v-if="inbox.rows[0]">{{ inbox.rows[0].title }} · {{ pets.find(pet => pet.petId === inbox?.rows[0]?.petId)?.nickname ?? inbox.rows[0].characterId }}</p></template>
          <p v-else>暂时没有待回应的故事。</p>
        </div>
        <p v-else class="side-empty">{{ inboxPending ? '正在读取信箱…' : inboxError ? '信箱状态尚未确认。' : '等待事件档案。' }}</p>
        <p v-if="store.snapshot.doNotDisturb" class="small muted">勿扰模式下仅在此显示，不主动弹窗。</p>
        <button v-if="inboxError" type="button" class="button button-secondary" :disabled="inboxPending || store.busy || store.loading" @click="reloadInbox">重新读取</button>
        <RouterLink to="/events" class="panel-link">打开事件箱 <Icon name="arrow" /></RouterLink>
      </section>
      <section class="panel side-panel">
        <header class="side-heading"><span class="panel-symbol"><Icon name="map" /></span><div><h2>旅途中</h2><p>正在进行的冒险</p></div></header>
        <div v-if="activeTrips.length" class="side-trips"><TripCard v-for="pet in activeTrips" :key="pet.petId" :pet="pet" :now="now" compact /></div>
        <div v-else class="side-empty"><p>此刻没有进行中的旅行。<br />找一条小路，和伙伴一起出门吧。</p></div>
        <RouterLink to="/adventure/map" class="button button-primary side-button">前往冒险地图 <Icon name="arrow" /></RouterLink>
      </section>
      <section class="panel side-panel">
        <header class="side-heading"><span class="panel-symbol accent-rose"><Icon name="report" /></span><div><h2>最近的旅程</h2><p>已结算旅行快照</p></div></header>
        <div v-if="settledTrips.length" class="side-trips"><TripCard v-for="pet in settledTrips" :key="pet.petId" :pet="pet" :now="now" compact /></div>
        <p v-else class="side-empty">当前快照没有已结算的最近旅程。</p>
        <RouterLink to="/adventure/reports" class="panel-link">查看旅行报告 <Icon name="arrow" /></RouterLink>
      </section>
      <section class="panel side-panel">
        <header class="side-heading"><span class="panel-symbol accent-blue"><Icon name="moon" /></span><div><h2>安静一会儿</h2><p>按你的节奏陪伴</p></div></header>
        <ModeControls />
        <RouterLink to="/settings" class="panel-link">更多偏好 <Icon name="arrow" /></RouterLink>
      </section>
    </aside>
  </div>
</template>
