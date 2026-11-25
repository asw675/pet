<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useAppStore } from '../../shared/store';
import Icon from '../components/Icon.vue';
withDefaults(defineProps<{ icon: string; title: string; description: string; showWallet?: boolean }>(), { showWallet: false });
const store = useAppStore();
</script>

<template>
  <section class="panel future-panel">
    <div class="future-ornament" aria-hidden="true"><span>✧</span><span>⋆</span><span>✧</span></div>
    <div class="future-icon"><Icon :name="icon" /></div>
    <span class="subtle-tag">待开发</span>
    <h2>{{ title }}</h2><p>{{ description }}</p>
    <div v-if="showWallet && store.snapshot" class="wallet future-wallet"><Icon name="coin" /><span><small>当前共享金币</small><strong>{{ store.snapshot.walletCoins }}</strong></span></div>
    <RouterLink class="button button-secondary" to="/home">返回首页 <Icon name="arrow" /></RouterLink>
  </section>
</template>
