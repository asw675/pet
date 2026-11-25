<script setup lang="ts">
import { computed } from 'vue';
import { useAppStore } from '../../shared/store';
import Icon from '../components/Icon.vue';
import PetCard from '../components/PetCard.vue';

const store = useAppStore();
const pets = computed(() => store.snapshot?.pets ?? []);
const visibleCount = computed(() => pets.value.filter((pet) => pet.visibility === 'VISIBLE').length);
</script>

<template>
  <div class="page-intro panel">
    <span class="intro-icon"><Icon name="pet" /></span>
    <div><h2>已拥有的伙伴</h2><p>切换主宠不会重置宠物数据。显示设置与旅途状态分别保存。</p></div>
    <div v-if="store.snapshot" class="intro-numbers"><div><strong>{{ pets.length }}</strong><small>伙伴</small></div><div><strong>{{ visibleCount }}</strong><small>设置为显示</small></div></div>
  </div>
  <div v-if="store.snapshot && pets.length" class="pet-grid">
    <PetCard v-for="pet in pets" :key="pet.petId" :pet="pet" />
  </div>
  <div v-else class="panel empty-state"><Icon name="pet" /><h2>{{ store.snapshot ? '暂无伙伴' : '等待宠物档案' }}</h2><p>{{ store.snapshot ? '当前快照中尚无宠物实例。' : '本地服务返回快照后，可以查看宠物状态。' }}</p></div>
</template>
