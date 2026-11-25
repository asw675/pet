import { createRouter, createWebHashHistory } from 'vue-router';

export const navigation = [
  { to: '/home', label: '首页', icon: 'home', group: '陪伴' },
  { to: '/pets', label: '宠物馆', icon: 'pet', group: '陪伴' },
  { to: '/adventure/map', label: '冒险地图', icon: 'map', group: '冒险' },
  { to: '/adventure/reports', label: '旅行报告', icon: 'report', group: '冒险' },
  { to: '/inventory', label: '背包装备', icon: 'bag', group: '冒险' },
  { to: '/shop', label: '商店', icon: 'shop', group: '冒险' },
  { to: '/gallery', label: '事件图鉴', icon: 'gallery', group: '冒险' },
  { to: '/chat', label: '对话中心', icon: 'chat', group: '更多' },
  { to: '/workspace', label: '快捷工作台', icon: 'workspace', group: '更多' },
  { to: '/settings', label: '设置', icon: 'settings', group: '更多' },
] as const;

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/home', component: () => import('./views/HomeView.vue'), meta: { title: '首页', subtitle: '今天，也有小伙伴等你回家。' } },
    { path: '/pets', component: () => import('./views/PetsView.vue'), meta: { title: '宠物馆', subtitle: '每个小伙伴都有独立的成长故事。' } },
    { path: '/adventure/map', component: () => import('./views/AdventureView.vue'), meta: { title: '冒险地图', subtitle: '从一条小路开始，探索外面的世界。' } },
    { path: '/adventure/reports', component: () => import('./views/ReportsView.vue'), meta: { title: '旅行报告', subtitle: '出门的每一次经历，都值得珍藏。' } },
    { path: '/inventory', component: () => import('./views/InventoryView.vue'), meta: { title: '背包装备', subtitle: '为每一趟冒险准备行囊。' } },
    { path: '/shop', component: () => import('./views/ShopView.vue'), meta: { title: '商店', subtitle: '用游戏金币购买旅行补给、礼物和装备。' } },
    { path: '/gallery', component: () => import('./views/GalleryView.vue'), meta: { title: '事件图鉴', subtitle: '收藏每份旅途中留下的见闻。' } },
    { path: '/chat', component: () => import('./views/FutureView.vue'), props: { icon: 'chat', title: '对话中心', description: '独立角色会话、文本对话、语音与记忆管理待接入；此处不会发送任何聊天数据。' }, meta: { title: '对话中心', subtitle: '有些心事，未来可以慢慢聊。' } },
    { path: '/workspace', component: () => import('./views/FutureView.vue'), props: { icon: 'workspace', title: '快捷工作台', description: '应用收藏、场景组合及执行授权待开发；当前不支持从这里启动任何外部应用。' }, meta: { title: '快捷工作台', subtitle: '为日常工作留一扇方便的小门。' } },
    { path: '/settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置', subtitle: '按照你的节奏，安排桌宠的陪伴。' } },
    { path: '/:pathMatch(.*)*', redirect: '/home' },
  ],
});
