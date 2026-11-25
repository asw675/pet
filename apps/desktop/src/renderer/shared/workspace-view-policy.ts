import { routineDefinitionSchema } from '@pet-desktop/contracts/workspace';
import type { LaunchHistoryFact, LocalRecommendation, QuickActionView, RoutineDefinition, WorkspacePage } from '@pet-desktop/contracts/workspace';
import { workspaceIntentSchema, workspaceResultMatches, workspaceResultSchema } from '../../shared/workspace-ipc';
import type { WorkspaceErrorCode, WorkspaceIntent, WorkspaceResult, WorkspaceSelection } from '../../shared/workspace-ipc';

export const workspaceErrorText: Readonly<Record<WorkspaceErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: '输入格式不符合要求，请检查后重试。', FORBIDDEN: '尚无有效授权，不能执行此操作。', CANCELLED: '操作已取消。',
  BUSY: '工作台正在处理另一项操作。', SERVICE_UNAVAILABLE: '本地服务暂不可用，请稍后重新查询。', REVISION_CONFLICT: '档案已变化，请刷新后重新确认。',
  NOT_FOUND: '收藏或场景已不存在。', CAPACITY: '已达到收藏或场景容量上限。', CONFLICT: '记录冲突，请刷新后重新操作。',
  INVALID_TARGET: '目标格式无效或不在当前支持范围内。', UNSAFE_TARGET: '无法确认目标身份，已阻止启动。', TARGET_CHANGED: '目标身份已变化，请重新授权。',
  APPROVAL_INVALID: '授权不存在或与当前操作不一致，请重新选择。', APPROVAL_EXPIRED: '本次选择授权已失效，请重新选择。',
  TIMEOUT: '操作超时，结果可能尚未确认；请核对实际状态，勿直接重复启动。', INTERNAL_ERROR: '服务未确认操作，请刷新档案。',
});
export const outcomeText = Object.freeze({ ACCEPTED: '系统已接受', FAILED: '失败', SKIPPED: '已跳过', UNKNOWN: '结果未确认' });
export const sourceText = Object.freeze({ MANUAL: '手动启动', ROUTINE: '场景组合', SUGGESTION: '建议入口' });
export const targetKindText = Object.freeze({ WIN32_EXE: 'Windows 应用', FOLDER: '本机目录', HTTPS: 'HTTPS 网页' });

export function validateWorkspaceResponse(intent: WorkspaceIntent, raw: unknown): WorkspaceResult | null {
  const input = workspaceIntentSchema.safeParse(intent), result = workspaceResultSchema.safeParse(raw);
  if (!input.success || !result.success) return null;
  // Preload owns the real request ID correlation. Here additionally verify
  // entity identity/revision and expected response shape at the UI boundary.
  return workspaceResultMatches({ requestId: result.data.requestId, intent: input.data }, result.data) ? result.data : null;
}
export function actionCanRun(action: QuickActionView | undefined): action is QuickActionView {
  return !!action && action.approved && action.enabled;
}
function validRoutineTargets(page: WorkspacePage, definition: RoutineDefinition): boolean {
  return definition.targetIds.every(id => actionCanRun(page.actions.find(action => action.id === id)));
}
/** A quote/intent must still refer to the current authoritative page. The
 * game's snapshot revision is unrelated to the workspace revision. */
export function applicableWorkspaceIntent(page: WorkspacePage, input: WorkspaceIntent): boolean {
  const parsed = workspaceIntentSchema.safeParse(input);
  if (!parsed.success) return false;
  const intent = parsed.data;
  switch (intent.method) {
    case 'workspace/list': return true;
    case 'action/select': return page.revision === intent.payload.expectedRevision;
    case 'action/add': return page.revision === intent.payload.expectedRevision;
    case 'action/reapprove': return page.revision === intent.payload.expectedWorkspaceRevision
      && page.actions.some(action => action.id === intent.payload.actionId && action.revision === intent.payload.expectedActionRevision);
    case 'action/run': {
      const action = page.actions.find(row => row.id === intent.payload.actionId);
      return actionCanRun(action) && action.revision === intent.payload.expectedRevision;
    }
    case 'action/metadata': {
      const action = page.actions.find(row => row.id === intent.payload.actionId);
      return !!action && action.revision === intent.payload.expectedRevision && (action.approved || (!intent.payload.enabled && !intent.payload.recommendable));
    }
    case 'action/revoke': case 'action/delete': return page.actions.some(action => action.id === intent.payload.actionId && action.revision === intent.payload.expectedRevision);
    case 'routine/create': return page.revision === intent.payload.expectedRevision && validRoutineTargets(page, intent.payload.definition);
    case 'routine/update': return page.routines.some(routine => routine.id === intent.payload.routineId && routine.revision === intent.payload.expectedRevision)
      && validRoutineTargets(page, intent.payload.definition);
    case 'routine/delete': case 'routine/run': return page.routines.some(routine => routine.id === intent.payload.routineId && routine.revision === intent.payload.expectedRevision);
    case 'routine/cancel':
    case 'suggestion/run': return false; // These require a separate sender-bound run or proposal authorization.
    case 'recommendation/settings': return page.revision === intent.payload.expectedRevision;
    case 'recommendation/seen': return page.settings.enabled && page.revision === intent.payload.expectedRevision
      && intent.payload.targetIds.every(id => page.recommendations.some(row => row.targetId === id));
    case 'recommendation/preference': return page.revision === intent.payload.expectedRevision && page.actions.some(action => action.id === intent.payload.preference.targetId);
    case 'history/clear': return page.revision === intent.payload.expectedRevision && (intent.payload.targetId === undefined || page.actions.some(action => action.id === intent.payload.targetId));
  }
}

export interface WorkspaceConfirmation {
  readonly generation: number;
  readonly revision: number;
  readonly intent: WorkspaceIntent;
  readonly title: string;
  readonly details: string;
}
const confirmMethods = new Set<WorkspaceIntent['method']>(['action/metadata','action/revoke','action/delete','routine/create','routine/update','routine/delete',
  'recommendation/settings','recommendation/preference','history/clear']);
export function createWorkspaceConfirmation(page: WorkspacePage | null, generation: number | null, intent: WorkspaceIntent,
  title: string, details: string): WorkspaceConfirmation | null {
  const parsed = workspaceIntentSchema.safeParse(intent);
  if (!page || generation === null || !parsed.success || !confirmMethods.has(parsed.data.method) || !applicableWorkspaceIntent(page, parsed.data)) return null;
  return { generation, revision: page.revision, intent: parsed.data, title, details };
}
export function confirmWorkspaceIntent(quote: WorkspaceConfirmation, page: WorkspacePage | null, generation: number | null): WorkspaceIntent | null {
  return page !== null && quote.generation === generation && quote.revision === page.revision && applicableWorkspaceIntent(page, quote.intent) ? quote.intent : null;
}

export interface WorkspaceApproval {
  readonly generation: number;
  readonly workspaceRevision: number;
  readonly selection: WorkspaceSelection;
  readonly replacing: { actionId: string; actionRevision: number } | null;
}
export function approvalIntent(approval: WorkspaceApproval | null, page: WorkspacePage | null, generation: number | null,
  now: number, label: string, recommendable: boolean): WorkspaceIntent | null {
  if (!approval || !page || approval.generation !== generation || approval.workspaceRevision !== page.revision
    || !Number.isSafeInteger(now) || now < 0 || now >= approval.selection.expiresAt) return null;
  const input = approval.replacing ? { method: 'action/reapprove', payload: { actionId: approval.replacing.actionId,
    expectedActionRevision: approval.replacing.actionRevision, expectedWorkspaceRevision: page.revision, approvalToken: approval.selection.approvalToken } }
    : { method: 'action/add', payload: { approvalToken: approval.selection.approvalToken, label: label.trim(), recommendable, expectedRevision: page.revision } };
  const parsed = workspaceIntentSchema.safeParse(input);
  return parsed.success && applicableWorkspaceIntent(page, parsed.data) ? parsed.data : null;
}

export interface RoutineDraft {
  name: string; targetIds: string[]; mode: RoutineDefinition['mode']; delayMs: number; failurePolicy: RoutineDefinition['failurePolicy'];
}
export function newRoutineDraft(): RoutineDraft { return { name: '', targetIds: [], mode: 'SEQUENTIAL', delayMs: 500, failurePolicy: 'CONTINUE' }; }
export function routineDefinitionForDraft(draft: RoutineDraft, page: WorkspacePage | null): RoutineDefinition | null {
  if (!page) return null;
  const parsed = routineDefinitionSchema.safeParse({ ...draft, name: draft.name.trim(), skipDuplicates: true });
  return parsed.success && validRoutineTargets(page, parsed.data) ? parsed.data : null;
}
export function moveRoutineTarget(targetIds: readonly string[], index: number, direction: -1 | 1): string[] {
  const result = [...targetIds], next = index + direction;
  if (index < 0 || next < 0 || index >= result.length || next >= result.length) return result;
  [result[index], result[next]] = [result[next]!, result[index]!];
  return result;
}
export function recommendationStillEligible(page: WorkspacePage, targetId: string, now: number): boolean {
  const action = page.actions.find(row => row.id === targetId), pref = page.preferences.find(row => row.targetId === targetId);
  return page.settings.enabled && actionCanRun(action) && action.recommendable && !pref?.permanentlyExcluded
    && (pref?.ignoredUntil === undefined || pref.ignoredUntil === null || pref.ignoredUntil <= now);
}
/** Already displayed, counted cards may remain visible after the authority
 * exhausts today's budget. Their actual action is still an ordinary saved
 * action intent, never a different launch capability. */
export function visibleRecommendationCards(page: WorkspacePage, displayed: readonly LocalRecommendation[], now: number): LocalRecommendation[] {
  const cards = new Map<string, LocalRecommendation>();
  for (const recommendation of [...displayed, ...page.recommendations]) {
    if (cards.has(recommendation.targetId) || !recommendationStillEligible(page, recommendation.targetId, now)) continue;
    const action = page.actions.find(row => row.id === recommendation.targetId)!;
    cards.set(recommendation.targetId, { ...recommendation, label: action.label });
  }
  return [...cards.values()].slice(0, 2);
}
/** Browser observer supplies the geometry; only a visible document/card can
 * request that Main records a displayed suggestion. Never count a poll. */
export function visibleRecommendationTargetIds(entries: readonly { targetId: string | undefined; isIntersecting: boolean; intersectionRatio: number }[],
  documentVisible: boolean): string[] {
  if (!documentVisible) return [];
  return [...new Set(entries.filter(entry => entry.isIntersecting && entry.intersectionRatio >= .6 && typeof entry.targetId === 'string')
    .map(entry => entry.targetId!))].slice(0, 2);
}
export function recommendationAction(page: WorkspacePage, recommendation: LocalRecommendation, displayed = false, now = Date.now()): WorkspaceIntent | null {
  const actual = displayed || page.recommendations.some(row => row.targetId === recommendation.targetId);
  const action = page.actions.find(row => row.id === recommendation.targetId);
  return actual && recommendationStillEligible(page, recommendation.targetId, now) && actionCanRun(action)
    ? { method: 'action/run', payload: { actionId: action.id, expectedRevision: action.revision } } : null;
}
export function draftFromRecommendation(page: WorkspacePage, recommendation: LocalRecommendation, displayed = false, now = Date.now()): RoutineDraft | null {
  const actual = displayed ? recommendation : page.recommendations.find(row => row.targetId === recommendation.targetId);
  if (!actual || actual.routineSuggestion.length < 2 || !recommendationStillEligible(page, recommendation.targetId, now)
    || actual.routineSuggestion.some(id => !recommendationStillEligible(page,id,now))) return null;
  const draft: RoutineDraft = { ...newRoutineDraft(), name: '常用工作组合', targetIds: [...actual.routineSuggestion] };
  return routineDefinitionForDraft(draft, page) ? draft : null;
}
export function historyTime(fact: LaunchHistoryFact): string {
  const shifted = fact.timeBucket + fact.utcOffsetMinutes * 60_000;
  if (!Number.isSafeInteger(shifted) || Math.abs(shifted) > 8_640_000_000_000_000) return '时间不可用';
  const value = new Date(shifted).toISOString().slice(0, 16).replace('T', ' ');
  const offset = Math.abs(fact.utcOffsetMinutes), sign = fact.utcOffsetMinutes >= 0 ? '+' : '-';
  return `${value} UTC${sign}${String(Math.floor(offset / 60)).padStart(2,'0')}:${String(offset % 60).padStart(2,'0')}`;
}
