<script setup lang="ts">
import { computed } from 'vue';
import type { PetSnapshot } from '@pet-desktop/contracts';
import { useAppStore } from '../../shared/store';
import { formatRemaining, formatTime, petStatus, routeName } from '../../shared/presentation';
import Icon from './Icon.vue';

const props = defineProps<{ pet: PetSnapshot; now: number; compact?: boolean }>();
const store = useAppStore();
const trip = computed(() => props.pet.trip);
const active = computed(() => trip.value?.status === 'TRAVELING');
const canRecall = computed(() => !!trip.value && active.value && props.pet.presence === 'AWAY' && store.ready && !store.busy && !store.loading);
const overdue = computed(() => active.value && !!trip.value && props.now >= trip.value.expectedReturnAt);

function recall() {
  if (!canRecall.value || !trip.value) return;
  void store.dispatch({ type: 'TRIP_RECALL', payload: { petId: props.pet.petId, tripId: trip.value.tripId } },
    `已发送${props.pet.nickname}的召回请求`);
}
function markRead() {
  if (!store.ready || store.busy || store.loading || !trip.value || active.value) return;
  void store.dispatch({ type: 'TRIP_REPORT_READ', payload: { petId: props.pet.petId, tripId: trip.value.tripId } }, '已确认旅行报告已读命令');
}
</script>

<template>
  <article v-if="trip" class="trip-card" :class="{ 'trip-card-compact': compact }">
    <div class="trip-icon" aria-hidden="true"><Icon :name="active ? 'map' : 'report'" /></div>
    <div class="trip-information">
      <p class="trip-route">{{ routeName(trip.routeId) }}</p>
      <div class="trip-meta"><strong>{{ pet.nickname }}</strong><span>·</span><span>{{ active ? petStatus(pet) : '已结算' }}</span></div>
      <div v-if="active" class="trip-countdown"><Icon name="clock" /> <strong>{{ overdue ? '已到预计归家时间' : formatRemaining(trip.expectedReturnAt, now) }}</strong></div>
      <small class="muted">{{ active ? '预计归家' : '归家时间' }} · {{ formatTime(trip.expectedReturnAt) }}</small>
      <p v-if="overdue" class="small muted">等待服务确认最终状态。</p>
    </div>
    <div class="trip-actions">
      <button v-if="active && pet.presence === 'AWAY'" class="button button-secondary" type="button" :disabled="!canRecall" @click="recall">召回</button>
      <span v-else-if="active" class="status-pill status-travel">返程中</span>
      <button v-else class="button button-secondary" type="button" :disabled="!store.ready || store.busy || store.loading" @click="markRead">标为已读</button>
    </div>
  </article>
</template>
