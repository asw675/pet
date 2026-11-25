import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useAppStore } from '../shared/store';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
const store = useAppStore(pinia);
const bridge = window.petDesktop;
store.connect(bridge?.role === 'control-center' ? bridge : undefined);
app.mount('#app');
window.addEventListener('pagehide', () => store.disconnect(), { once: true });
