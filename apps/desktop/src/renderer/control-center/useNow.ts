import { onMounted, onUnmounted, ref } from 'vue';

/** Only refresh the display clock. Advancing the game is the service's job. */
export function useNow() {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => { now.value = Date.now(); }, 1_000);
  });
  onUnmounted(() => {
    if (timer !== undefined) clearInterval(timer);
  });
  return now;
}
