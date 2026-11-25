import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { LocalRecommendation, QuickActionView, QuickLaunchKind, WorkspacePage } from '@pet-desktop/contracts/workspace';
import { workspaceIntentSchema } from '../../shared/workspace-ipc';
import type { RoutineRunResult, WorkspaceIntent, WorkspaceResult } from '../../shared/workspace-ipc';
import {
  actionCanRun, applicableWorkspaceIntent, approvalIntent, confirmWorkspaceIntent, createWorkspaceConfirmation,
  draftFromRecommendation, outcomeText, recommendationAction, validateWorkspaceResponse, visibleRecommendationCards, workspaceErrorText,
} from '../shared/workspace-view-policy';
import type { WorkspaceApproval, WorkspaceConfirmation } from '../shared/workspace-view-policy';
import { useAppStore } from '../shared/store';

type Scope = { generation: number; epoch: number };
/** Workspace revision is independent of the game's revision. Never merge a
 * delayed workspace response into another worker generation or auto-repeat
 * a native action on ambiguous transport errors. */
export function useWorkspaceProjection() {
  const store = useAppStore();
  const bridge = typeof window !== 'undefined' && window.petDesktop?.role === 'control-center' ? window.petDesktop : undefined;
  const generation = computed(() => store.ready && store.serviceStatus?.stage === 'READY' ? store.serviceStatus.generation : null);
  const page = shallowRef<WorkspacePage | null>(null), busy = ref(false), querying = ref(false);
  const error = ref<string | null>(null), notice = ref<string | null>(null);
  const approval = shallowRef<WorkspaceApproval | null>(null), confirmation = shallowRef<WorkspaceConfirmation | null>(null);
  const runningRoutineId = ref<string | null>(null), runningActionId = ref<string | null>(null), cancelling = ref(false);
  const routineResult = shallowRef<RoutineRunResult | null>(null);
  const displayed = shallowRef<LocalRecommendation[]>([]);
  const attemptedImpressions = new Set<string>();
  let epoch = 0, disposed = false;
  const takeScope = (): Scope | null => generation.value === null || disposed ? null : { generation: generation.value, epoch };
  const isCurrent = (scope: Scope | null): boolean => scope !== null && !disposed && generation.value === scope.generation && epoch === scope.epoch;
  const canAct = computed(() => page.value !== null && generation.value !== null && !busy.value && !querying.value && !!bridge);
  const cards = computed(() => page.value ? visibleRecommendationCards(page.value, displayed.value, Date.now()) : []);
  const canConfirm = computed(() => canAct.value && !!confirmation.value && !!confirmWorkspaceIntent(confirmation.value, page.value, generation.value));

  async function invoke(input: WorkspaceIntent): Promise<WorkspaceResult | null> {
    const parsed = workspaceIntentSchema.safeParse(input);
    if (!bridge?.workspaceRequest || !parsed.success) return null;
    try { return validateWorkspaceResponse(parsed.data, await bridge.workspaceRequest(parsed.data)); }
    catch { return null; }
  }
  function problem(result: WorkspaceResult | null): string {
    return result && !result.ok ? workspaceErrorText[result.error.code] : '服务未确认结果，请刷新实际档案后再决定，勿直接重复启动。';
  }
  function installPage(value: WorkspacePage): boolean {
    if (page.value && value.revision < page.value.revision) return false;
    page.value = value;
    displayed.value = visibleRecommendationCards(value, displayed.value, Date.now()).filter(row => attemptedImpressions.has(row.targetId));
    if (!value.settings.enabled) displayed.value = [];
    if (approval.value && approval.value.workspaceRevision !== value.revision) approval.value = null;
    return true;
  }
  async function readPage(scope: Scope, clearOnFailure: boolean): Promise<boolean> {
    const response = await invoke({ method: 'workspace/list', payload: {} });
    if (!isCurrent(scope)) return false;
    if (!response?.ok || response.method !== 'workspace/list' || !installPage(response.data)) {
      if (clearOnFailure) page.value = null;
      error.value = problem(response); return false;
    }
    return true;
  }
  async function reload(): Promise<void> {
    const scope = takeScope();
    if (!scope || busy.value || querying.value) return;
    querying.value = true; error.value = null;
    try { await readPage(scope, true); }
    finally { if (isCurrent(scope)) querying.value = false; }
  }
  function reset(): void {
    epoch++; page.value = null; busy.value = false; querying.value = false; error.value = null; notice.value = null;
    approval.value = null; confirmation.value = null; runningRoutineId.value = null; runningActionId.value = null;
    routineResult.value = null; cancelling.value = false; displayed.value = []; attemptedImpressions.clear();
  }
  watch(generation, next => { reset(); if (next !== null) void reload(); }, { immediate: true, flush: 'sync' });

  function beginConfirmation(intent: WorkspaceIntent, title: string, details: string): boolean {
    if (!canAct.value) return false;
    const quote = createWorkspaceConfirmation(page.value, generation.value, intent, title, details);
    if (!quote) { error.value = '操作内容不完整或已失效，请检查最新档案。'; return false; }
    confirmation.value = quote; error.value = null; return true;
  }
  function closeConfirmation(): void { if (!busy.value) confirmation.value = null; }
  async function mutation(input: WorkspaceIntent, message: string): Promise<boolean> {
    const scope = takeScope();
    if (!scope || !canAct.value || !page.value || !applicableWorkspaceIntent(page.value,input)) return false;
    busy.value = true; error.value = null; notice.value = null;
    const response = await invoke(input);
    if (!isCurrent(scope)) return false;
    let success = false;
    try {
      if (response?.ok && 'revision' in response.data && installPage(response.data)) { notice.value = message; success = true; }
      else { error.value = problem(response); await readPage(scope, true); }
      return success;
    } finally { if (isCurrent(scope)) busy.value = false; }
  }
  async function confirm(): Promise<boolean> {
    const selected = confirmation.value;
    if (!selected || !canAct.value) return false;
    const input = confirmWorkspaceIntent(selected,page.value,generation.value);
    // Consume the local confirmation synchronously. No UI retry can reuse it.
    confirmation.value = null;
    if (!input) { error.value = '档案或授权已变化，请重新确认。'; return false; }
    return mutation(input, '档案已保存。');
  }

  async function selectTarget(kind: QuickLaunchKind, manualHttpsUrl: string, replacing?: QuickActionView): Promise<boolean> {
    const scope = takeScope(), current = page.value;
    if (!scope || !current || !canAct.value || (replacing && !current.actions.some(row => row.id === replacing.id && row.revision === replacing.revision))) return false;
    const payload = kind === 'HTTPS' ? { kind, expectedRevision: current.revision, manualHttpsUrl: manualHttpsUrl.trim() }
      : { kind, expectedRevision: current.revision };
    const checked = workspaceIntentSchema.safeParse({ method: 'action/select', payload });
    if (!checked.success) { error.value = '请输入有效长度的 HTTPS 地址。'; return false; }
    busy.value = true; approval.value = null; error.value = null; notice.value = null;
    try {
      const response = await invoke(checked.data);
      if (!isCurrent(scope)) return false;
      if (!response?.ok || response.method !== 'action/select') { error.value = problem(response); return false; }
      if (page.value?.revision !== current.revision) { error.value = '收藏档案已变化，请重新选择目标。'; return false; }
      approval.value = { generation: scope.generation, workspaceRevision: current.revision, selection: response.data,
        replacing: replacing ? { actionId: replacing.id, actionRevision: replacing.revision } : null };
      return true;
    } finally { if (isCurrent(scope)) busy.value = false; }
  }
  function discardApproval(): void { if (!busy.value) approval.value = null; }
  async function saveApproval(label: string, recommendable: boolean): Promise<boolean> {
    if (!canAct.value || !approval.value) return false;
    const selected = approval.value;
    const input = approvalIntent(selected,page.value,generation.value,Date.now(),label,recommendable);
    if (!input) { error.value = '授权已失效或名称无效，请检查后重新选择。'; return false; }
    // Token is one-shot in Main as well; never auto-replay the finalize request.
    approval.value = null;
    return mutation(input, selected.replacing ? '目标已重新授权。' : '已添加快捷收藏。');
  }

  async function runAction(actionId: string): Promise<boolean> {
    const scope = takeScope(), action = page.value?.actions.find(row => row.id === actionId);
    if (!scope || !canAct.value || !actionCanRun(action)) return false;
    const input: WorkspaceIntent = { method: 'action/run', payload: { actionId, expectedRevision: action.revision } };
    busy.value = true; runningActionId.value = actionId; error.value = null; notice.value = null;
    try {
      const result = await invoke(input);
      if (!isCurrent(scope)) return false;
      if (result?.ok && result.method === 'action/run') {
        notice.value = `${action.label}：${outcomeText[result.data.outcome]}${result.data.outcome === 'UNKNOWN' ? '，请检查实际状态。' : '。'}`;
        await readPage(scope, true); return result.data.outcome === 'ACCEPTED';
      }
      error.value = problem(result); await readPage(scope, true); return false;
    } finally { if (isCurrent(scope)) { busy.value = false; runningActionId.value = null; } }
  }
  async function runRoutine(routineId: string): Promise<void> {
    const scope = takeScope(), routine = page.value?.routines.find(row => row.id === routineId);
    if (!scope || !canAct.value || !routine) return;
    busy.value = true; runningRoutineId.value = routineId; error.value = null; notice.value = null; routineResult.value = null;
    try {
      const result = await invoke({ method: 'routine/run', payload: { routineId, expectedRevision: routine.revision } });
      if (!isCurrent(scope)) return;
      if (result?.ok && result.method === 'routine/run') { routineResult.value = result.data; notice.value = '场景的实际调度结果已返回。'; }
      else error.value = problem(result);
      await readPage(scope,true);
    } finally { if (isCurrent(scope)) { busy.value = false; runningRoutineId.value = null; cancelling.value = false; } }
  }
  async function cancelRoutine(): Promise<void> {
    const scope = takeScope(), routineId = runningRoutineId.value;
    if (!scope || !routineId || cancelling.value) return;
    cancelling.value = true;
    const response = await invoke({ method: 'routine/cancel', payload: { routineId } });
    if (!isCurrent(scope)) return;
    cancelling.value = false;
    if (runningRoutineId.value !== routineId) return;
    if (response?.ok && response.method === 'routine/cancel') notice.value = response.data.cancelled ? '已请求取消尚未启动的目标。' : '当前已没有可取消的场景。';
    else error.value = problem(response);
  }
  async function markRecommendationsSeen(targetIds: readonly string[]): Promise<void> {
    const scope = takeScope(), current = page.value;
    if (!scope || !current || !canAct.value || !current.settings.enabled) return;
    // Called only after actual card intersection while the document is visible.
    const actual = current.recommendations.filter(row => targetIds.includes(row.targetId) && !attemptedImpressions.has(row.targetId));
    if (!actual.length) return;
    for (const row of actual) attemptedImpressions.add(row.targetId);
    displayed.value = [...displayed.value, ...actual].slice(0,2);
    busy.value = true;
    try {
      const response = await invoke({ method: 'recommendation/seen', payload: { expectedRevision: current.revision, targetIds: actual.map(row => row.targetId) } });
      if (!isCurrent(scope)) return;
      if (!response?.ok || response.method !== 'recommendation/seen' || !installPage(response.data)) {
        // Ambiguous impressions are never repeated from this visit. The card
        // was actually presented, so retain it while still eligible.
        error.value = problem(response); await readPage(scope,true);
      }
    } finally { if (isCurrent(scope)) busy.value = false; }
  }
  function recommendationIntent(card: LocalRecommendation): WorkspaceIntent | null {
    return page.value ? recommendationAction(page.value,card,displayed.value.some(row => row.targetId === card.targetId)) : null;
  }
  function recommendationDraft(card: LocalRecommendation) {
    return page.value ? draftFromRecommendation(page.value,card,displayed.value.some(row => row.targetId === card.targetId)) : null;
  }
  onBeforeUnmount(() => {
    // Explicitly cancel our own active scene when leaving; in-flight accepted
    // adapter results are not killed/ retried. Main also enforces document scope.
    if (runningRoutineId.value && generation.value !== null) void invoke({ method: 'routine/cancel', payload: { routineId: runningRoutineId.value } });
    disposed = true; reset();
  });
  return { store, generation, page, busy, querying, canAct, error, notice, approval, confirmation, canConfirm, runningActionId, runningRoutineId,
    cancelling, routineResult, cards, reload, beginConfirmation, closeConfirmation, confirm, selectTarget, discardApproval, saveApproval,
    runAction, runRoutine, cancelRoutine, markRecommendationsSeen, recommendationIntent, recommendationDraft };
}
