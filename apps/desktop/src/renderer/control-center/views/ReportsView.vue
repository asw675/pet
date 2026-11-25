<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useAppStore } from '../../shared/store';
import Icon from '../components/Icon.vue';
import TripCard from '../components/TripCard.vue';

const store = useAppStore();
const reports = computed(() => (store.snapshot?.pets ?? []).filter((pet) => pet.trip?.status === 'SETTLED'));
</script>

<template>
  <div class="page-intro panel">
    <span class="intro-icon"><Icon name="report" /></span>
    <div><h2>最近结算快照</h2><p>当前展示每位伙伴最近可见的已结算旅程，详细战报、奖励、已读状态和更多历史将在后续阶段接入。</p></div>
    <span v-if="store.snapshot" class="subtle-tag">{{ reports.length }} 条快照</span>
  </div>
  <div v-if="reports.length" class="panel trip-list"><TripCard v-for="pet in reports" :key="pet.petId" :pet="pet" :now="pet.trip?.expectedReturnAt ?? 0" /></div>
  <div v-else class="panel empty-state">
    <Icon name="report" /><h2>{{ store.snapshot ? '当前没有可见的已结算旅程' : '等待旅行报告快照' }}</h2><p>下一次归家的记录将由服务更新到旅行快照。</p>
    <RouterLink class="button button-primary" to="/adventure/map">前往冒险地图 <Icon name="arrow" /></RouterLink>
  </div>
</template>
