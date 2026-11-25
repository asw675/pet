<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { voiceSettingsResultMatchesRequest, voiceSettingsResultSchema } from '../../../shared/voice-settings-ipc';
import type { InstalledVoiceOption, VoiceSettingsRequest, VoiceSettingsResult, VoiceSettingsProfile, VoiceSettingsErrorCode } from '../../../shared/voice-settings-ipc';
import { voiceDraftConfig, toVoiceProfileDraft } from '../../shared/voice-settings-policy';
import type { VoiceProfileDraft } from '../../shared/voice-settings-policy';
import type { AiProjection } from '../useAiProjection';
import { useAiConfirmation } from '../useAiConfirmation';
import AiConfirmDialog from './AiConfirmDialog.vue';
const props = defineProps<{ context: AiProjection }>();
const ctx = props.context, { pet, generation, epoch, bridge, chatting } = ctx;
const profile = shallowRef<VoiceSettingsProfile|null>(null);
const voices = shallowRef<readonly InstalledVoiceOption[]>([]);
const health = ref<'READY'|'UNCONFIGURED'|'UNAVAILABLE'|null>(null);
const draft = ref<VoiceProfileDraft|null>(null), pending = ref(false), feedback = ref(''), error = ref('');
const { quote, submitting, attempted, confirmable, error: confirmError, begin, close, commit, dialogError } = useAiConfirmation(ctx);
let sequence = 0, disposed = false;
const writable = computed(() => !!profile.value && !!draft.value && !pending.value && !chatting.value && !submitting.value);
const currentMissing = computed(() => !!draft.value?.voiceId && !voices.value.some(option => option.ref.voiceId === draft.value?.voiceId));
const errors: Record<VoiceSettingsErrorCode,string> = {
  INVALID_REQUEST:'配置格式无效。',NOT_FOUND:'当前角色或设置不存在。',REVISION_CONFLICT:'配置版本已变化，请刷新。',
  VOICE_NOT_ENUMERATED:'所选声音不在实际系统声音列表中。',CONSENT_REQUIRED:'缺少所需授权。', UNSUPPORTED:'当前阶段仅支持本机听写与本机系统播报。',
  UNAVAILABLE:'本机语音服务不可用。',BUSY:'语音流程正在占用服务，请先结束。',TIMEOUT:'本机语音检测超时。',
};
async function invoke(request: VoiceSettingsRequest): Promise<VoiceSettingsResult|null> {
  if (!bridge) return null;
  try {
    const parsed = voiceSettingsResultSchema.safeParse(await bridge.voiceSettingsRequest(request));
    return parsed.success && voiceSettingsResultMatchesRequest(request,parsed.data) ? parsed.data : null;
  } catch { return null; }
}
function problem(result: VoiceSettingsResult|null) { return result && !result.ok ? errors[result.code] : '语音设置结果尚未确认，请重新读取。'; }
function adopt(value: VoiceSettingsProfile) { profile.value = value; draft.value = toVoiceProfileDraft(value.config); }
async function refresh() {
  const scope = ctx.token(), own = ++sequence;
  if (!scope) return;
  pending.value = true; profile.value = null; draft.value = null; voices.value = []; health.value = null; error.value = ''; feedback.value = '';
  try {
    const [settings, installed] = await Promise.all([invoke({kind:'get',petId:scope.petId}), invoke({kind:'listVoices',petId:scope.petId})]);
    if (disposed || sequence !== own || !ctx.isCurrent(scope)) return;
    if (settings?.ok && settings.kind === 'profile') adopt(settings.profile); else error.value = problem(settings);
    if (installed?.ok && installed.kind === 'voices') { voices.value = installed.voices; health.value = installed.health; }
    else { health.value = 'UNAVAILABLE'; feedback.value = problem(installed); }
  } finally { if (!disposed && sequence === own && ctx.isCurrent(scope)) pending.value = false; }
}
function invalidate() { sequence++; profile.value = null; draft.value = null; voices.value = []; health.value = null; pending.value = false; error.value = ''; feedback.value = ''; }
watch([generation,epoch], invalidate, {flush:'sync'});
watch([generation,epoch], () => { void refresh(); }, {immediate:true});
onBeforeUnmount(() => { disposed = true; invalidate(); });
function beginSave(reset = false) {
  const current=profile.value, value=draft.value, scope=ctx.token(), own=sequence;
  if (!scope || !current || !value || !writable.value) return;
  const config=reset ? undefined : voiceDraftConfig(value,voices.value);
  if (!reset && !config) { error.value = '设置不符合本机语音规则，或所选声音未安装。'; return; }
  const signature=JSON.stringify(value), selectedName=voices.value.find(option=>option.ref.voiceId===value.voiceId)?.displayName;
  const request:VoiceSettingsRequest=reset ? {kind:'reset',petId:scope.petId,expectedRevision:current.revision}
    : {kind:'save',petId:scope.petId,expectedRevision:current.revision,config:config!};
  begin({title:reset?'还原角色语音默认值':'保存角色本机语音设置',
    detail:[`伙伴：${pet.value?.nickname}（${scope.petId}） · 修订 ${current.revision}`, ...(reset ? ['默认本机多语种 Base 模型；系统播报关闭；取消静音、音量恢复默认。']
      : [`本机听写：${value.modelId} · ${value.locale || '自动语言'}`,`播报：${selectedName ?? '关闭'}`,`音量：${Math.round(value.volume*100)}% · ${value.muted?'静音':'非静音'}`,`最长录音：${value.maxRecordingMs/1000} 秒`])],
    warning:'保存只改变当前角色的本地语音配置，不授权麦克风、不发送录音或安装声音。模型/声音仍须实际可用；不可用时保留文字对话，不伪造语音。',
    confirmLabel:reset?'确认还原':'确认保存',
    current:()=>ctx.isCurrent(scope)&&!pending.value&&!chatting.value&&sequence===own&&profile.value===current
      && JSON.stringify(draft.value)===signature && (reset||!!draft.value&&!!voiceDraftConfig(draft.value,voices.value)),
    perform:async()=>{
      const result=await invoke(request);
      if(!ctx.isCurrent(scope)||disposed)return false;
      if(!result?.ok||result.kind!=='profile'){error.value=problem(result);return false;}
      adopt(result.profile); feedback.value='语音设置已由本地服务保存；下次语音检测会读取最新修订。';error.value='';return true;
    },
  });
}
</script>
<template>
  <section class="panel ai-section">
    <header class="ai-heading"><div><span class="eyebrow">Local voice profile</span><h3>{{ pet?.nickname }} 的本机语音设置</h3></div><button type="button" class="button button-secondary" :disabled="pending || submitting" @click="refresh">重新读取/枚举</button></header>
    <p class="small muted">选择本地听写模型与实际安装的 Windows 系统声音。云端语音未开放；没有模型或系统声音时，文字聊天仍可使用。</p>
    <p v-if="error || feedback" class="ai-note" role="status">{{ error || feedback }}</p>
    <p v-if="pending" class="small muted">正在读取角色配置和系统声音…</p>
    <form v-if="profile && draft" class="provider-form ai-box" @submit.prevent="beginSave()">
      <p class="small muted">语音配置修订 {{ profile.revision }}</p>
      <label>听写模型<select v-model="draft.modelId"><option value="MULTILINGUAL_BASE">多语种 Base（本机模型）</option><option value="MULTILINGUAL_SMALL">多语种 Small（本机模型）</option></select></label>
      <p class="small muted">模型选项是支持的固定配置 ID，不代表已安装。进入会话后可检测本机实际就绪情况。</p>
      <label>听写语言标签（留空自动）<input v-model="draft.locale" maxlength="48" placeholder="例如 zh-CN" /></label>
      <label>系统播报<select v-model="draft.voiceId">
        <option value="">关闭播报（只保留文字）</option>
        <option v-if="currentMissing" :value="draft.voiceId" disabled>原配置声音未被枚举，请关闭或改选</option>
        <option v-for="option in voices" :key="option.ref.voiceId" :value="option.ref.voiceId">{{ option.displayName }} · {{ option.ref.locale }}</option>
      </select></label>
      <p v-if="health !== 'READY'" class="small muted">系统声音：{{ health ?? '尚未确认' }}。未发现可选声音时不会列出虚拟示例。</p>
      <label v-if="draft.voiceId">播报速率（0.5–2.0）<input v-model.number="draft.rate" type="number" min=".5" max="2" step=".1" required /></label>
      <label class="checkline"><input v-model="draft.muted" type="checkbox" /> 持久静音（仅当前角色）</label>
      <label>音量 {{ Math.round(draft.volume * 100) }}%<input v-model.number="draft.volume" type="range" min="0" max="1" step=".05" /></label>
      <label>最长按住录音（毫秒）<input v-model.number="draft.maxRecordingMs" type="number" min="100" max="30000" step="100" required /></label>
      <div class="ai-actions"><button type="button" class="button button-secondary" :disabled="!writable" @click="beginSave(true)">还原默认</button><button type="submit" class="button button-primary" :disabled="!writable || currentMissing">核对并保存</button></div>
    </form>
    <AiConfirmDialog :quote="quote" :submitting="submitting" :attempted="attempted" :confirmable="confirmable" :error="confirmError" @confirm="commit" @cancel="close()" @modal-error="dialogError" />
  </section>
</template>
