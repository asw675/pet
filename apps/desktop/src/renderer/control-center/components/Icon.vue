<script setup lang="ts">
defineProps<{ name: string }>();
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <g v-if="name === 'home'"><path d="M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/></g>
    <g v-else-if="name === 'pet'"><path d="M6 15c2-2 4-5 6-5s4 3 6 5c3 5-2 6-6 4-4 2-9 1-6-4Z"/><ellipse cx="5" cy="9" rx="2" ry="3"/><ellipse cx="10" cy="5" rx="2" ry="3"/><ellipse cx="15" cy="5" rx="2" ry="3"/><ellipse cx="20" cy="9" rx="2" ry="3"/></g>
    <g v-else-if="name === 'map'"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/></g>
    <g v-else-if="name === 'report'"><path d="M6 3h9l5 5v13H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm9 0v6h5M8 13h8M8 17h8"/></g>
    <g v-else-if="name === 'bag'"><rect x="5" y="7" width="14" height="14" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M5 12h14M10 12v3h4v-3"/></g>
    <g v-else-if="name === 'shop'"><path d="M4 10V5h16v5M3 10l2-5h14l2 5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0ZM5 13v8h14v-8M9 21v-6h6v6"/></g>
    <g v-else-if="name === 'gallery'"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4 4-5 5 6"/></g>
    <g v-else-if="name === 'chat'"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 10h10M7 14h7"/></g>
    <g v-else-if="name === 'workspace'"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="7" rx="1.5"/><path d="M14 18.5h7m-3.5-3.5v7"/></g>
    <g v-else-if="name === 'settings'"><path d="M12 2l2 3 3-1 3 3-1 3 3 2-3 2 1 3-3 3-3-1-2 3-2-3-3 1-3-3 1-3-3-2 3-2-1-3 3-3 3 1 2-3Z"/><circle cx="12" cy="12" r="3"/></g>
    <g v-else-if="name === 'coin'"><circle cx="12" cy="12" r="9"/><path d="m12 6.5 4 5.5-4 5.5-4-5.5Z"/></g>
    <g v-else-if="name === 'refresh'"><path d="M20 4v6h-6M4 20v-6h6M4 10a8 8 0 0 1 13-5l3 5M20 14a8 8 0 0 1-13 5l-3-5"/></g>
    <g v-else-if="name === 'arrow'"><path d="M5 12h14m-6-6 6 6-6 6"/></g>
    <g v-else-if="name === 'clock'"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></g>
    <g v-else-if="name === 'spark'"><path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7Z"/></g>
    <g v-else-if="name === 'moon'"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/></g>
    <g v-else-if="name === 'pause'"><path d="M8 4v16M16 4v16"/></g>
    <g v-else-if="name === 'heart'"><path d="M12 20 4.7 12.7C-.2 7.9 7 2.2 12 8c5-5.8 12.2-.1 7.3 4.7Z"/></g>
    <g v-else><path d="m12 3 9 9-9 9-9-9Z"/></g>
  </svg>
</template>
