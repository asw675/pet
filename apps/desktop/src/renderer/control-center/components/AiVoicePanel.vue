<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { VoiceChatStartResult, VoiceScope, VoiceSessionBridgePort } from '../../../shared/voice-ipc';
import type { AiProjection } from '../useAiProjection';
import { useVoiceSession } from '../../voice/useVoiceSession';
const props = defineProps<{ context: AiProjection; disabled: boolean; cloud: boolean }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const ctx = props.context, host = ctx.bridge!;
const scope = computed<VoiceScope | null>(() => ctx.generation.value !== null && ctx.pet.value && ctx.conversationId.value
  ? { petId: ctx.petId.value, conversationId: ctx.conversationId.value } : null);
const bridge: VoiceSessionBridgePort = {
  voiceRequest: request => host.voiceRequest(request), requestMic: job => host.requestMic(job), revokeMic: grant => host.revokeMic(grant),
  startChat: async intent => {
    const identity = { petId: intent.petId, conversationId: intent.conversationId, requestId: intent.requestId };
    const accepted = await ctx.startChat(intent.userText, identity);
    const response: VoiceChatStartResult = accepted ? { ...identity, accepted: true } :
      { accepted: false, reason: 'AUTHORITY_REJECTED', error: { code: 'UNAVAILABLE', message: '未确认开始语音对话。', retryable: true } };
    return response;
  },
  cancelChat: (identity, reason) => host.cancelVoiceChat(identity, reason),
  subscribeChat: listener => host.subscribeChatEvents(listener),
  publishMouth: event => host.publishMouth(event), subscribeSuspend: listener => host.subscribeSuspend(listener),
};
const voice = useVoiceSession({ bridge, scope });
const { state, status, statusLoading, statusError, canStart, refreshStatus, beginPtt, stopPtt, cancel, setMuted } = voice;
const approved = ref(false), authorizing = ref(false), approvalError = ref('');
const recording = computed(() => state.value.phase === 'RECORDING');
const busy = computed(() => state.value.job !== null);
watch(busy, value => emit('busy', value), { immediate: true, flush: 'sync' });
onBeforeUnmount(() => emit('busy', false));
watch(ctx.generation, () => { approved.value = false; authorizing.value = false; approvalError.value = ''; cancel('REPLACED'); }, { flush: 'sync' });
const canPress = computed(() => !props.disabled && !ctx.chatting.value && approved.value && canStart.value && !busy.value);
const phaseLabel: Record<string,string> = {
  IDLE: '准备就绪', RECORDING: '正在录音（松开停止）', TRANSCRIBING: '本机语音识别中', CHAT_WAIT: '等待真实 AI 回复',
  TTS_PENDING: '准备语音播放', PLAYING: '正在播放', ERROR: '语音流程未完成', CANCELLED: '已取消',
};
async function authorize() {
  if (authorizing.value || !scope.value || busy.value) return;
  const current = ctx.token();
  authorizing.value = true; approvalError.value = '';
  try {
    const result = await host.authorizeMicrophone();
    if (ctx.isCurrent(current)) { approved.value = result.ok; if (!result.ok) approvalError.value = '麦克风未授权。'; }
  } catch { if (ctx.isCurrent(current)) approvalError.value = '未能确认麦克风权限。'; }
  finally { if (ctx.generation.value === current?.generation) authorizing.value = false; }
}
function press(event: PointerEvent) {
  if (event.button !== 0 || !canPress.value || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  if (beginPtt(event)) { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel('FOCUS_LOST'); } }
}
function release(event: PointerEvent) {
  if (!recording.value) return;
  stopPtt();
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
}
function pressKey(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault(); if (!event.repeat && canPress.value) beginPtt(event);
}
function releaseKey(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault(); if (recording.value) stopPtt();
}
</script>
<template>
  <section class="ai-box voice-panel">
    <header class="ai-heading"><div><strong>按住说话 · 本机语音</strong><p class="small muted">松开即结束捕获，将本机识别文字作为主动对话提交；不后台监听或上传录音。</p></div><button type="button" class="button button-secondary" :disabled="statusLoading || busy" @click="refreshStatus()">检测本机语音</button></header>
    <p v-if="cloud" class="ai-warning">当前角色已绑定远程模型：音频仍在本机处理，但识别后的文字及授权上下文会发送该 HTTPS 服务。</p>
    <p v-if="statusLoading" class="small muted" role="status">正在检测实际本机语音模型…</p>
    <template v-else-if="status">
      <p class="small muted">听写：{{ status.stt.providerId }} · {{ status.stt.health }} · {{ status.stt.requiresNetwork ? '需要网络' : '本地' }}；播报：{{ status.tts ? `${status.tts.providerId} · ${status.tts.health}` : '未配置，保留文字' }}</p>
      <p v-if="!status.canBegin" class="ai-warning">当前本机语音模型未就绪，语音输入不可用。未安装或资源校验不通过时不会生成虚假听写或改用云端。</p>
    </template>
    <p v-else-if="statusError" class="ai-warning" role="alert">本地语音状态未确认。{{ statusError }}</p>
    <div class="ai-actions">
      <button v-if="!approved" type="button" class="button button-secondary" :disabled="authorizing || busy || !scope" @click="authorize">{{ authorizing ? '确认权限中…' : '独立授权麦克风' }}</button>
      <button type="button" class="button button-primary ptt-button" :disabled="!recording && !canPress"
        @pointerdown="press" @pointerup="release" @pointercancel="cancel('DEVICE_LOST')"
        @lostpointercapture="recording && cancel('FOCUS_LOST')" @keydown="pressKey" @keyup="releaseKey" @blur="recording && cancel('FOCUS_LOST')">{{ recording ? '松开结束录音' : '按住说话（空格也可）' }}</button>
      <button type="button" class="button button-secondary" :disabled="!busy" @click="cancel('USER')">停止语音流程</button>
      <button type="button" class="button button-secondary" @click="setMuted(!state.muted)">{{ state.muted ? '解除本次静音' : '本次播放静音' }}</button>
    </div>
    <p v-if="approvalError" class="ai-warning">{{ approvalError }}</p>
    <p role="status" class="small muted">语音流程：{{ phaseLabel[state.phase] ?? state.phase }}<template v-if="state.error"> · {{ state.error }}</template></p>
    <p v-if="state.transcript" class="ai-plain small">识别文字（提交后可在真实对话档案查看）：{{ state.transcript }}</p>
  </section>
</template>
<style scoped>.ptt-button { touch-action: none; user-select: none; }</style>
