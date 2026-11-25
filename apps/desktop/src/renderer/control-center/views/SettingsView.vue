<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useAppStore } from '../../shared/store';
import { serviceStatusLabel } from '../../shared/presentation';
import Icon from '../components/Icon.vue';
import ModeControls from '../components/ModeControls.vue';

const store = useAppStore();
</script>

<template>
  <div class="settings-grid">
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol"><Icon name="settings" /></span><div><h2>桌面表现</h2><p>独立保存的两项模式设置</p></div></header>
      <ModeControls />
      <div class="settings-note"><p>宠物的显示/隐藏与主宠选择，可前往宠物馆管理。</p><RouterLink class="panel-link" to="/pets">前往宠物馆 <Icon name="arrow" /></RouterLink></div>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-blue"><Icon name="refresh" /></span><div><h2>服务状态</h2><p>本地业务数据连接</p></div></header>
      <dl class="settings-list"><div><dt>当前连接</dt><dd>{{ serviceStatusLabel(store.serviceStatus) }}</dd></div><div><dt>快照版本</dt><dd>{{ store.snapshot?.revision ?? '未知' }}</dd></div></dl>
      <button class="button button-secondary side-button" type="button" :disabled="store.loading || store.busy" @click="store.refresh()"><Icon name="refresh" /> {{ store.loading ? '刷新中…' : '重新获取快照' }}</button>
    </section>
    <section class="panel side-panel">
      <header class="side-heading"><span class="panel-symbol accent-rose"><Icon name="spark" /></span><div><h2>后续设置</h2><p>待开发</p></div></header>
      <p class="muted">音量、系统启动、AI 服务、隐私授权、备份恢复和资源管理尚未开放。</p>
    </section>
  </div>
</template>
