<script setup lang="ts">
withDefaults(defineProps<{
  characterId: string;
  sleeping?: boolean;
  away?: boolean;
  paused?: boolean;
}>(), { sleeping: false, away: false, paused: false });
</script>

<template>
  <!-- Original vector placeholder, deliberately independent of game state or a model SDK. -->
  <svg class="portrait" :class="{ paused, sleeping, away }" viewBox="0 0 180 184" fill="none" aria-hidden="true">
    <ellipse cx="90" cy="169" rx="61" ry="9" fill="#271d32" opacity=".26" />
    <g v-if="characterId === 'star-singer'" class="breathe" stroke-linecap="round" stroke-linejoin="round">
      <!-- Cape and little boots -->
      <path d="M62 120C53 131 45 149 45 159c20 10 70 10 90-1l-17-39" fill="#7563b6" stroke="#403051" stroke-width="3" />
      <path d="M68 156v8c-7 0-10 3-8 6h23l2-12M96 159l1 11h23c2-4-2-7-9-7v-7" fill="#53446c" stroke="#403051" stroke-width="3" />
      <path d="M66 120h49l9 38H55l11-38Z" fill="#b9a7ec" stroke="#403051" stroke-width="3" />
      <path d="m90 123-17 34h34L90 123Z" fill="#fff2d6" />
      <path d="M90 129v13m-6-6h12" stroke="#9a68b6" stroke-width="2.5" />
      <!-- Face and moon-colored hair -->
      <path d="M39 92c-4-37 17-58 51-59 35-1 55 23 52 55l6 23c-10 20-29 29-58 29-32 0-54-12-58-32l7-16Z" fill="#a494df" stroke="#403051" stroke-width="3" />
      <ellipse cx="90" cy="95" rx="39" ry="34" fill="#ffe5cf" stroke="#403051" stroke-width="2.5" />
      <path d="M48 86c0-35 18-43 46-43 25 0 41 15 41 37-15-3-33-9-41-19-7 13-24 22-46 25Z" fill="#cbbdf8" stroke="#403051" stroke-width="2.5" />
      <path d="M53 83c-4 16 0 32 8 39m67-40c4 14 0 32-8 39" stroke="#7966b2" stroke-width="3.5" />
      <!-- Lavender wizard's hat -->
      <path d="M32 66 58 56 71 16l27-6 35 43 20 11c-21 11-75 18-121 2Z" fill="#6e5aa7" stroke="#403051" stroke-width="3" />
      <path d="m58 56 75-3 5 7c-22 9-55 9-85 5l5-9Z" fill="#cab7f1" />
      <path d="m90 18 4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1 4-9Z" fill="#ffe29a" stroke="#f5d087" stroke-width="1.5" />
      <path d="M69 12C63 10 62 5 61 3" stroke="#7c6abd" stroke-width="2.5" />
      <!-- Eyes and blush -->
      <g v-if="sleeping" stroke="#493451" stroke-width="3"><path d="M67 95q6 7 12 0m22 0q6 7 12 0" /></g>
      <g v-else class="eyes" fill="#4d355e">
        <ellipse cx="74" cy="96" rx="4.4" ry="7.2" /><ellipse cx="107" cy="96" rx="4.4" ry="7.2" />
        <circle cx="75.2" cy="93.4" r="1.6" fill="#fff9ec" /><circle cx="108.2" cy="93.4" r="1.6" fill="#fff9ec" />
      </g>
      <ellipse cx="63" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" /><ellipse cx="118" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" />
      <path d="M86 106q4.5 4 9 0" stroke="#8f5260" stroke-width="2" />
      <path d="M132 96l10 42" stroke="#67404a" stroke-width="4" />
      <path d="m130 82 4 7 8 1-5 6 1 8-7-4-7 4 1-8-6-6 8-1 3-7Z" fill="#ffdc91" stroke="#bd8551" stroke-width="1.8" />
    </g>
    <g v-else-if="characterId === 'fluffy-ranger'" class="breathe" stroke-linecap="round" stroke-linejoin="round">
      <!-- Fluffy tail, vest and boots -->
      <path d="M125 140c22-19 46-13 34 9-6 12-18 20-39 14Z" fill="#dc925e" stroke="#614334" stroke-width="3" />
      <path d="M143 132c13-2 20 4 16 17-4 7-8 11-12 13-4-9-7-18-4-30Z" fill="#ffecc7" />
      <path d="M68 157v8c-8-1-12 4-10 6h25l2-13m10 0 2 13h25c1-3-4-6-10-6l-1-8" fill="#6f5148" stroke="#614334" stroke-width="3" />
      <path d="M64 119h52l12 40H53l11-40Z" fill="#71977b" stroke="#614334" stroke-width="3" />
      <path d="m79 123 11 29 12-29 13 34H65l14-34Z" fill="#fbddac" />
      <path d="M70 142h40" stroke="#805d48" stroke-width="6" /><rect x="85" y="139" width="10" height="7" rx="1.5" fill="#f8cb70" />
      <!-- Animal ears and hair -->
      <path d="M48 66 38 20q1-9 14-2l31 30m14 0 31-30q13-7 14 2l-10 46" fill="#dc925e" stroke="#614334" stroke-width="3" />
      <path d="m48 30 9 28 16-6Zm84 0-9 28-16-6Z" fill="#f5b7a4" />
      <path d="M34 95c0-35 22-55 56-55s56 20 56 55l-6 18-10 9c-14 13-65 15-80 0l-10-9-6-18Z" fill="#e6a66f" stroke="#614334" stroke-width="3" />
      <ellipse cx="90" cy="97" rx="39" ry="34" fill="#ffe9ca" stroke="#614334" stroke-width="2.5" />
      <path d="M52 86c0-29 14-37 37-37 24 0 40 14 40 32-12-5-21-8-26-18-9 12-29 23-51 23Z" fill="#e7a66e" stroke="#614334" stroke-width="2.5" />
      <path d="M43 91c4 8 4 18 1 27 7-1 10-6 13-12m80-15c-4 8-4 18-1 27-7-1-10-6-13-12" fill="#ffe0b6" stroke="#614334" stroke-width="2.5" />
      <path d="M61 56q16-16 41-7" stroke="#f4c57d" stroke-width="4" />
      <path d="m111 53 14-8 7 10-14 5-7-7Z" fill="#76ac83" stroke="#477356" stroke-width="2" />
      <!-- Eyes, freckles and smile -->
      <g v-if="sleeping" stroke="#624235" stroke-width="3"><path d="M67 97q6 7 12 0m22 0q6 7 12 0" /></g>
      <g v-else class="eyes" fill="#71513b">
        <ellipse cx="74" cy="98" rx="4.6" ry="7" /><ellipse cx="106" cy="98" rx="4.6" ry="7" />
        <circle cx="75.4" cy="95.5" r="1.5" fill="#fff9ec" /><circle cx="107.4" cy="95.5" r="1.5" fill="#fff9ec" />
      </g>
      <ellipse cx="63" cy="108" rx="6" ry="3" fill="#ed9b88" opacity=".7" /><ellipse cx="117" cy="108" rx="6" ry="3" fill="#ed9b88" opacity=".7" />
      <path d="M85 108q5 6 10 0" stroke="#a76b53" stroke-width="2.2" />
      <path d="M54 132c-11-2-15 7-14 14l10 3 7-7" fill="#ffe9ca" stroke="#614334" stroke-width="2.5" />
      <path d="M125 131c9-4 15 3 15 12l-9 6-8-7" fill="#ffe9ca" stroke="#614334" stroke-width="2.5" />
    </g>
    <g v-else class="breathe" stroke="#51435a" stroke-width="3" stroke-linecap="round">
      <path d="M39 106c0-43 23-66 51-66s51 23 51 66-21 54-51 54-51-11-51-54Z" fill="#ccb9d6" />
      <circle cx="73" cy="99" r="5" fill="#51435a" /><circle cx="107" cy="99" r="5" fill="#51435a" />
      <path d="M83 114q7 5 14 0" />
    </g>
    <g v-if="sleeping && !away" class="sleep-marks" fill="#fbe7bd" stroke="#6a597c" stroke-width=".8" stroke-linejoin="round">
      <path d="M144 13h11l-11 12h11v3h-15v-3l11-9h-7Z" />
      <path d="M158 3h8l-7 7h7v2h-10V9l7-4h-5Z" />
    </g>
    <g v-if="away" stroke="#815a39" stroke-width="2.5">
      <rect x="121" y="120" width="34" height="26" rx="6" fill="#e7b76c" />
      <path d="M132 120v-5q6-7 12 0v5m-23 10h34" /><rect x="136" y="126" width="5" height="7" rx="1" fill="#fff0c8" />
    </g>
  </svg>
</template>

<style scoped>
.portrait { display: block; width: 100%; height: 100%; overflow: visible; }
.breathe { transform-box: view-box; transform-origin: 50% 94%; animation: bob 3.8s ease-in-out infinite; }
.eyes { transform-box: fill-box; transform-origin: center; animation: blink 5.5s ease-in-out infinite; }
.sleep-marks { animation: float 3s ease-in-out infinite; }
.sleeping .breathe { animation-duration: 5s; }
.paused .breathe, .paused .eyes, .paused .sleep-marks { animation: none; }
@keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes blink { 0%, 44%, 49%, 100% { transform: scaleY(1); } 46%, 47% { transform: scaleY(.08); } }
@keyframes float { 0%, 100% { opacity: .65; transform: translateY(1px); } 50% { opacity: 1; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .breathe, .eyes, .sleep-marks { animation: none; } }
</style>
