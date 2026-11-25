<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { ChatMessage, Conversation } from '@pet-desktop/contracts/ai';
import { aiLimits } from '@pet-desktop/contracts/ai';
import type { AiIntent } from '../../../shared/ai-ipc';
import { aiNextOffset, privacyLabel } from '../../shared/ai-view-policy';
import { formatTime } from '../../shared/presentation';
import { useAiProjection, useAiQuery } from '../useAiProjection';
import { useAiConfirmation } from '../useAiConfirmation';
import AiConfirmDialog from '../components/AiConfirmDialog.vue';
import AiProviderPanel from '../components/AiProviderPanel.vue';
import AiMemoryPanel from '../components/AiMemoryPanel.vue';
import AiProposalPanel from '../components/AiProposalPanel.vue';
import AiVoicePanel from '../components/AiVoicePanel.vue';
import AiVoiceSettingsPanel from '../components/AiVoiceSettingsPanel.vue';
import Icon from '../components/Icon.vue';
const ctx = useAiProjection();
const { bridge, generation, epoch, pets, pet, petId, conversationId, chatting, active, chatError, chatNotice, cancelPending, cancelChat } = ctx;
const tab = ref<'CHAT'|'SETTINGS'|'MEMORY'|'SUGGESTIONS'>('CHAT');
const convOffset = ref(0), messageOffset = ref(0), convLimit = 12, messageLimit = 20;
const title = ref(''), userText = ref(''), feedback = ref(''), creating = ref(false), voiceBusy = ref(false);
const convQuery = computed<Extract<AiIntent, { method: 'conversations/list' }> | undefined>(() =>
  generation.value !== null && pet.value ? { method: 'conversations/list', payload: { petId: petId.value, offset: convOffset.value, limit: convLimit } } : undefined);
const historyQuery = computed<Extract<AiIntent, { method: 'messages/list' }> | undefined>(() =>
  generation.value !== null && pet.value && conversationId.value ? { method: 'messages/list', payload: {
    petId: petId.value, conversationId: conversationId.value, offset: messageOffset.value, limit: messageLimit,
  } } : undefined);
const providerQuery = computed<Extract<AiIntent, { method: 'settings/list' }> | undefined>(() =>
  generation.value !== null && pet.value ? { method: 'settings/list', payload: { offset: 0, limit: 50 } } : undefined);
const conversations = useAiQuery(ctx, 'conversations/list', convQuery);
const messages = useAiQuery(ctx, 'messages/list', historyQuery);
const providers = useAiQuery(ctx, 'settings/list', providerQuery);
const { data: conversationPage, pending: convPending, error: convError, refresh: refreshConversations } = conversations;
const { data: messagePage, pending: messagesPending, error: messagesError, refresh: refreshMessages } = messages;
watch(messagePage, next => { if (next) ctx.reconcileHistory(next.rows); });
const { data: providerPage, pending: providerPending, error: providerError } = providers;
const assignment = computed(() => providerPage.value?.assignments.find(row => row.petId === petId.value));
const assignedProvider = computed(() => providerPage.value?.providers.find(row => row.config.providerId === assignment.value?.providerId && row.revision === assignment.value?.providerRevision));
const selectedConversation = shallowRef<Conversation | null>(null);
const selectedTitle = computed(() => conversationPage.value?.rows.find(c => c.conversationId === conversationId.value)?.title
  ?? selectedConversation.value?.title ?? conversationId.value);
const { quote, submitting, attempted, confirmable, error: confirmError, begin, close, commit, dialogError } = useAiConfirmation(ctx);
const editing = shallowRef<ChatMessage | null>(null), editedText = ref('');
const busy = computed(() => creating.value || chatting.value || submitting.value || voiceBusy.value);
const canSend = computed(() => !!pet.value && !!conversationId.value && !!assignment.value && !providerPending.value
  && !busy.value && !!userText.value.trim() && userText.value.length <= aiLimits.userText);
function resetEditor() { editing.value = null; editedText.value = ''; }
watch([generation, petId], () => {
  convOffset.value = 0; messageOffset.value = 0; selectedConversation.value = null;
  title.value = ''; userText.value = ''; feedback.value = ''; creating.value = false; resetEditor();
}, { flush: 'sync' });
watch(conversationId, () => { messageOffset.value = 0; userText.value = ''; resetEditor(); feedback.value = ''; }, { flush: 'sync' });
function chooseConversation(row: Conversation) {
  if (row.petId !== petId.value || !conversationPage.value?.rows.some(item => item.conversationId === row.conversationId)) return;
  ctx.selectConversation(row.conversationId); selectedConversation.value = row;
}
function conversationPageStep(direction: -1|1) {
  if (!conversationPage.value) return;
  const next = aiNextOffset(convOffset.value, convLimit, conversationPage.value.rows.length, direction);
  if (next !== undefined) convOffset.value = next;
}
function messagePageStep(direction: -1|1) {
  if (!messagePage.value) return;
  const next = aiNextOffset(messageOffset.value, messageLimit, messagePage.value.rows.length, direction);
  if (next !== undefined) { messageOffset.value = next; resetEditor(); }
}
async function createConversation() {
  const scope = ctx.token(), name = title.value.trim();
  if (!scope || busy.value || !name || name.length > 120) return;
  creating.value = true; feedback.value = '';
  const result = await ctx.invoke({ method: 'conversation/create', payload: { petId: scope.petId, title: name } });
  if (!ctx.isCurrent(scope)) return;
  creating.value = false;
  if (!result?.ok || result.method !== 'conversation/create') { feedback.value = ctx.problem(result); return; }
  title.value = ''; convOffset.value = 0; ctx.selectConversation(result.data.conversationId);
  selectedConversation.value = result.data; ctx.refreshAll();
}
async function send() {
  const scope = ctx.token(), text = userText.value.trim();
  if (!scope || !canSend.value) return;
  messageOffset.value = 0; resetEditor(); userText.value = '';
  // No optimistic history or automatic retry: a persisted user message is
  // loaded from messages/list, even when transport or provider fails.
  await ctx.startChat(text);
}
function exactMessage(row: ChatMessage) {
  return row.petId === petId.value && row.conversationId === conversationId.value
    && messagePage.value?.rows.some(item => JSON.stringify(item) === JSON.stringify(row)) === true;
}
function editMessage(row: ChatMessage) {
  if (busy.value || row.role !== 'USER' || !exactMessage(row)) return;
  editing.value = row; editedText.value = row.text;
}
function confirmMessage(row: ChatMessage, action: 'EDIT'|'DELETE') {
  const scope = ctx.token(), version = messages.version.value, text = editedText.value.trim();
  if (!scope || busy.value || row.status === 'PENDING' || !exactMessage(row)
    || (action === 'EDIT' && (row.role !== 'USER' || !text || text.length > aiLimits.userText || text === row.text))) return;
  const intent: AiIntent = action === 'EDIT' ? { method: 'message/edit', payload: {
    petId: row.petId, conversationId: row.conversationId, messageId: row.messageId, text,
  } } : { method: 'message/delete', payload: { petId: row.petId, conversationId: row.conversationId, messageId: row.messageId } };
  begin({ title: action === 'EDIT' ? '修改本地用户消息' : '删除本地对话消息',
    detail: [`伙伴：${pet.value?.nickname}（${row.petId}）`, `会话：${selectedTitle.value}`, row.text || '（此记录没有文字）',
      ...(action === 'EDIT' ? [`修改为：${text}`] : [])],
    warning: '只修改持久化对话记录，不撤回已经发送给模型的内容，也不会自动生成新回复。相关记忆请在记忆管理中核对。',
    confirmLabel: action === 'EDIT' ? '确认修改消息' : '确认删除消息',
    current: () => ctx.isCurrent(scope) && messages.version.value === version && !messagesPending.value && !chatting.value && !voiceBusy.value
      && exactMessage(row) && (action !== 'EDIT' || (editing.value?.messageId === row.messageId && editedText.value.trim() === text)),
    perform: async () => {
      const result = await ctx.invoke(intent);
      if (!ctx.isCurrent(scope) || !result?.ok || !('changed' in result.data) || !result.data.changed) return false;
      resetEditor(); feedback.value = '本地服务已确认修改消息。'; return true;
    },
  });
}
function chooseTab(value: typeof tab.value) { if (!voiceBusy.value && !submitting.value) tab.value = value; }
const messageStatus = { COMPLETED: '已保存', PENDING: '等待回复', CANCELLED: '已取消', FAILED: '失败' };
</script>
<template>
  <div class="chat-center">
    <div class="page-intro panel"><span class="panel-symbol accent-blue"><Icon name="chat" /></span><div><span class="eyebrow">Companion conversations</span><h2>对话中心</h2><p>独立角色会话、显式 AI 服务授权，以及你亲自管理的记忆。</p></div></div>
    <div v-if="generation === null || !bridge" class="panel empty-state"><Icon name="chat" /><h2>等待本地 AI 服务</h2><p>没有真实服务连接时，不生成模拟对话或临时记忆。</p></div>
    <template v-else>
      <div class="panel ai-toolbar">
        <label>当前角色<select :value="petId" :disabled="creating || submitting" @change="ctx.selectPet(($event.target as HTMLSelectElement).value)"><option v-for="row in pets" :key="row.petId" :value="row.petId">{{ row.nickname }}（{{ row.petId }}）</option></select></label>
        <div class="ai-tabs" aria-label="对话中心区域">
          <button v-for="entry in [{id:'CHAT',text:'会话'},{id:'SETTINGS',text:'服务与授权'},{id:'MEMORY',text:'记忆'},{id:'SUGGESTIONS',text:'建议'}] as const"
            :key="entry.id" type="button" class="button button-secondary" :class="{ selected: tab === entry.id }" :aria-pressed="tab === entry.id"
            :disabled="voiceBusy || submitting" @click="chooseTab(entry.id)">{{ entry.text }}</button>
        </div>
      </div>
      <section v-if="!pet" class="panel empty-state"><h2>没有可选择的伙伴</h2><p>先前往宠物馆获得角色。</p></section>
      <div v-else-if="tab === 'CHAT'" class="chat-grid">
        <aside class="panel ai-section conversation-list">
          <header class="ai-heading"><div><span class="eyebrow">本角色会话</span><h3>会话列表</h3></div><button type="button" class="button button-secondary" :disabled="convPending" @click="refreshConversations">刷新</button></header>
          <form class="ai-form-inline" @submit.prevent="createConversation"><label>新会话标题<input v-model="title" required maxlength="120" placeholder="新的故事" :disabled="busy" /></label><button type="submit" class="button button-primary" :disabled="busy || !title.trim()">新建会话</button></form>
          <p v-if="convError" class="ai-warning">{{ convError }}</p>
          <p v-else-if="!conversationPage" class="small muted">{{ convPending ? '正在查询会话…' : '等待本地会话档案。' }}</p>
          <template v-if="conversationPage">
            <button v-for="row in conversationPage.rows" :key="row.conversationId" type="button" class="conversation-row"
              :class="{ selected: row.conversationId === conversationId }" :aria-pressed="row.conversationId === conversationId"
              :disabled="creating || submitting" @click="chooseConversation(row)">
              <strong>{{ row.title }}</strong><small class="muted">{{ formatTime(row.updatedAt) }}</small>
            </button>
            <p v-if="!conversationPage.rows.length" class="small muted">这页尚无会话。</p>
            <div class="ai-pagination"><button type="button" class="button button-secondary" :disabled="convOffset === 0 || convPending" @click="conversationPageStep(-1)">上一页</button><span>{{ Math.floor(convOffset/convLimit)+1 }}</span><button type="button" class="button button-secondary" :disabled="aiNextOffset(convOffset,convLimit,conversationPage.rows.length,1)===undefined || convPending" @click="conversationPageStep(1)">下一页</button></div>
          </template>
        </aside>
        <section class="panel ai-section chat-body">
          <div class="ai-heading"><div><h3>{{ selectedTitle || '选择会话' }}</h3><p class="small muted">{{ pet.nickname }} · {{ pet.petId }}</p></div>
            <button type="button" class="button button-secondary" :disabled="!conversationId || messagesPending" @click="ctx.refreshAll()">刷新记录</button></div>
          <div class="ai-box"><strong>当前 AI 绑定</strong>
            <p v-if="assignment" class="small">{{ assignment.providerId }} · v{{ assignment.providerRevision }} · {{ assignedProvider ? privacyLabel[assignedProvider.config.privacyBoundary] : (assignment.cloudConsent ? '已明确远程授权' : '本地或模拟') }}</p>
            <p v-else class="small muted">{{ providerPending ? '正在确认服务绑定…' : '尚未取得有效绑定，请前往服务与授权。' }}</p>
            <p v-if="providerError" class="small muted">{{ providerError }}</p>
            <button v-if="!assignment" type="button" class="button button-secondary" :disabled="voiceBusy" @click="chooseTab('SETTINGS')">配置服务</button>
          </div>
          <div v-if="!conversationId" class="empty-state"><Icon name="chat" /><p>请选择已有会话，或新建一个属于 {{ pet.nickname }} 的故事。不会自动创建或发送消息。</p></div>
          <template v-else>
            <p v-if="messagesError" role="alert" class="ai-warning">{{ messagesError }}</p>
            <div class="history-scroll" :aria-busy="messagesPending">
              <p v-if="!messagePage" class="small muted">{{ messagesPending ? '读取真实已保存对话…' : '等待对话记录。' }}</p>
              <p v-else-if="!messagePage.rows.length" class="small muted">这一页没有已保存的消息。</p>
              <article v-for="row in messagePage?.rows ?? []" :key="row.messageId" class="chat-message" :class="{ 'user-message': row.role === 'USER' }">
                <header class="ai-heading"><strong>{{ row.role === 'USER' ? '我' : pet.nickname }}</strong><span class="small muted">{{ formatTime(row.createdAt) }} · {{ messageStatus[row.status] }}</span></header>
                <p class="ai-plain">{{ row.text || (row.status === 'PENDING' ? '等待本地服务完成…' : '此记录无文字。') }}</p>
                <div v-if="row.status !== 'PENDING'" class="ai-actions"><button v-if="row.role === 'USER'" type="button" class="text-action" :disabled="busy" @click="editMessage(row)">编辑</button><button type="button" class="text-action" :disabled="busy" @click="confirmMessage(row,'DELETE')">删除</button></div>
              </article>
              <article v-if="active && !active.terminal && messageOffset === 0" class="chat-message streaming-preview" aria-live="polite">
                <strong>{{ pet.nickname }} · 临时流预览</strong><p class="ai-plain">{{ active.degraded ? '流式顺序异常，等待服务最终记录。' : active.text || '等待服务生成内容…' }}</p><small class="muted">尚未保存，不代表最终回复。</small>
              </article>
            </div>
            <div v-if="messagePage" class="ai-pagination"><button type="button" class="button button-secondary" :disabled="messageOffset === 0 || messagesPending" @click="messagePageStep(-1)">较新</button><span>历史第 {{ Math.floor(messageOffset/messageLimit)+1 }} 页</span><button type="button" class="button button-secondary" :disabled="aiNextOffset(messageOffset,messageLimit,messagePage.rows.length,1)===undefined || messagesPending" @click="messagePageStep(1)">较早</button></div>
            <form v-if="editing" class="ai-box provider-form" @submit.prevent="confirmMessage(editing,'EDIT')">
              <label>修改本地记录<textarea v-model="editedText" :maxlength="aiLimits.userText" rows="3" required /></label><div class="ai-actions"><button type="button" class="button button-secondary" @click="resetEditor">取消</button><button type="submit" class="button button-primary" :disabled="busy || !editedText.trim()">核对修改</button></div>
            </form>
            <form class="chat-composer" @submit.prevent="send">
              <label>主动发送消息<textarea v-model="userText" :disabled="busy" :maxlength="aiLimits.userText" rows="4" placeholder="和伙伴说点什么…" /></label>
              <p v-if="assignment?.cloudConsent" class="ai-warning">已授权远程 HTTPS 服务。主动发送时，输入与必要授权上下文将联系该服务。</p>
              <div class="ai-heading"><span class="small muted">{{ userText.length }} / {{ aiLimits.userText }} · 不自动重试</span><div class="ai-actions">
                <button v-if="chatting" class="button button-secondary" type="button" :disabled="cancelPending" @click="cancelChat">{{ cancelPending ? '等待停止…' : '停止回复' }}</button>
                <button type="submit" class="button button-primary" :disabled="!canSend">发送消息 <Icon name="arrow" /></button>
              </div></div>
            </form>
            <p v-if="chatError" role="alert" class="ai-warning">{{ chatError }} 请核对持久化记录再决定是否重新发送。</p><p v-if="chatNotice" class="ai-note" role="status">{{ chatNotice }}</p>
            <AiVoicePanel v-if="bridge" :context="ctx" :disabled="!assignment || providerPending || creating || submitting" :cloud="assignment?.cloudConsent ?? false" @busy="voiceBusy = $event" />
          </template>
          <p v-if="feedback || confirmError" role="status" class="ai-note">{{ confirmError ?? feedback }}</p>
        </section>
      </div>
      <template v-else-if="tab === 'SETTINGS'">
        <AiProviderPanel :context="ctx" />
        <AiVoiceSettingsPanel :context="ctx" />
      </template>
      <AiMemoryPanel v-else-if="tab === 'MEMORY'" :context="ctx" />
      <AiProposalPanel v-else-if="tab === 'SUGGESTIONS'" :context="ctx" />
      <AiConfirmDialog :quote="quote" :submitting="submitting" :attempted="attempted" :confirmable="confirmable" :error="confirmError" @confirm="commit" @cancel="close()" @modal-error="dialogError" />
    </template>
  </div>
</template>
<style>
.chat-center { display: grid; gap: 13px; min-width: 0; }
.chat-center .page-intro { margin: 0; }
.chat-center .ai-toolbar, .chat-center .ai-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 11px; }
.chat-center .ai-toolbar { padding: 12px 14px; }
.chat-center .ai-toolbar label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
.chat-center .ai-tabs, .chat-center .ai-actions, .chat-center .ai-pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px; }
.chat-center .ai-pagination { justify-content: center; font-size: 11px; color: var(--muted); }
.chat-center .ai-section { display: grid; gap: 13px; padding: 16px; min-width: 0; align-content: start; }
.chat-center .ai-section h3 { color: var(--gold-light); }
.chat-center .ai-box { border: 1px solid var(--border-subtle); background: #292229; border-radius: 10px; padding: 12px; display: grid; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.chat-center .ai-box strong { color: var(--gold-light); }
.chat-center .ai-section input, .chat-center .ai-section select, .chat-center .ai-section textarea, .chat-center .ai-toolbar select { min-width: 0; max-width: 100%; padding: 8px 10px; border: 1px solid var(--border); color: var(--text); border-radius: 7px; background: #251e27; font: inherit; }
.chat-center .ai-section input:focus-visible, .chat-center .ai-section textarea:focus-visible, .chat-center select:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.chat-center .ai-section textarea { resize: vertical; }
.chat-center .ai-section label { color: var(--muted); font-size: 12px; }
.chat-center .ai-section .provider-form label, .chat-center .ai-form-inline label, .chat-center .chat-composer label { display: grid; gap: 6px; }
.chat-center .ai-section .checkline { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.chat-center .provider-budget { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,140px),1fr)); gap: 8px; }
.chat-center .ai-grants { display: grid; gap: 7px; padding: 9px; border: 1px solid var(--border-subtle); border-radius: 8px; background: #312831; }
.chat-center .ai-note, .chat-center .ai-warning { background: #49332d; border: 1px solid #76523f; color: #f2cfb0; padding: 10px; border-radius: 8px; line-height: 1.6; font-size: 12px; overflow-wrap: anywhere; }
.chat-center .ai-note { background: #40372d; border-color: #67583e; }
.chat-center .ai-plain { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.75; }
.chat-center .chat-grid { display: grid; gap: 13px; grid-template-columns: minmax(180px,.75fr) minmax(0,2.25fr); align-items: start; }
.chat-center .ai-form-inline, .chat-center .chat-composer { display: grid; gap: 8px; }
.chat-center .conversation-row { display: grid; gap: 5px; border: 1px solid var(--border-subtle); color: var(--text); background: #292229; font: inherit; padding: 10px; border-radius: 8px; text-align: left; cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
.chat-center .conversation-row.selected, .chat-center .ai-tabs .selected { border-color: var(--gold); color: var(--gold-light); background: #44372d; }
.chat-center .history-scroll { display: flex; flex-direction: column; gap: 10px; max-height: 410px; min-height: 150px; overflow-y: auto; padding: 10px; background: #241e27; border: 1px solid var(--border-subtle); border-radius: 8px; }
.chat-center .chat-message { align-self: flex-start; display: grid; gap: 7px; width: min(100%,450px); background: #342a37; border: 1px solid #56445b; border-radius: 12px 12px 12px 3px; padding: 10px; min-width: 0; }
.chat-center .chat-message.user-message { align-self: flex-end; background: #44372d; border-color: #6a533c; border-radius: 12px 12px 3px 12px; }
.chat-center .chat-message .text-action { border: none; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 11px; }
.chat-center .chat-message .text-action:disabled { opacity: .45; cursor: not-allowed; }
.chat-center .streaming-preview { border-style: dashed; }
@media(max-width:720px) { .chat-center .chat-grid { grid-template-columns: minmax(0,1fr); } }
</style>
