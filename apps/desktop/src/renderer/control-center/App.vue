<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useAppStore } from '../shared/store';
import { serviceStatusLabel } from '../shared/presentation';
import { navigation } from './router';
import Icon from './components/Icon.vue';

const store = useAppStore();
const route = useRoute();
const groups = ['陪伴', '冒险', '更多'] as const;
const title = computed(() => String(route.meta.title ?? '控制中心'));
const subtitle = computed(() => String(route.meta.subtitle ?? ''));
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink to="/home" class="brand" aria-label="桌宠控制中心首页">
        <span class="brand-emblem"><Icon name="spark" /></span>
        <span class="brand-copy"><strong>星伴小屋</strong><small>桌宠 · 控制中心</small></span>
      </RouterLink>
      <nav class="navigation" aria-label="主导航">
        <section v-for="group in groups" :key="group" class="nav-group">
          <p class="nav-heading">{{ group }}</p>
          <RouterLink v-for="item in navigation.filter((item) => item.group === group)" :key="item.to"
            :to="item.to" class="nav-link" :aria-label="item.label" :title="item.label">
            <Icon :name="item.icon" /><span>{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>
      <div class="sidebar-footer">
        <span class="connection-dot" :class="{ online: store.ready }"></span>
        <span class="connection-copy"><strong>{{ serviceStatusLabel(store.serviceStatus) }}</strong><small>本地服务 · 开发原型</small></span>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="topbar-heading"><span class="eyebrow">星伴小屋 / 控制中心</span><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
        <div class="topbar-actions">
          <div class="wallet" aria-label="共享金币">
            <Icon name="coin" /><span><small>共享金币</small><strong>{{ store.snapshot?.walletCoins ?? '—' }}</strong></span>
          </div>
          <button class="button button-secondary refresh-button" type="button" :disabled="store.loading || store.busy" @click="store.refresh()" title="刷新业务快照">
            <Icon name="refresh" /><span>{{ store.loading ? '刷新中…' : '刷新' }}</span>
          </button>
        </div>
      </header>
      <main class="content" id="main-content" :aria-busy="store.loading || store.busy">
        <div v-if="!store.ready" class="feedback feedback-warning" role="status">
          <Icon name="clock" /><div><strong>{{ serviceStatusLabel(store.serviceStatus) }}</strong><p>{{ store.serviceStatus?.stage === 'UNAVAILABLE' ? '如果本地服务持续不可用，可在设置中从备份恢复。' : store.snapshot ? '当前快照仅供参考。服务恢复后再继续操作。' : '等待本地服务返回快照。' }}</p></div>
        </div>
        <div v-if="store.error" class="feedback feedback-error" role="alert">
          <div><strong>暂时无法完成操作</strong><p>{{ store.error }}</p></div>
          <button type="button" class="text-button" @click="store.clearFeedback()">关闭</button>
        </div>
        <div v-else-if="store.notice" class="feedback feedback-success" role="status">
          <Icon name="spark" /><div>{{ store.notice }}</div><button type="button" class="text-button" @click="store.clearFeedback()">关闭</button>
        </div>
        <RouterView />
      </main>
      <footer class="main-footer"><Icon name="spark" /> 星伴小屋 · 本地开发原型　·　所有养成数据由本地服务确认</footer>
    </div>
  </div>
</template>
