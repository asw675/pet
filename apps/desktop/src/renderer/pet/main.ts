import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PetApp from './PetApp.vue';
import { useAppStore } from '../shared/store';

const pinia = createPinia();
const store = useAppStore(pinia);
store.connect(window.petDesktop?.role === 'pet' ? window.petDesktop : undefined);
createApp(PetApp).use(pinia).mount('#app');
window.addEventListener('pagehide', () => store.disconnect(), { once: true });
