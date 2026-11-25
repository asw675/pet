import { z } from 'zod';
import {
  approvedQuickTargetSchema, launchAuthorityActionSchema, launchOutcomeSchema, launchSourceSchema,
  quickLaunchKindSchema, routineSchema, workspaceLimits, workspacePageSchema,
  workspaceNativeSelectIntentSchema, workspaceFinalizeAddIntentSchema, workspaceReapproveIntentSchema,
  workspaceActionMetadataIntentSchema, workspaceRevokeActionIntentSchema, workspaceDeleteActionIntentSchema,
  workspaceRunActionIntentSchema, workspaceCreateRoutineIntentSchema, workspaceUpdateRoutineIntentSchema,
  workspaceDeleteRoutineIntentSchema, workspaceRunRoutineIntentSchema, workspaceRecommendationSettingsIntentSchema,
  workspaceRecommendationPreferenceIntentSchema, workspaceClearHistoryIntentSchema,
} from '@pet-desktop/contracts/workspace';
import type { WorkspacePage, RoutineDefinition } from '@pet-desktop/contracts/workspace';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});
const label = z.string().min(1).max(workspaceLimits.label).refine(value => value.trim().length > 0 && !/[/\\\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value));
const preview = z.string().min(1).max(260).refine(value => value.trim().length > 0 && !/[/\\\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value));
const intent = <M extends string, S extends z.ZodType>(method: M, payload: S) => z.strictObject({ method: z.literal(method), payload });

/** Renderer-manageable data only. None of these methods grants permission to
 * create/replace an approval, dispatch an OS operation or record usage. */
const managementIntents = [
  intent('workspace/list', empty), intent('action/metadata', workspaceActionMetadataIntentSchema),
  intent('action/revoke', workspaceRevokeActionIntentSchema), intent('action/delete', workspaceDeleteActionIntentSchema),
  intent('routine/create', workspaceCreateRoutineIntentSchema), intent('routine/update', workspaceUpdateRoutineIntentSchema),
  intent('routine/delete', workspaceDeleteRoutineIntentSchema), intent('recommendation/settings', workspaceRecommendationSettingsIntentSchema),
  intent('recommendation/preference', workspaceRecommendationPreferenceIntentSchema), intent('history/clear', workspaceClearHistoryIntentSchema),
] as const;
export const workspaceManagementIntentSchema = z.discriminatedUnion('method', managementIntents);
export type WorkspaceManagementIntent = z.infer<typeof workspaceManagementIntentSchema>;

const nativeIntents = [
  intent('action/select', workspaceNativeSelectIntentSchema), intent('action/add', workspaceFinalizeAddIntentSchema),
  intent('action/reapprove', workspaceReapproveIntentSchema), intent('action/run', workspaceRunActionIntentSchema),
  intent('routine/run', workspaceRunRoutineIntentSchema), intent('routine/cancel', z.strictObject({ routineId: id })),
  // A presentation observation, not an impression fact: Main verifies the
  // visible current card IDs/revision and creates private impression IDs.
  intent('recommendation/seen', z.strictObject({ expectedRevision: revision,
    targetIds: z.array(id).min(1).max(workspaceLimits.impressionsPerDay).refine(values => new Set(values).size === values.length) })),
] as const;
export const workspaceIntentSchema = z.discriminatedUnion('method', [...managementIntents, ...nativeIntents]);
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;
export const workspaceRequestSchema = z.strictObject({ requestId: id, intent: workspaceIntentSchema });
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;

export const workspaceErrorCodeSchema = z.enum(['INVALID_REQUEST', 'FORBIDDEN', 'CANCELLED', 'BUSY', 'SERVICE_UNAVAILABLE',
  'REVISION_CONFLICT', 'NOT_FOUND', 'CAPACITY', 'CONFLICT', 'INVALID_TARGET', 'UNSAFE_TARGET', 'TARGET_CHANGED',
  'APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'TIMEOUT', 'INTERNAL_ERROR']);
export type WorkspaceErrorCode = z.infer<typeof workspaceErrorCodeSchema>;
export const workspaceErrorSchema = z.strictObject({ code: workspaceErrorCodeSchema });

/** Renderer sees only the one-use token and display-only label/preview.
 * Native confirmation independently discloses the actual approved target. */
export const workspaceSelectionSchema = z.strictObject({
  approvalToken: z.string().regex(/^quick-[1-9]\d{0,15}-[a-f0-9]{64}$/u), expiresAt: revision,
  kind: quickLaunchKindSchema, suggestedLabel: label, preview,
});
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;
export const workspaceRunActionResultSchema = z.strictObject({ runId: id, targetId: id, outcome: launchOutcomeSchema });
export const routineTargetResultSchema = z.strictObject({ targetId: id, outcome: launchOutcomeSchema,
  reason: z.enum(['DUPLICATE', 'UNAVAILABLE', 'CHANGED', 'STOPPED', 'CANCELLED', 'POLICY_DENIED']).nullable(),
}).refine(row => row.outcome === 'SKIPPED' ? row.reason !== null : row.reason === null);
export type RoutineTargetResult = z.infer<typeof routineTargetResultSchema>;
export const routineRunResultSchema = z.strictObject({ runId: id, routineId: id, routineRevision: revision,
  cancelled: z.boolean(), targets: z.array(routineTargetResultSchema).min(1).max(workspaceLimits.routineTargets),
}).refine(result => new Set(result.targets.map(row => row.targetId)).size === result.targets.length);
export type RoutineRunResult = z.infer<typeof routineRunResultSchema>;

const success = <M extends string, S extends z.ZodType>(method: M, data: S) => z.strictObject({ requestId: id, method: z.literal(method), ok: z.literal(true), data });
const managementMethods = ['workspace/list','action/metadata','action/revoke','action/delete','routine/create','routine/update','routine/delete',
  'recommendation/settings','recommendation/preference','history/clear'] as const;
const resultMethods = [...managementMethods, 'action/select', 'action/add', 'action/reapprove', 'action/run', 'routine/run', 'routine/cancel', 'recommendation/seen'] as const;
const pageSuccess = z.strictObject({ requestId: id, method: z.enum([...managementMethods, 'action/add', 'action/reapprove', 'recommendation/seen']), ok: z.literal(true), data: workspacePageSchema });
export const workspaceResultSchema = z.union([
  pageSuccess, success('action/select', workspaceSelectionSchema), success('action/run', workspaceRunActionResultSchema),
  success('routine/run', routineRunResultSchema), success('routine/cancel', z.strictObject({ cancelled: z.boolean() })),
  z.strictObject({ requestId: id, method: z.enum(resultMethods), ok: z.literal(false), error: workspaceErrorSchema }),
]);
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
function sameRoutineDefinition(a: RoutineDefinition, b: RoutineDefinition): boolean {
  return a.name === b.name && a.mode === b.mode && a.delayMs === b.delayMs && a.failurePolicy === b.failurePolicy
    && a.skipDuplicates === b.skipDuplicates && a.targetIds.length === b.targetIds.length && a.targetIds.every((targetId,index) => targetId === b.targetIds[index]);
}
function managementPageMatches(intent: WorkspaceManagementIntent, page: WorkspacePage): boolean {
  switch (intent.method) {
    case 'workspace/list': return true;
    case 'action/metadata': {
      const { actionId, expectedRevision, label, enabled, recommendable } = intent.payload;
      return page.actions.some(action => action.id === actionId && action.revision === expectedRevision + 1
        && action.label === label && action.enabled === enabled && action.recommendable === recommendable);
    }
    case 'action/revoke': return page.actions.some(action => action.id === intent.payload.actionId && !action.approved
      && action.revision === intent.payload.expectedRevision + 1) && (!intent.payload.clearHistory || page.history.every(fact => fact.targetId !== intent.payload.actionId));
    case 'action/delete': return page.actions.every(action => action.id !== intent.payload.actionId);
    case 'routine/create': return page.revision === intent.payload.expectedRevision + 1
      && page.routines.some(routine => routine.revision === 0 && sameRoutineDefinition(routine, intent.payload.definition));
    case 'routine/update': return page.routines.some(routine => routine.id === intent.payload.routineId
      && routine.revision === intent.payload.expectedRevision + 1 && sameRoutineDefinition(routine, intent.payload.definition));
    case 'routine/delete': return page.routines.every(routine => routine.id !== intent.payload.routineId);
    case 'recommendation/settings': return page.revision === intent.payload.expectedRevision + 1 && page.settings.enabled === intent.payload.settings.enabled
      && page.settings.retentionDays === intent.payload.settings.retentionDays && (!intent.payload.clearHistory || page.history.length === 0);
    case 'recommendation/preference': {
      const pref = intent.payload.preference, actual = page.preferences.find(row => row.targetId === pref.targetId);
      return page.revision === intent.payload.expectedRevision + 1 && (!pref.permanentlyExcluded && pref.ignoredUntil === null
        ? actual === undefined : actual?.permanentlyExcluded === pref.permanentlyExcluded && actual.ignoredUntil === pref.ignoredUntil);
    }
    case 'history/clear': return page.revision === intent.payload.expectedRevision + 1 && page.history.every(fact => intent.payload.targetId !== undefined && fact.targetId !== intent.payload.targetId);
  }
}
export function workspaceResultMatches(request: WorkspaceRequest, result: WorkspaceResult): boolean {
  const input = request.intent;
  if (request.requestId !== result.requestId || input.method !== result.method) return false;
  if (!result.ok) return true;
  switch (result.method) {
    case 'action/select': return input.method === 'action/select' && result.data.kind === input.payload.kind;
    case 'action/run': return input.method === 'action/run' && result.data.targetId === input.payload.actionId;
    case 'routine/run': return input.method === 'routine/run' && result.data.routineId === input.payload.routineId && result.data.routineRevision === input.payload.expectedRevision;
    case 'routine/cancel': return true;
    case 'recommendation/seen': return input.method === 'recommendation/seen' && result.data.revision === input.payload.expectedRevision;
    case 'action/add': return input.method === 'action/add' && result.data.revision === input.payload.expectedRevision + 1
      && result.data.actions.some(action => action.approved && action.enabled && action.revision === 0
        && action.label === input.payload.label && action.recommendable === input.payload.recommendable);
    case 'action/reapprove': return input.method === 'action/reapprove' && result.data.revision === input.payload.expectedWorkspaceRevision + 1
      && result.data.actions.some(action => action.id === input.payload.actionId && action.approved && action.enabled
        && action.revision === input.payload.expectedActionRevision + 1);
    default: {
      const management = workspaceManagementIntentSchema.safeParse(input);
      return management.success && managementPageMatches(management.data, result.data);
    }
  }
}

/** Main/worker only. Never expose this transport on preload, chat or renderer
 * dispatch. A routine plan is an exact ordered atomic storage projection. */
export const routineLaunchPlanSchema = z.strictObject({ routine: routineSchema,
  targets: z.array(z.strictObject({ targetId: id, action: launchAuthorityActionSchema.nullable() })).min(1).max(workspaceLimits.routineTargets),
}).refine(plan => plan.targets.length === plan.routine.targetIds.length && plan.targets.every((target, index) =>
  target.targetId === plan.routine.targetIds[index] && (target.action === null || target.action.id === target.targetId)));
export type RoutineLaunchPlan = z.infer<typeof routineLaunchPlanSchema>;

export const approvedActionAddSchema = z.strictObject({ target: approvedQuickTargetSchema, label, recommendable: z.boolean(), expectedRevision: revision });
export const approvedActionReapproveSchema = z.strictObject({ target: approvedQuickTargetSchema, actionId: id,
  expectedActionRevision: revision, expectedWorkspaceRevision: revision });
export const launchRecordSchema = z.strictObject({ targetId: id, runId: id, source: launchSourceSchema, outcome: launchOutcomeSchema, actionRevision: revision });
export type LaunchRecord = z.infer<typeof launchRecordSchema>;
export const impressionRecordSchema = z.strictObject({ expectedRevision: revision,
  displayed: z.array(z.strictObject({ targetId: id, impressionId: id })).min(1).max(workspaceLimits.impressionsPerDay),
}).refine(input => new Set(input.displayed.map(row => row.targetId)).size === input.displayed.length && new Set(input.displayed.map(row => row.impressionId)).size === input.displayed.length);
export type ImpressionRecord = z.infer<typeof impressionRecordSchema>;

export const workspaceAuthorityIntentSchema = z.discriminatedUnion('method', [
  intent('workspace/manage', z.strictObject({ intent: workspaceManagementIntentSchema })), intent('workspace/revision', empty),
  intent('action/lookup', z.strictObject({ actionId: id })), intent('routine/plan', z.strictObject({ routineId: id })),
  intent('approved/add', approvedActionAddSchema), intent('approved/reapprove', approvedActionReapproveSchema),
  intent('launch/record', launchRecordSchema), intent('impression/record', impressionRecordSchema),
]);
export type WorkspaceAuthorityIntent = z.infer<typeof workspaceAuthorityIntentSchema>;
export const workspaceAuthorityRequestSchema = z.strictObject({ requestId: id, intent: workspaceAuthorityIntentSchema });
export type WorkspaceAuthorityRequest = z.infer<typeof workspaceAuthorityRequestSchema>;
const authorityMethods = ['workspace/manage','workspace/revision','action/lookup','routine/plan','approved/add','approved/reapprove','launch/record','impression/record'] as const;
export const workspaceAuthorityResultSchema = z.union([
  z.strictObject({ requestId: id, method: z.enum(['workspace/manage','approved/add','approved/reapprove']), ok: z.literal(true), data: workspacePageSchema }),
  success('workspace/revision', revision), success('action/lookup', launchAuthorityActionSchema.nullable()),
  success('routine/plan', routineLaunchPlanSchema.nullable()), success('launch/record', z.strictObject({ recorded: z.boolean() })),
  success('impression/record', z.strictObject({ recorded: revision.max(workspaceLimits.impressionsPerDay) })),
  z.strictObject({ requestId: id, method: z.enum(authorityMethods), ok: z.literal(false), error: workspaceErrorSchema }),
]);
export type WorkspaceAuthorityResult = z.infer<typeof workspaceAuthorityResultSchema>;
export function workspaceAuthorityResultMatches(request: WorkspaceAuthorityRequest, result: WorkspaceAuthorityResult): boolean {
  const input = request.intent;
  if (request.requestId !== result.requestId || input.method !== result.method) return false;
  if (!result.ok) return true;
  if (result.method === 'action/lookup') return input.method === 'action/lookup' && (result.data === null || result.data.id === input.payload.actionId);
  if (result.method === 'routine/plan') return input.method === 'routine/plan' && (result.data === null || result.data.routine.id === input.payload.routineId);
  if (result.method === 'workspace/manage') return input.method === 'workspace/manage' && managementPageMatches(input.payload.intent, result.data);
  if (result.method === 'approved/add') return input.method === 'approved/add' && result.data.revision === input.payload.expectedRevision + 1
    && result.data.actions.some(action => action.approved && action.enabled && action.revision === 0 && action.kind === input.payload.target.kind
      && action.label === input.payload.label && action.recommendable === input.payload.recommendable);
  if (result.method === 'approved/reapprove') return input.method === 'approved/reapprove' && result.data.revision === input.payload.expectedWorkspaceRevision + 1
    && result.data.actions.some(action => action.id === input.payload.actionId && action.approved && action.enabled
      && action.revision === input.payload.expectedActionRevision + 1 && action.kind === input.payload.target.kind);
  if (result.method === 'impression/record') return input.method === 'impression/record' && result.data.recorded <= input.payload.displayed.length;
  return true;
}
