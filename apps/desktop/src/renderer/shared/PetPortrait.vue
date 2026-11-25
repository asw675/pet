<script setup lang="ts">
withDefaults(defineProps<{
  characterId: string;
  sleeping?: boolean;
  away?: boolean;
  paused?: boolean;
}>(), { sleeping: false, away: false, paused: false });
</script>

<template>
  <!-- Original anime heroine placeholders, independent of game state and model SDK. -->
  <svg class="portrait" :class="{ paused, sleeping, away }" viewBox="0 0 180 184" fill="none" aria-hidden="true">
    <ellipse cx="90" cy="169" rx="61" ry="9" fill="#271d32" opacity=".26" />
    <g v-if="characterId === 'star-singer'" class="breathe" stroke-linecap="round" stroke-linejoin="round">
      <!-- Long pink hair and two curved fantasy horns, not animal ears. -->
      <path d="M39 79C37 45 61 27 90 27s53 19 52 54c-1 27 13 54 17 80l-11 11-13-7-10 6-7-23-17 13H78l-17-13-8 23-10-6-14 7-10-11c4-25 20-55 20-82Z" fill="#ad507d" stroke="#433451" stroke-width="3" />
      <path d="M42 79q-1 40-15 83l12 6q19-24 20-63l-17-26Zm98 0q1 40 15 83l-12 6q-19-24-20-63l17-26Z" fill="#e47d98" />
      <path d="M37 110q-5 27-11 43m117-43q5 27 11 43" stroke="#ffb2c8" stroke-width="3.2" />
      <path d="M59 58C43 56 30 45 28 31c-2-11 2-20 14-25-5 12-4 21 3 28l17 12Z" fill="#3d304d" stroke="#433451" stroke-width="3" />
      <path d="M121 58c16-2 29-13 31-27 2-11-2-20-14-25 5 12 4 21-3 28l-17 12Z" fill="#3d304d" stroke="#433451" stroke-width="3" />
      <path d="M34 24q-1 14 16 24m96-24q1 14-16 24" stroke="#876a96" stroke-width="3" />
      <!-- Dark purple tailored skirt, long stockings and boots. -->
      <path d="M67 151v15c-7 0-11 4-9 7h25l3-19m10 0 2 19h25c2-3-3-7-10-7v-15" fill="#30263f" stroke="#433451" stroke-width="3" />
      <path d="M72 155v11m36-11v11" stroke="#8b759d" stroke-width="2.5" />
      <path d="M65 135h50l13 25H52l13-25Z" fill="#726082" stroke="#433451" stroke-width="3" />
      <path d="M75 142l-9 14m40-14 9 14m-55 1h60" stroke="#473752" stroke-width="2.2" />
      <path d="M64 119h18l8 12 8-12h18l5 23H59l5-23Z" fill="#30263f" stroke="#433451" stroke-width="3" />
      <path d="m78 120 12 11 12-11-5 20H83l-5-20Z" fill="#69527d" stroke="#b67ab1" stroke-width="2" />
      <path d="M61 140h58" stroke="#b67ab1" stroke-width="3" />
      <path d="m90 128 2 5 6 1-4 4 1 6-5-3-5 3 1-6-4-4 6-1 2-5Z" fill="#ffe29a" />
      <path d="M60 129q-14-4-18 8l7 7 11-5m60-10q14-4 18 8l-7 7-11-5" fill="#ffe5cf" stroke="#433451" stroke-width="2.5" />
      <!-- Human face, swept bangs and feminine eye styling. -->
      <ellipse cx="90" cy="95" rx="39" ry="34" fill="#ffe5cf" stroke="#403051" stroke-width="2.5" />
      <path d="M48 83c0-35 18-48 46-48 25 0 42 22 42 47-16-7-27-13-32-25-4 12-10 16-13 23l-9-12C73 77 60 84 48 83Z" fill="#e17a98" stroke="#433451" stroke-width="2.5" />
      <path d="M51 78q-10 27 2 54l9-6q-7-20 0-38m67-10q10 27-2 54l-9-6q7-20 0-38" fill="#e47d98" stroke="#433451" stroke-width="2.5" />
      <path d="M57 61q10-9 24-11m-28 40q-2 16 3 29m72-29q2 16-3 29" stroke="#ffb2c8" stroke-width="3" />
      <g v-if="sleeping" stroke="#493451" stroke-width="3"><path d="M67 95q6 7 12 0m22 0q6 7 12 0" /></g>
      <g v-else class="eyes" stroke="#493451" stroke-width="1.5">
        <ellipse cx="74" cy="96" rx="9" ry="10.4" fill="#fff9ee" /><ellipse cx="107" cy="96" rx="9" ry="10.4" fill="#fff9ee" />
        <ellipse cx="74" cy="96" rx="6.4" ry="9.1" fill="#638ec8" /><ellipse cx="107" cy="96" rx="6.4" ry="9.1" fill="#d779a7" />
        <ellipse cx="74.5" cy="100.5" rx="4.7" ry="3.2" fill="#b4ddf7" stroke="none" /><ellipse cx="107.5" cy="100.5" rx="4.7" ry="3.2" fill="#ffc3dc" stroke="none" />
        <ellipse cx="74" cy="95" rx="3.5" ry="5.3" fill="#433451" /><ellipse cx="107" cy="95" rx="3.5" ry="5.3" fill="#433451" />
        <path d="M65 91l-3-3m53 3 3-3M67 87q7-4 14 0m19 0q7-4 14 0" fill="none" stroke-width="2.5" />
        <circle cx="71.5" cy="92" r="2.5" fill="#fff9ee" stroke="none" /><circle cx="104.5" cy="92" r="2.5" fill="#fff9ee" stroke="none" />
        <circle cx="77.1" cy="100.3" r="1.2" fill="#fff9ee" stroke="none" /><circle cx="110.1" cy="100.3" r="1.2" fill="#fff9ee" stroke="none" />
      </g>
      <ellipse cx="63" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" /><ellipse cx="118" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" />
      <path d="M86 106q4.5 4 9 0" stroke="#8f5260" stroke-width="2" />
    </g>
    <g v-else-if="characterId === 'fluffy-ranger'" class="breathe" stroke-linecap="round" stroke-linejoin="round">
      <!-- Auburn-haired human woodland adventurer. -->
      <path d="M39 77C38 34 59 25 90 25s53 19 52 52c-1 31 10 53 12 78l-10 9-13-6-7 6-6-25-17 14H79l-17-14-6 25-7-6-13 6-10-9c2-25 13-47 12-78Z" fill="#844537" stroke="#614334" stroke-width="3" />
      <path d="M38 87q3 37-10 65l11 9q19-23 18-61l-19-13Zm104 0q-3 37 10 65l-11 9q-19-23-18-61l19-13Z" fill="#ac604e" />
      <path d="M42 118l-8 31m104-31 8 31" stroke="#df956e" stroke-width="3" />
      <path d="M68 157v8c-8-1-12 4-10 6h25l2-13m10 0 2 13h25c1-3-4-6-10-6l-1-8" fill="#6f5148" stroke="#614334" stroke-width="3" />
      <path d="M64 119h52l12 40H53l11-40Z" fill="#71977b" stroke="#614334" stroke-width="3" />
      <path d="m72 119 18 15 18-15 5 25H67l5-25Z" fill="#fbddac" stroke="#614334" stroke-width="1.5" />
      <path d="M64 139l-7 10 13-3 20 10 19-10 15 3-8-10-11-14-15 10-15-10Z" fill="#71977b" stroke="#614334" stroke-width="2" />
      <path d="M70 142h40" stroke="#805d48" stroke-width="6" /><rect x="85" y="139" width="10" height="7" rx="1.5" fill="#f8cb70" />
      <ellipse cx="90" cy="97" rx="39" ry="34" fill="#ffe5cf" stroke="#614334" stroke-width="2.5" />
      <path d="M50 86c0-31 16-48 39-48 24 0 44 21 44 44-12-6-22-10-29-23-4 9-15 13-22 21l-8-8c-7 9-15 13-24 14Z" fill="#ac604e" stroke="#614334" stroke-width="2.5" />
      <path d="M51 83q-11 26 0 53l11-7q-9-17-3-37m71-9q10 26 0 53l-11-7q9-17 3-37" fill="#ac604e" stroke="#614334" stroke-width="2.5" />
      <path d="M61 56q16-16 41-7m-49 43q-2 16 3 29m72-29q2 16-3 29" stroke="#df956e" stroke-width="3.2" />
      <path d="m111 53 14-8 7 10-14 5-7-7Z" fill="#76ac83" stroke="#477356" stroke-width="2" />
      <g v-if="sleeping" stroke="#624235" stroke-width="3"><path d="M67 97q6 7 12 0m22 0q6 7 12 0" /></g>
      <g v-else class="eyes" stroke="#624235" stroke-width="1.5">
        <ellipse cx="74" cy="98" rx="9" ry="10.4" fill="#fff9ee" /><ellipse cx="107" cy="98" rx="9" ry="10.4" fill="#fff9ee" />
        <ellipse cx="74" cy="98" rx="6.4" ry="9.1" fill="#588e78" /><ellipse cx="107" cy="98" rx="6.4" ry="9.1" fill="#588e78" />
        <ellipse cx="74.5" cy="102.5" rx="4.7" ry="3.2" fill="#aed9a7" stroke="none" /><ellipse cx="107.5" cy="102.5" rx="4.7" ry="3.2" fill="#aed9a7" stroke="none" />
        <ellipse cx="74" cy="97" rx="3.5" ry="5.3" fill="#624235" /><ellipse cx="107" cy="97" rx="3.5" ry="5.3" fill="#624235" />
        <path d="M65 93l-3-3m53 3 3-3M67 89q7-4 14 0m19 0q7-4 14 0" fill="none" stroke-width="2.5" />
        <circle cx="71.5" cy="94" r="2.5" fill="#fff9ee" stroke="none" /><circle cx="104.5" cy="94" r="2.5" fill="#fff9ee" stroke="none" />
        <circle cx="77.1" cy="102.3" r="1.2" fill="#fff9ee" stroke="none" /><circle cx="110.1" cy="102.3" r="1.2" fill="#fff9ee" stroke="none" />
      </g>
      <ellipse cx="63" cy="108" rx="6" ry="3" fill="#ed9b88" opacity=".7" /><ellipse cx="117" cy="108" rx="6" ry="3" fill="#ed9b88" opacity=".7" />
      <path d="M85 108q5 6 10 0" stroke="#a76b53" stroke-width="2.2" />
      <path d="M54 132c-11-2-15 7-14 14l10 3 7-7" fill="#ffe5cf" stroke="#614334" stroke-width="2.5" />
      <path d="M125 131c9-4 15 3 15 12l-9 6-8-7" fill="#ffe5cf" stroke="#614334" stroke-width="2.5" />
    </g>
    <g v-else-if="characterId === 'nova'" class="breathe" stroke-linecap="round" stroke-linejoin="round">
      <!-- Original humanoid mechanical assistant: silver-blue hair, cyan optics,
           white tech blazer over graphite skirt and articulated boots. -->
      <path d="M41 79C34 41 58 26 87 26s54 16 55 52l-1 26 8 29-5 22-13 7-12-14-9 5H69l-10-6-11 12-19-6 7-31 5-43Z" fill="#819dbb" stroke="#334f69" stroke-width="3" />
      <path d="M41 103l14 6-1 22-13 18-8 4 4-24Zm98-1-12 7 1 24 11 18 7-3-3-20Z" fill="#dce9f8" />
      <path d="M41 118l-5 26m103-26 5 26" stroke="#f8fcff" stroke-width="2.5" />
      <path d="M68 151v15l-9 5h24l3-20m9 0 2 20h24l-9-5v-15" fill="#394c64" stroke="#334f69" stroke-width="3" />
      <path d="M72 154v10m35-10v10" stroke="#65bdd9" stroke-width="2.5" />
      <path d="M64 167h12m28 0h12" stroke="#ecf3f9" stroke-width="3" />
      <path d="M65 135h50l13 25H52l13-25Z" fill="#526982" stroke="#334f69" stroke-width="3" />
      <path d="M63 140l17 3-6 16H53Zm54 0-17 3 6 16h21Z" fill="#ecf3f9" stroke="#334f69" stroke-width="1.7" />
      <path d="M82 145l-3 11m19-11 3 11" stroke="#65bdd9" stroke-width="2" />
      <path d="M68 116h44l12 13-11 5 5 9H62l5-9-11-5Z" fill="#ecf3f9" stroke="#334f69" stroke-width="3" />
      <path d="M75 119l15 10 15-10 3 23H72Z" fill="#394c64" stroke="#334f69" stroke-width="2" />
      <path d="m84 122 6 8 6-8 3 14-9 6-9-6Z" fill="#65bdd9" stroke="#334f69" stroke-width="1.5" />
      <path d="m90 128 6 5-6 6-6-6Z" fill="#d1fcff" stroke="#70e5ef" stroke-width="1.5" />
      <path d="M64 141h52" stroke="#65bdd9" stroke-width="3" />
      <path d="M57 128l10 2-6 17-11-3 1-11Zm66 0-10 2 6 17 11-3-1-11Z" fill="#ecf3f9" stroke="#334f69" stroke-width="2" />
      <ellipse cx="51" cy="147" rx="8" ry="6" fill="#ffe5cf" stroke="#334f69" stroke-width="1.8" /><ellipse cx="129" cy="147" rx="8" ry="6" fill="#ffe5cf" stroke="#334f69" stroke-width="1.8" />
      <path d="M48 141l9-2m75 2-9-2" stroke="#65bdd9" stroke-width="2.6" />
      <ellipse cx="90" cy="95" rx="39" ry="34" fill="#ffe5cf" stroke="#334f69" stroke-width="2.5" />
      <path d="M48 82c0-33 18-49 42-49 24 0 43 18 43 48l-13-9-13-19-9 12-12 10-8-13-8 15-12 7Z" fill="#eef5ff" stroke="#334f69" stroke-width="2.5" />
      <path d="M49 77l11 10-2 18 8 17-7 15-10-7-5-25Zm81 0 10 6 1 20-9 24-11-6 8-17Z" fill="#dce9f8" stroke="#334f69" stroke-width="2.1" />
      <path d="M58 58l15-11 18 2m18 6 12 11M50 92l3 24m83-24-3 21" stroke="#f8fcff" stroke-width="3" />
      <path d="m68 57 8-6 5 4-8 6Z" fill="#394c64" stroke="#334f69" stroke-width="1.4" />
      <path d="m70 57 8-5" stroke="#70e5ef" stroke-width="1.5" />
      <g v-if="sleeping" stroke="#334f69" stroke-width="3"><path d="M67 95q6 7 12 0m22 0q6 7 12 0" /></g>
      <g v-else class="eyes" stroke="#334f69" stroke-width="1.5">
        <ellipse cx="74" cy="96" rx="9" ry="10.4" fill="#fff9ee" /><ellipse cx="107" cy="96" rx="9" ry="10.4" fill="#fff9ee" />
        <ellipse cx="74" cy="96" rx="6.4" ry="9.1" fill="#4ea8c8" /><ellipse cx="107" cy="96" rx="6.4" ry="9.1" fill="#4ea8c8" />
        <ellipse cx="74.5" cy="100.5" rx="4.7" ry="3.2" fill="#d1fcff" stroke="none" /><ellipse cx="107.5" cy="100.5" rx="4.7" ry="3.2" fill="#d1fcff" stroke="none" />
        <ellipse cx="74" cy="95" rx="3.5" ry="5.3" fill="#334f69" /><ellipse cx="107" cy="95" rx="3.5" ry="5.3" fill="#334f69" />
        <path d="M65 91l-3-3m53 3 3-3M67 87q7-4 14 0m19 0q7-4 14 0" fill="none" stroke-width="2.5" />
        <circle cx="71.5" cy="92" r="2.5" fill="#fff9ee" stroke="none" /><circle cx="104.5" cy="92" r="2.5" fill="#fff9ee" stroke="none" />
      </g>
      <ellipse cx="63" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" /><ellipse cx="118" cy="106" rx="6" ry="3" fill="#f3a8ad" opacity=".7" />
      <path d="M86 106q4.5 4 9 0" stroke="#8f5260" stroke-width="2" />
      <path d="m127 79 14 7 2 16-11 10-9-6 1-17Z" fill="#394c64" stroke="#334f69" stroke-width="2" />
      <path d="m134 88 5 5-2 9-7 3-3-7 3-8Z" fill="#65bdd9" stroke="#334f69" stroke-width="1.5" />
      <path d="m134 92-2 9m-7-7h-6" stroke="#d1fcff" stroke-width="2.3" />
      <path d="M97 84h16l7 6v11l-7 6H97l-5-6V90Z" fill="#89dcf8" fill-opacity=".2" stroke="#4ea8c8" stroke-width="2.2" />
      <path d="M98 84h10m6 18 4-5" stroke="#d1fcff" stroke-width="2" />
    </g>
    <g v-else class="breathe" stroke="#51435a" stroke-width="3" stroke-linecap="round">
      <!-- Neutral human heroine silhouette for a missing character pack. -->
      <path d="M46 85c0-32 18-52 44-52s44 20 44 52c0 29 8 44 9 73l-20 5-13-15H70l-13 15-20-5c1-29 9-44 9-73Z" fill="#a497b8" />
      <path d="M69 151v16l-9 5h23l3-18m10 0 2 18h23l-9-5v-16" fill="#796a8e" />
      <path d="M66 116h48l14 42H52l14-42Z" fill="#bfb3cc" />
      <path d="M59 130q-18-2-16 12l9 5 9-8m60-9q18-2 16 12l-9 5-9-8" fill="#d7cce0" />
      <ellipse cx="90" cy="87" rx="37" ry="34" fill="#d7cce0" />
      <path d="M50 79c0-30 18-41 43-41 23 0 38 17 38 39-14-6-27-11-33-23-7 13-22 20-48 25Z" fill="#a497b8" />
      <path d="M68 89q5-4 10 0m24 0q5-4 10 0m-26 12q4 3 8 0" fill="none" stroke-width="2" />
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
