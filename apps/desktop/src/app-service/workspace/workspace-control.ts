import { WorkspaceStorageError } from '@pet-desktop/app-service/workspace-storage';
import type { WorkspaceStorage } from '@pet-desktop/app-service/workspace-storage';
import { workspaceLimits, workspacePageSchema } from '@pet-desktop/contracts/workspace';
import type { AiQuickAction, LaunchAuthorityAction, WorkspacePage } from '@pet-desktop/contracts/workspace';
import type { QuickActionProposal } from '@pet-desktop/contracts/ai';
import {
  approvedActionAddSchema, approvedActionReapproveSchema, impressionRecordSchema, launchRecordSchema,
  routineLaunchPlanSchema, workspaceAuthorityRequestSchema, workspaceAuthorityResultSchema, workspaceManagementIntentSchema,
  workspaceRequestSchema, workspaceResultSchema,
} from '../../shared/workspace-ipc';
import type {
  RoutineLaunchPlan, WorkspaceAuthorityResult, WorkspaceErrorCode, WorkspaceManagementIntent, WorkspaceResult,
} from '../../shared/workspace-ipc';

export interface WorkspaceControlOptions {
  /** Same transaction/single writer as the rest of the application. Never
   * catch a mutation failure within this callback and commit partial writes. */
  transaction<T>(run: (store: WorkspaceStorage) => T): T;
  resolveQuickProposal?(scope: Pick<QuickActionProposal, 'petId' | 'proposalId'>, at: number,
    consume?: Pick<QuickActionProposal, 'targetId' | 'targetRevision' | 'expiresAt'>): QuickActionProposal | null;
  now(): number;
  utcOffsetMinutes(): number;
  createId(kind: 'action' | 'routine' | 'impression'): string;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_CLOCK = 8_640_000_000_000_000 - 86_400_000;

function errorCode(error: unknown): WorkspaceErrorCode {
  if (error instanceof WorkspaceStorageError) {
    switch (error.code) {
      case 'INVALID_RECORD': return 'INVALID_REQUEST';
      case 'INACTIVE': return 'SERVICE_UNAVAILABLE';
      default: return error.code;
    }
  }
  return error instanceof Error && error.name === 'RepositoryUnavailableError' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
}
function checkedId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new WorkspaceStorageError('INVALID_RECORD');
  return value;
}

/** Worker-side authority. No native picker, process, filesystem, network,
 * launch callback or renderer-supplied time is accepted here. */
export class WorkspaceControl {
  private readonly options: WorkspaceControlOptions;
  constructor(options: WorkspaceControlOptions) { this.options = options; }

  private context(): { now: number; offset: number } {
    const now = this.options.now(), offset = this.options.utcOffsetMinutes();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_CLOCK || !Number.isInteger(offset) || offset < -840 || offset > 840) {
      throw new WorkspaceStorageError('INVALID_RECORD');
    }
    return { now, offset };
  }
  private page(store: WorkspaceStorage, clock: { now: number; offset: number }): WorkspacePage {
    return workspacePageSchema.parse(store.getPage(clock.now, clock.offset));
  }
  getPage(): WorkspacePage {
    const clock = this.context();
    return this.options.transaction(store => this.page(store, clock));
  }
  workspaceRevision(): number { return this.options.transaction(store => store.getRevision()); }
  getLaunchAction(actionId: string): LaunchAuthorityAction | null {
    return this.options.transaction(store => store.getLaunchAction(checkedId(actionId)));
  }
  getRoutinePlan(routineId: string): RoutineLaunchPlan | null {
    return this.options.transaction(store => {
      const routine = store.getRoutine(checkedId(routineId));
      return routine === null ? null : routineLaunchPlanSchema.parse({ routine,
        targets: routine.targetIds.map(targetId => ({ targetId, action: store.getLaunchAction(targetId) })) });
    });
  }
  /** AI receives only opt-in eligible stable IDs/labels, never a worker-side
   * ability to resolve an action into a location or dispatch it. */
  listAiActions(): AiQuickAction[] {
    const { now } = this.context();
    return this.options.transaction(store => store.listAiActions(now));
  }

  manage(raw: WorkspaceManagementIntent): WorkspacePage {
    const intent = workspaceManagementIntentSchema.parse(raw), clock = this.context();
    return this.options.transaction(store => {
      switch (intent.method) {
        case 'workspace/list': break;
        case 'action/metadata': {
          const { actionId, expectedRevision, ...metadata } = intent.payload;
          store.updateActionMetadata(actionId, expectedRevision, metadata); break;
        }
        case 'action/revoke': {
          const { actionId, expectedRevision, clearHistory } = intent.payload;
          store.revokeAction(actionId, expectedRevision, clearHistory); break;
        }
        case 'action/delete': {
          const { actionId, expectedRevision } = intent.payload;
          store.deleteAction(actionId, expectedRevision); break;
        }
        case 'routine/create': {
          const { definition, expectedRevision } = intent.payload;
          store.createRoutine(checkedId(this.options.createId('routine')), definition, expectedRevision); break;
        }
        case 'routine/update': {
          const { routineId, expectedRevision, definition } = intent.payload;
          store.updateRoutine(routineId, expectedRevision, definition); break;
        }
        case 'routine/delete': {
          const { routineId, expectedRevision } = intent.payload;
          store.deleteRoutine(routineId, expectedRevision); break;
        }
        case 'recommendation/settings': {
          const { settings, expectedRevision, clearHistory } = intent.payload;
          store.updateSettings(settings, expectedRevision, clock.now, clearHistory); break;
        }
        case 'recommendation/preference': {
          const { preference, expectedRevision } = intent.payload;
          store.setRecommendationPreference(preference, expectedRevision); break;
        }
        case 'history/clear': {
          const { expectedRevision, targetId } = intent.payload;
          store.clearLaunchHistory(expectedRevision, targetId); break;
        }
      }
      return this.page(store, clock);
    });
  }

  /** Only Main may call these after consuming a native approval token. A
   * renderer can provide a safe label and flags but never the target record. */
  addApprovedAction(raw: unknown): WorkspacePage {
    const input = approvedActionAddSchema.parse(raw), clock = this.context();
    return this.options.transaction(store => {
      store.addApprovedAction({ id: checkedId(this.options.createId('action')), target: input.target, label: input.label,
        recommendable: input.recommendable, enabled: true, approvedAt: clock.now }, input.expectedRevision);
      return this.page(store, clock);
    });
  }
  reapproveAction(raw: unknown): WorkspacePage {
    const input = approvedActionReapproveSchema.parse(raw), clock = this.context();
    return this.options.transaction(store => {
      const existing = store.getActionRecord(input.actionId);
      if (existing === null) throw new WorkspaceStorageError('NOT_FOUND');
      // Reapproval binds a fresh native selection, retaining the display label
      // and explicit recommendation preference (revoked records are false).
      store.reapproveAction(existing.id, input.expectedActionRevision, input.expectedWorkspaceRevision, {
        id: existing.id, label: existing.label, target: input.target, approvedAt: clock.now, enabled: true,
        recommendable: existing.recommendable,
      });
      return this.page(store, clock);
    });
  }
  recordOutcome(raw: unknown): boolean {
    const input = launchRecordSchema.parse(raw), clock = this.context();
    const { actionRevision, ...fact } = input;
    // The renderer and native adapter cannot set raw timestamps/offsets. The
    // storage checks consent/current approval and makes first receipt win.
    return this.options.transaction(store => store.recordLaunchOutcome({ ...fact,
      timeBucket: Math.floor(clock.now / workspaceLimits.timeBucketMs) * workspaceLimits.timeBucketMs,
      utcOffsetMinutes: clock.offset }, clock.now, actionRevision));
  }
  recordImpression(raw: unknown): number {
    const input = impressionRecordSchema.parse(raw), clock = this.context();
    return this.options.transaction(store => {
      if (store.getRevision() !== input.expectedRevision) throw new WorkspaceStorageError('REVISION_CONFLICT');
      // Main reports actual displayed recommendations only. Recompute the
      // current set in this transaction; a fabricated/stale one cannot spend
      // today's budget. Duplicate impression IDs are storage-idempotent.
      const eligible = new Set(store.listRecommendations(clock.now, clock.offset).map(row => row.targetId));
      if (input.displayed.some(row => !eligible.has(row.targetId))) return 0;
      let recorded = 0;
      for (const row of input.displayed) if (store.recordRecommendationImpression(row.impressionId, clock.now, clock.offset)) recorded++;
      return recorded;
    });
  }

  /** Defensive management-only entry for tests/host; the actual native
   * selection/launch/record operations must use the privileged Main channel. */
  handleIntent(raw: unknown): WorkspaceResult {
    const parsed = workspaceRequestSchema.safeParse(raw);
    if (!parsed.success) return { requestId: 'invalid-request', method: 'workspace/list', ok: false, error: { code: 'INVALID_REQUEST' } };
    const { requestId, intent } = parsed.data;
    const management = workspaceManagementIntentSchema.safeParse(intent);
    if (!management.success) return { requestId, method: intent.method, ok: false, error: { code: 'FORBIDDEN' } };
    try { return workspaceResultSchema.parse({ requestId, method: intent.method, ok: true, data: this.manage(management.data) }); }
    catch (error) { return { requestId, method: intent.method, ok: false, error: { code: errorCode(error) } }; }
  }

  /** Closed Main→worker request dispatcher. Keep this channel out of preload. */
  handleAuthority(raw: unknown): WorkspaceAuthorityResult {
    const parsed = workspaceAuthorityRequestSchema.safeParse(raw);
    if (!parsed.success) return { requestId: 'invalid-request', method: 'workspace/revision', ok: false, error: { code: 'INVALID_REQUEST' } };
    const { requestId, intent } = parsed.data;
    try {
      let data: unknown;
      switch (intent.method) {
        case 'workspace/manage': data = this.manage(intent.payload.intent); break;
        case 'workspace/revision': data = this.workspaceRevision(); break;
        case 'action/lookup': data = this.getLaunchAction(intent.payload.actionId); break;
        case 'suggestion/lookup': data = this.options.resolveQuickProposal?.(intent.payload, this.context().now) ?? null; break;
        case 'suggestion/consume': {
          const payload = intent.payload;
          data = this.options.resolveQuickProposal?.(payload, this.context().now, payload) ? payload : null;
          break;
        }
        case 'routine/plan': data = this.getRoutinePlan(intent.payload.routineId); break;
        case 'approved/add': data = this.addApprovedAction(intent.payload); break;
        case 'approved/reapprove': data = this.reapproveAction(intent.payload); break;
        case 'launch/record': data = { recorded: this.recordOutcome(intent.payload) }; break;
        case 'impression/record': data = { recorded: this.recordImpression(intent.payload) }; break;
      }
      return workspaceAuthorityResultSchema.parse({ requestId, method: intent.method, ok: true, data });
    } catch (error) { return { requestId, method: intent.method, ok: false, error: { code: errorCode(error) } }; }
  }
}
