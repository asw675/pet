<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { credentialSaveSchema } from '../../../shared/ai-ipc';
import type { AiIntent, ProviderRecordView } from '../../../shared/ai-ipc';
import { aiNextOffset, draftProviderConfig, privacyLabel, providerAssignmentIntent } from '../../shared/ai-view-policy';
import type { ProviderDraft } from '../../shared/ai-view-policy';
import { useAiConfirmation } from '../useAiConfirmation';
import { useAiQuery } from '../useAiProjection';
import type { AiProjection } from '../useAiProjection';
import AiConfirmDialog from './AiConfirmDialog.vue';
const props = defineProps<{ context: AiProjection }>();
const ctx = props.context, { pet, petId, generation, epoch, bridge, chatting } = ctx;
const offset = ref(0), limit = 12;
const query = computed<Extract<AiIntent, { method: 'settings/list' }> | undefined>(() =>
  generation.value === null ? undefined : { method: 'settings/list', payload: { offset: offset.value, limit } });
const settings = useAiQuery(ctx, 'settings/list', query);
const { data, pending, error, version, refresh } = settings;
const confirmation = useAiConfirmation(ctx);
const { quote, submitting, attempted, confirmable, error: confirmError, begin, close, commit, dialogError } = confirmation;
const draft = ref<ProviderDraft | null>(null), original = shallowRef<ProviderRecordView | null>(null);
const credentialTargetId = ref(''), keyInput = ref<HTMLInputElement | null>(null), keyBusy = ref(false), feedback = ref('');
const assignment = computed(() => data.value?.assignments.find(item => item.petId === petId.value));
const credentialTarget = computed(() => data.value?.providers.find(item => item.config.providerId === credentialTargetId.value && !!item.config.credentialRef));
const writable = computed(() => !!data.value && !pending.value && !chatting.value && !keyBusy.value && !submitting.value);
const supported = (row: ProviderRecordView) => row.config.endpointKind === 'MOCK' || row.config.endpointKind === 'OPENAI_COMPATIBLE';
function clearSecret() { if (keyInput.value) keyInput.value.value = ''; }
function reset() { clearSecret(); draft.value = null; original.value = null; credentialTargetId.value = ''; feedback.value = ''; keyBusy.value = false; }
watch([generation, epoch], reset, { flush: 'sync' });
watch(() => credentialTarget.value?.config.credentialRef, clearSecret, { flush: 'sync' });
onBeforeUnmount(clearSecret);
function changePage(direction: -1|1) {
  if (!data.value) return;
  const next = aiNextOffset(offset.value, limit, data.value.providers.length, direction);
  if (next !== undefined) { reset(); offset.value = next; }
}
function add() {
  if (!writable.value) return;
  original.value = null; feedback.value = ''; clearSecret();
  draft.value = { providerId: `provider-${globalThis.crypto.randomUUID()}`, profile: 'MOCK', baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'mock-desktop', useCredential: false, jsonMode: false, streamText: true, maxContextTokens: 8192, maxOutputTokens: 1024, timeoutMs: 60_000 };
}
function edit(row: ProviderRecordView) {
  if (!writable.value || !supported(row)) return;
  original.value = row; clearSecret(); feedback.value = '';
  const c = row.config;
  draft.value = { providerId: c.providerId, profile: c.privacyBoundary, baseUrl: c.baseUrl ?? '', modelId: c.modelId,
    useCredential: c.credentialRef !== null, jsonMode: c.capabilities.jsonMode, streamText: c.capabilities.streamText,
    maxContextTokens: c.maxContextTokens, maxOutputTokens: c.maxOutputTokens, timeoutMs: c.timeoutMs };
}
function profileChanged() {
  if (!draft.value) return;
  if (draft.value.profile === 'MOCK') { draft.value.modelId = 'mock-desktop'; draft.value.useCredential = false; draft.value.jsonMode = false; }
  else if (draft.value.profile === 'CLOUD') { draft.value.baseUrl = ''; draft.value.modelId = ''; draft.value.useCredential = true; }
  else { draft.value.baseUrl = 'http://127.0.0.1:11434/v1'; draft.value.modelId = ''; draft.value.useCredential = false; }
}
function readGuard(extra: () => boolean = () => true) {
  const scope = ctx.token(), v = version.value;
  return () => ctx.isCurrent(scope) && version.value === v && !!data.value && !pending.value && !chatting.value && extra();
}
function exactProvider(row: ProviderRecordView): boolean {
  return data.value?.providers.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)) === true;
}
function beginSave() {
  const value = draft.value, existing = original.value;
  if (!value || !writable.value || (existing && !exactProvider(existing))) return;
  const config = draftProviderConfig(value, existing, () => `credential:${globalThis.crypto.randomUUID()}`);
  if (!config) { feedback.value = '配置无效：请核对模型 ID、预算及回环 HTTP(S) / 远程 HTTPS 地址格式。'; return; }
  const fingerprint = JSON.stringify(value), scope = ctx.token();
  const valid = readGuard(() => JSON.stringify(draft.value) === fingerprint && (!existing || exactProvider(existing)));
  begin({
    title: existing ? '修改 AI 服务配置' : '保存 AI 服务配置',
    detail: [`配置：${config.providerId}`, privacyLabel[config.privacyBoundary], `地址：${config.baseUrl ?? '无网络端点'}`, `模型：${config.modelId}`,
      `凭据：${config.credentialRef ? '需要独立录入密钥' : '不使用'}`],
    warning: '仅保存本地配置，不发送对话。修改已绑定配置会使旧版本授权失效；变更地址时不会复用旧地址的凭据。请重新核对并绑定伙伴。',
    confirmLabel: '保存配置', current: valid,
    perform: async () => {
      const result = await ctx.invoke({ method: 'provider/save', payload: { config, expectedRevision: existing?.revision ?? null } });
      if (!ctx.isCurrent(scope)) return false;
      if (!result?.ok) { feedback.value = ctx.problem(result); return false; }
      draft.value = null; original.value = null; feedback.value = '配置已由本地服务保存。若需要密钥，请在已保存配置下单独录入。'; return true;
    },
  });
}
function beginAssign(row: ProviderRecordView) {
  const owner = pet.value, cloud = row.config.privacyBoundary === 'CLOUD';
  if (!owner || !writable.value || !supported(row) || !exactProvider(row)) return;
  const intent = providerAssignmentIntent(owner.petId, row, cloud);
  if (!intent) return;
  const scope = ctx.token();
  begin({ title: cloud ? '授权远程模型处理此伙伴的对话' : '为伙伴绑定 AI 服务',
    detail: [`伙伴：${owner.nickname}（${owner.petId}）`, `配置：${row.config.providerId} · v${row.revision}`, `模型：${row.config.modelId}`, `地址：${row.config.baseUrl ?? '本地模拟，无端点'}`],
    warning: cloud ? '同意后，主动发送对话时，用户输入、角色资料、该角色近期对话、已授权记忆及必要游戏状态会发送给该 HTTPS 服务。对方可能处理或保存内容。这不是允许后台主动发送；你可以随时解除绑定。'
      : row.config.privacyBoundary === 'MOCK' ? '这是确定性的本地模拟，不代表真实模型服务；不会联网。' : '仅使用显式本机回环地址。请自行确认本机模型服务的网络和数据政策。',
    confirmLabel: cloud ? '明确同意远程上下文并绑定' : '确认绑定', current: readGuard(() => exactProvider(row)),
    perform: async () => {
      const result = await ctx.invoke(intent);
      if (!ctx.isCurrent(scope)) return false;
      if (!result?.ok) { feedback.value = ctx.problem(result); return false; }
      feedback.value = '角色绑定已由服务确认。'; return true;
    },
  });
}
function beginClearAssignment() {
  const owner = pet.value, assigned = assignment.value, scope = ctx.token();
  if (!owner || !assigned || !writable.value) return;
  const fingerprint = JSON.stringify(assigned);
  begin({ title: '解除角色 AI 绑定', detail: [`${owner.nickname} · ${owner.petId}`, `配置 ${assigned.providerId} · v${assigned.providerRevision}`],
    warning: '解除此角色的 AI 服务和远程上下文授权，不删除历史对话或已单独确认的记忆。',
    confirmLabel: '解除绑定', current: readGuard(() => JSON.stringify(assignment.value) === fingerprint),
    perform: async () => {
      const result = await ctx.invoke({ method: 'provider/clear', payload: { petId: owner.petId } });
      if (!ctx.isCurrent(scope) || !result?.ok || result.method !== 'provider/clear' || !result.data.changed) return false;
      feedback.value = '已解除绑定。'; return true;
    },
  });
}
async function saveKey() {
  const row = credentialTarget.value, scope = ctx.token();
  if (!row?.config.credentialRef || !scope || !writable.value || !bridge || !keyInput.value) return;
  // Keep the secret outside all reactive state/quotes, erase the DOM field
  // before any await. Main-only credential ingress is distinct from AI RPC.
  const parsed = credentialSaveSchema.safeParse({ providerId: row.config.providerId, credentialRef: row.config.credentialRef, secret: keyInput.value.value });
  clearSecret();
  if (!parsed.success) { feedback.value = '密钥格式无效或为空，未提交。'; return; }
  keyBusy.value = true; feedback.value = '';
  try {
    const result = await bridge.saveProviderCredential(parsed.data);
    if (ctx.isCurrent(scope)) feedback.value = result.ok ? '密钥已由本地安全存储确认保存。' : '密钥未确认保存，请检查本地安全存储。';
  } catch { if (ctx.isCurrent(scope)) feedback.value = '密钥未确认保存，请检查本地安全存储。'; }
  finally { if (ctx.isCurrent(scope)) keyBusy.value = false; parsed.data.secret = ''; }
}
function revokeKey() {
  const row = credentialTarget.value, scope = ctx.token(), host = bridge;
  const credentialRef = row?.config.credentialRef;
  if (!row || !credentialRef || !host || !writable.value) return;
  clearSecret();
  begin({ title: '撤销本地保存的密钥', detail: [`配置：${row.config.providerId}`, `端点：${row.config.baseUrl ?? '无'}`],
    warning: '撤销本地安全存储中的该密钥。引用配置和历史记录不会删除；之后需要重新录入有效密钥。',
    confirmLabel: '撤销密钥', current: readGuard(() => exactProvider(row) && credentialTargetId.value === row.config.providerId),
    perform: async () => {
      const result = await host.revokeProviderCredential({ providerId: row.config.providerId, credentialRef });
      if (!ctx.isCurrent(scope) || !result.ok) return false;
      feedback.value = '密钥已由本地安全存储确认撤销。'; return true;
    },
  });
}
</script>
<template>
  <section class="panel ai-section">
    <header class="ai-heading"><div><span class="eyebrow">Provider & consent</span><h3>AI 服务和数据使用授权</h3></div>
      <button class="button button-secondary" :disabled="pending || keyBusy" type="button" @click="refresh">刷新配置</button></header>
    <p class="small muted">服务配置与角色绑定各自独立。保存地址或密钥不会自动发送任何信息；只有主动发送对话时才可能联系已明确绑定的服务。</p>
    <div v-if="data" class="ai-box">
      <strong>{{ pet?.nickname }} 的当前绑定</strong>
      <p v-if="assignment">{{ assignment.providerId }} · v{{ assignment.providerRevision }} · {{ assignment.cloudConsent ? '已确认远程上下文授权' : '非远程授权' }}</p>
      <p v-else class="muted">没有有效绑定。请选择下方明确配置的服务。</p>
      <button v-if="assignment" type="button" class="button button-secondary" :disabled="!writable" @click="beginClearAssignment">解除角色绑定</button>
    </div>
    <p v-if="error" class="ai-warning" role="alert">{{ error }}</p><p v-else-if="!data" class="small muted">{{ pending ? '正在读取真实服务配置…' : '等待本地服务配置。' }}</p>
    <template v-if="data">
      <div class="ai-heading"><h4>已保存配置</h4><button class="button button-primary" type="button" :disabled="!writable" @click="add">新建配置</button></div>
      <article v-for="row in data.providers" :key="row.config.providerId" class="ai-box provider-row">
        <div><strong>{{ row.config.providerId }}</strong><p class="small muted">{{ privacyLabel[row.config.privacyBoundary] }} · {{ row.config.endpointKind }} · v{{ row.revision }}</p>
          <p class="small">{{ row.config.baseUrl ?? '无网络端点' }} · {{ row.config.modelId }}</p><p class="small muted">{{ row.config.credentialRef ? '配置需要密钥（不显示明文）' : '配置不要求密钥' }}</p></div>
        <div class="ai-actions"><button type="button" class="button button-secondary" :disabled="!writable || !supported(row)" @click="edit(row)">编辑</button>
          <button v-if="row.config.credentialRef" type="button" class="button button-secondary" :disabled="!writable" @click="credentialTargetId = row.config.providerId">密钥</button>
          <button type="button" class="button button-primary" :disabled="!writable || !supported(row)" @click="beginAssign(row)">绑定当前角色</button></div>
      </article>
      <p v-if="!data.providers.length" class="small muted">没有该页服务配置。需要先新建一个配置。</p>
      <div class="ai-pagination"><button type="button" class="button button-secondary" :disabled="offset === 0 || pending" @click="changePage(-1)">上一页</button><span>第 {{ Math.floor(offset / limit) + 1 }} 页</span><button type="button" class="button button-secondary" :disabled="aiNextOffset(offset, limit, data.providers.length, 1) === undefined || pending" @click="changePage(1)">下一页</button></div>
    </template>
    <form v-if="draft" class="ai-box provider-form" @submit.prevent="beginSave">
      <h4>{{ original ? '编辑服务配置' : '新的服务配置' }}</h4>
      <label>配置 ID<input v-model="draft.providerId" :readonly="!!original" maxlength="128" required /></label>
      <label>服务边界<select v-model="draft.profile" @change="profileChanged"><option value="MOCK">本地模拟 MOCK（无网络）</option><option value="LOCAL">OpenAI 兼容 · 本机回环</option><option value="CLOUD">OpenAI 兼容 · 远程 HTTPS</option></select></label>
      <label v-if="draft.profile !== 'MOCK'">Base URL（不含聊天路径或密钥）<input v-model="draft.baseUrl" maxlength="512" placeholder="https://服务域名/v1" required /></label>
      <label>模型 ID<input v-model="draft.modelId" required maxlength="128" /></label>
      <label v-if="draft.profile === 'LOCAL'" class="checkline"><input v-model="draft.useCredential" type="checkbox" /> 本机服务需要独立录入密钥</label>
      <label v-if="draft.profile !== 'MOCK'" class="checkline"><input v-model="draft.jsonMode" type="checkbox" /> 服务明确支持 JSON 模式（用于结构化建议；否则仅文本）</label>
      <label class="checkline"><input v-model="draft.streamText" type="checkbox" /> 支持文本流式输出</label>
      <div class="provider-budget"><label>上下文 Token<input v-model.number="draft.maxContextTokens" type="number" min="512" max="1000000" step="1" required /></label>
        <label>输出 Token<input v-model.number="draft.maxOutputTokens" type="number" min="1" max="32768" step="1" required /></label>
        <label>超时（毫秒）<input v-model.number="draft.timeoutMs" type="number" min="1000" max="300000" step="1" required /></label></div>
      <div class="ai-actions"><button type="button" class="button button-secondary" @click="draft = null; original = null">关闭</button><button type="submit" class="button button-primary" :disabled="!writable">核对并保存</button></div>
    </form>
    <form v-if="credentialTarget" class="ai-box provider-form" autocomplete="off" @submit.prevent="saveKey">
      <h4>安全存储：{{ credentialTarget.config.providerId }}</h4><p class="small muted">仅传递给宿主专用安全存储入口；不读回、不显示、不作为聊天内容。在修改地址后录入新地址使用的密钥。</p>
      <label>API 密钥<input ref="keyInput" type="password" autocomplete="new-password" spellcheck="false" maxlength="8192" minlength="1" required /></label>
      <div class="ai-actions"><button class="button button-secondary" type="button" :disabled="keyBusy" @click="clearSecret(); credentialTargetId = ''">关闭</button><button class="button button-secondary" type="button" :disabled="!writable" @click="revokeKey">撤销已存密钥</button><button class="button button-primary" type="submit" :disabled="!writable">存入本地安全存储</button></div>
    </form>
    <p v-if="feedback || confirmError" class="ai-note" role="status">{{ confirmError ?? feedback }}</p>
    <AiConfirmDialog :quote="quote" :submitting="submitting" :attempted="attempted" :confirmable="confirmable" :error="confirmError" @confirm="commit" @cancel="close()" @modal-error="dialogError" />
  </section>
</template>
