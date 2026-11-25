import { randomBytes, randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { workspaceLimits } from '@pet-desktop/contracts/workspace';
import type { LaunchAuthorityAction } from '@pet-desktop/contracts/workspace';
import {
  workspaceAuthorityRequestSchema, workspaceAuthorityResultMatches, workspaceAuthorityResultSchema,
  workspaceManagementIntentSchema, workspaceRequestSchema, workspaceResultMatches, workspaceResultSchema,
} from '../shared/workspace-ipc';
import type {
  LaunchRecord, RoutineLaunchPlan, WorkspaceAuthorityIntent, WorkspaceAuthorityRequest, WorkspaceAuthorityResult,
  WorkspaceErrorCode, WorkspaceIntent, WorkspaceRequest, WorkspaceResult, WorkspaceSelection,
} from '../shared/workspace-ipc';
import { normalizeHttpsTarget, QuickLaunchPolicy, quickLaunchLimits } from './quick-launch-policy';
import type { QuickLaunchFsPort, QuickLaunchPorts, QuickLaunchSender, QuickTargetPreview } from './quick-launch-policy';
import { RoutineLaunchCoordinator } from './routine-launch-coordinator';
import { createWindowsLaunchAdapters } from './windows-launch-adapter';
import type { WindowsLaunchAdaptersOptions, WindowsLaunchNativeDialog } from './windows-launch-adapter';

export interface WorkspaceHostOptions extends Omit<WindowsLaunchAdaptersOptions, 'host'> {
  /** Only the trusted Main sender/document registry; never renderer supplied. */
  senderIsCurrent(sender: QuickLaunchSender): boolean | Promise<boolean>;
  parentFor(sender: QuickLaunchSender): BrowserWindow | null;
  /** Main → current worker generation, not renderer/preload exposed. */
  requestAuthority(request: WorkspaceAuthorityRequest, signal: AbortSignal): Promise<unknown>;
  now?(): number;
  tokenEntropy?(): string;
  createRunId?(): string;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PENDING = 16, MAX_DOCUMENT_REQUESTS = 30_000, MAX_ROUTINE_DETAIL = 8192;
interface DocumentState {
  documentId: string; revoked: boolean; used: Set<string>;
  offeredRecommendations: { revision: number; ids: Set<string> } | null;
  seenRecommendations: Set<string>; lastShownToday: number;
}
interface BoundSelection {
  sender: QuickLaunchSender; workspaceRevision: number; expiresAt: number; preview: QuickTargetPreview;
}
interface PendingHttps { sender: QuickLaunchSender; raw: string }
const fail = (request: WorkspaceRequest, code: WorkspaceErrorCode): WorkspaceResult =>
  ({ requestId: request.requestId, method: request.intent.method, ok: false, error: { code } });
function sameSender(a: QuickLaunchSender, b: QuickLaunchSender): boolean {
  return a.senderId === b.senderId && a.documentId === b.documentId && a.role === b.role;
}
function validSender(value: QuickLaunchSender | null): value is QuickLaunchSender {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 3 && value.role === 'control-center'
    && Number.isSafeInteger(value.senderId) && value.senderId > 0 && typeof value.documentId === 'string' && ID.test(value.documentId);
}
const safeUint = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Native helper is single-flight; serialize bounded read-only inspection
 * calls for parallel routines. Never queue a deferred OS launch. */
function serialFs(fs: QuickLaunchFsPort): QuickLaunchFsPort {
  let tail: Promise<unknown> = Promise.resolve(), pending = 0;
  function enqueue<T>(signal: AbortSignal, unavailable: T, task: () => Promise<T>): Promise<T> {
    if (signal.aborted || pending >= MAX_PENDING) return Promise.resolve(unavailable);
    pending++;
    const next = tail.then(() => signal.aborted ? unavailable : task()).catch(() => unavailable);
    tail = next;
    return next.finally(() => { pending--; });
  }
  return {
    driveType: (root, signal) => enqueue(signal, 'UNKNOWN' as const, () => fs.driveType(root, signal)),
    inspect: (path, signal) => enqueue(signal, null, () => fs.inspect(path, signal)),
    hashExecutable: (path, maxBytes, signal) => enqueue(signal, null, () => fs.hashExecutable(path, maxBytes, signal)),
  };
}

function outcome(value: 'accepted' | 'failed' | 'unknown'): LaunchRecord['outcome'] {
  return value === 'accepted' ? 'ACCEPTED' : value === 'failed' ? 'FAILED' : 'UNKNOWN';
}
/** Render only the basename or hostname, never a path, full URL, query,
 * fragment, identity or digest in the public response. */
function selectionView(token: string, selection: BoundSelection): WorkspaceSelection {
  const { kind, locator } = selection.preview;
  const label = kind === 'HTTPS' ? new URL(locator).hostname : locator.length === 3 ? '本机目录' : locator.split('\\').at(-1)!;
  const suggestedLabel = label.slice(0, workspaceLimits.label).replace(/[\uD800-\uDBFF]$/u, '');
  return { approvalToken: token, expiresAt: selection.expiresAt, kind, suggestedLabel, preview: label };
}
function targetIdentity(action: LaunchAuthorityAction): string {
  return action.kind === 'HTTPS' ? 'HTTPS:' + action.fingerprint.canonicalUrl
    : action.kind + ':' + action.fingerprint.identity.volumeSerial + ':' + action.fingerprint.identity.fileId;
}

/** This host owns the only renderer→native-workspace boundary. Authority
 * mutations are closed and validated; neither AI nor arbitrary paths/args
 * can request process dispatch. No automatic start, no persisted approvals
 * in Main, no action retries, no recording of inferred external activity. */
export class WorkspaceHost {
  private readonly options: WorkspaceHostOptions;
  private readonly policy: QuickLaunchPolicy;
  private readonly routines: RoutineLaunchCoordinator;
  private readonly documents = new Map<number, DocumentState>();
  private readonly selections = new Map<string, BoundSelection>();
  private readonly authorityCalls = new Set<AbortController>();
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly nativeDialog: WindowsLaunchNativeDialog;
  private closed = false;
  private nativeBusy = false;
  private nativeModalActive = false;
  private impressionBusy = false;
  private pending = 0;
  private manualHttps: PendingHttps | null = null;

  constructor(options: WorkspaceHostOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.createRunId = options.createRunId ?? (() => 'run-' + randomUUID());
    // A cancelled/timed-out routine cannot close an existing OS dialog.
    // Hold this guard until the actual native promise settles, so another
    // request cannot stack a second confirmation above the old one.
    this.nativeDialog = {
      showOpenDialog: async (parent, input) => {
        if (this.nativeModalActive || this.closed) return { canceled: true, filePaths: [] };
        this.nativeModalActive = true;
        try { return await options.nativeDialog.showOpenDialog(parent, input); }
        finally { this.nativeModalActive = false; }
      },
      showMessageBox: async (parent, input) => {
        if (this.nativeModalActive || this.closed) return { response: 0 };
        this.nativeModalActive = true;
        try { return await options.nativeDialog.showMessageBox(parent, input); }
        finally { this.nativeModalActive = false; }
      },
    };
    const adapters = createWindowsLaunchAdapters({
      resourcesDirectory: options.resourcesDirectory, expectedInspectorSha256: options.expectedInspectorSha256,
      nativeDialog: this.nativeDialog, nativeShell: options.nativeShell,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.spawnProcess !== undefined ? { spawnProcess: options.spawnProcess } : {}),
      host: {
        senderIsCurrent: sender => this.current(sender), parentFor: sender => this.options.parentFor(sender),
        loadSavedAction: (id, signal) => this.lookupAction(id, signal),
        takeManualHttpsInput: async sender => {
          const candidate = this.manualHttps;
          if (candidate === null || !sameSender(candidate.sender, sender)) return null;
          this.manualHttps = null; // consumed once, even if stale or rejected
          return await this.current(sender) ? candidate.raw : null;
        },
      },
    });
    const quick: QuickLaunchPorts = {
      fs: serialFs(adapters.fs), dialog: adapters.dialog, launcher: adapters.launcher,
      authority: { senderIsCurrent: sender => this.current(sender), loadSavedAction: (id, signal) => this.lookupAction(id, signal),
        workspaceRevision: async signal => {
          const reply = await this.request({ method: 'workspace/revision', payload: {} }, signal);
          return reply?.ok && reply.method === 'workspace/revision' ? reply.data : null;
        } },
      now: this.now, tokenEntropy: options.tokenEntropy ?? (() => randomBytes(32).toString('hex')),
    };
    this.policy = new QuickLaunchPolicy(quick);
    this.routines = new RoutineLaunchCoordinator({
      quickLaunch: quick, createRunId: this.createRunId,
      loadRoutinePlan: async (routineId, signal) => {
        const reply = await this.request({ method: 'routine/plan', payload: { routineId } }, signal);
        return reply?.ok && reply.method === 'routine/plan' ? reply.data : null;
      },
      confirmRoutine: (plan, sender, signal) => this.confirmRoutine(plan, sender, signal),
      recordOutcome: fact => this.record(fact),
    });
  }

  /** Bind a request only after Main verifies current top frame + document;
   * subsequent async policy checks also require this non-revoked binding. */
  private async bind(sender: QuickLaunchSender): Promise<DocumentState | null> {
    if (this.closed || !validSender(sender)) return null;
    try {
      if (await this.options.senderIsCurrent(sender) !== true || this.closed) return null;
      const previous = this.documents.get(sender.senderId);
      if (previous?.documentId === sender.documentId) return previous.revoked ? null : previous;
      if (previous) this.revokeSender(sender.senderId, previous.documentId);
      // Main has only a bounded set of native Control Center windows.
      if (!previous && this.documents.size >= 16) {
        const obsolete = [...this.documents.entries()].find(([, state]) => state.revoked);
        if (!obsolete) return null;
        this.documents.delete(obsolete[0]);
      }
      const state: DocumentState = { documentId: sender.documentId, revoked: false, used: new Set(), offeredRecommendations: null,
        seenRecommendations: new Set(), lastShownToday: 0 };
      this.documents.set(sender.senderId, state);
      return state;
    } catch { return null; }
  }
  private async current(sender: QuickLaunchSender): Promise<boolean> {
    if (this.closed || !validSender(sender)) return false;
    const bound = this.documents.get(sender.senderId);
    if (!bound || bound.revoked || bound.documentId !== sender.documentId) return false;
    try { return await this.options.senderIsCurrent(sender) === true && !this.closed && !bound.revoked
      && this.documents.get(sender.senderId) === bound; } catch { return false; }
  }
  private boundCurrent(sender: QuickLaunchSender): boolean {
    const state = this.documents.get(sender.senderId);
    return !this.closed && state !== undefined && !state.revoked && state.documentId === sender.documentId;
  }
  private async parent(sender: QuickLaunchSender): Promise<BrowserWindow | null> {
    if (!await this.current(sender)) return null;
    try {
      const parent = this.options.parentFor(sender);
      return parent && !parent.isDestroyed() && parent.webContents.id === sender.senderId ? parent : null;
    } catch { return null; }
  }

  /** Exact authority request and response correlation + bounded wait. A
   * timed-out mutation may have committed; do not retry it automatically. */
  private async request(intent: WorkspaceAuthorityIntent, signal?: AbortSignal, sender?: QuickLaunchSender): Promise<WorkspaceAuthorityResult | null> {
    if (this.closed || signal?.aborted || (sender !== undefined && !this.boundCurrent(sender)) || this.authorityCalls.size >= MAX_PENDING) return null;
    const request = workspaceAuthorityRequestSchema.safeParse({ requestId: 'workspace-' + randomUUID(), intent });
    if (!request.success) return null;
    const controller = new AbortController();
    this.authorityCalls.add(controller);
    return new Promise(resolve => {
      let done = false;
      const finish = (reply: WorkspaceAuthorityResult | null) => {
        if (done) return;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', abort); this.authorityCalls.delete(controller); resolve(reply);
      };
      const abort = () => { finish(null); controller.abort(); };
      const timer = setTimeout(abort, quickLaunchLimits.authorityTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      controller.signal.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || this.closed) { abort(); return; }
      void Promise.resolve().then(() => {
        if (controller.signal.aborted || (sender !== undefined && !this.boundCurrent(sender))) return null;
        return this.options.requestAuthority(request.data, controller.signal);
      }).then(raw => {
        if (controller.signal.aborted || this.closed) { finish(null); return; }
        const parsed = workspaceAuthorityResultSchema.safeParse(raw);
        finish(parsed.success && workspaceAuthorityResultMatches(request.data, parsed.data) ? parsed.data : null);
      }, () => finish(null)).catch(() => finish(null));
    });
  }
  private async lookupAction(actionId: string, signal: AbortSignal): Promise<LaunchAuthorityAction | null> {
    const reply = await this.request({ method: 'action/lookup', payload: { actionId } }, signal);
    return reply?.ok && reply.method === 'action/lookup' ? reply.data : null;
  }
  private async record(fact: LaunchRecord): Promise<void> {
    // Authority atomically checks opt-in, current action approval/revision
    // and idempotent receipt. No renderer-inferred usage or path is recorded.
    if (fact.outcome !== 'SKIPPED') await this.request({ method: 'launch/record', payload: fact });
  }
  private async confirm(sender: QuickLaunchSender, message: string, detail: string, verb: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || detail.length > MAX_ROUTINE_DETAIL) return false;
    const parent = await this.parent(sender);
    if (!parent || signal?.aborted || (this.options.platform ?? process.platform) !== 'win32') return false;
    try {
      const reply = await this.nativeDialog.showMessageBox(parent, { type: 'question', title: '桌宠快捷工作台',
        message, detail, buttons: ['取消', verb], defaultId: 0, cancelId: 0, noLink: true });
      return reply.response === 1 && !signal?.aborted && await this.parent(sender) === parent;
    } catch { return false; }
  }
  private async confirmRoutine(plan: RoutineLaunchPlan, sender: QuickLaunchSender, signal: AbortSignal): Promise<boolean> {
    const seen = new Set<string>();
    const { routine } = plan;
    const lines = plan.targets.map(({ targetId, action }, index) => {
      const lead = (index + 1) + '. ';
      if (!action || !action.enabled) return lead + (action?.label ?? targetId) + '（不可用，跳过）' + (action ? '\n' + action.locator : '');
      const key = targetIdentity(action), duplicate = seen.has(key);
      seen.add(key);
      return lead + action.label + (duplicate ? '（重复，跳过）' : '') + '\n' + action.locator;
    });
    const detail = [
      '版本 ' + routine.revision,
      '运行模式：' + (routine.mode === 'SEQUENTIAL' ? '顺序' : '并行') + '，延迟 ' + routine.delayMs + ' 毫秒',
      '失败策略：' + (routine.failurePolicy === 'STOP' ? '停止后续' : '继续') + '；跳过重复项',
      ...lines, '仅本次运行；系统接收请求不代表应用已就绪。',
    ].join('\n\n');
    return this.confirm(sender, '运行「' + routine.name + '」的以下入口？', detail, '运行', signal);
  }
  private purgeSelections(): void {
    const now = this.now();
    for (const [token, selection] of this.selections) if (!safeUint(now) || now >= selection.expiresAt) this.selections.delete(token);
  }
  private takeSelection(token: string, sender: QuickLaunchSender, revision: number): BoundSelection | WorkspaceErrorCode {
    const selection = this.selections.get(token);
    if (!selection || !sameSender(sender, selection.sender)) return 'APPROVAL_INVALID';
    this.selections.delete(token); // true sender consumes once before await
    if (!safeUint(this.now()) || this.now() >= selection.expiresAt) return 'APPROVAL_EXPIRED';
    if (selection.workspaceRevision !== revision) return 'REVISION_CONFLICT';
    return selection;
  }
  private async finalize(request: WorkspaceRequest & { intent: Extract<WorkspaceIntent, { method: 'action/add' | 'action/reapprove' }> },
    sender: QuickLaunchSender): Promise<WorkspaceResult> {
    const intent = request.intent;
    const revision = intent.method === 'action/add' ? intent.payload.expectedRevision : intent.payload.expectedWorkspaceRevision;
    const selected = this.takeSelection(intent.payload.approvalToken, sender, revision);
    if (typeof selected === 'string') return fail(request, selected);
    if (intent.method === 'action/reapprove') {
      // Native selection did not bind an existing action ID. A second native
      // confirmation must display that exact existing action and new target.
      // ConsumeAdd after this modal rechecks expiry, revision and fingerprint.
      const page = await this.request({ method: 'workspace/manage', payload: { intent: { method: 'workspace/list', payload: {} } } }, undefined, sender);
      if (!page?.ok || page.method !== 'workspace/manage') return fail(request, 'SERVICE_UNAVAILABLE');
      const current = page.data.actions.find(action => action.id === intent.payload.actionId);
      if (!current) return fail(request, 'NOT_FOUND');
      if (page.data.revision !== revision || current.revision !== intent.payload.expectedActionRevision) return fail(request, 'REVISION_CONFLICT');
      if (!await this.confirm(sender, '重新批准「' + current.label + '」并替换目标？', selected.preview.locator + '\n\n仅批准此入口的确切新目标。', '替换')) return fail(request, 'CANCELLED');
    }
    const consumed = await this.policy.consumeAdd(intent.payload.approvalToken, { sender, expectedRevision: revision });
    if (!consumed.ok) return fail(request, consumed.code);
    if (consumed.target.kind !== selected.preview.kind || consumed.target.locator !== selected.preview.locator || !await this.current(sender))
      return fail(request, 'FORBIDDEN');
    const authority = intent.method === 'action/add'
      ? await this.request({ method: 'approved/add', payload: { target: consumed.target, label: intent.payload.label,
        recommendable: intent.payload.recommendable, expectedRevision: revision } }, undefined, sender)
      : await this.request({ method: 'approved/reapprove', payload: { target: consumed.target, actionId: intent.payload.actionId,
        expectedActionRevision: intent.payload.expectedActionRevision, expectedWorkspaceRevision: revision } }, undefined, sender);
    if (!authority) return fail(request, 'SERVICE_UNAVAILABLE');
    if (!authority.ok) return fail(request, authority.error.code);
    if (authority.method !== 'approved/add' && authority.method !== 'approved/reapprove') return fail(request, 'SERVICE_UNAVAILABLE');
    return { requestId: request.requestId, method: intent.method, ok: true, data: authority.data };
  }
  private async native(request: WorkspaceRequest, sender: QuickLaunchSender): Promise<WorkspaceResult> {
    const intent = request.intent;
    if (this.nativeBusy || this.nativeModalActive) return fail(request, 'BUSY');
    this.nativeBusy = true;
    try {
      if (!await this.current(sender)) return fail(request, 'FORBIDDEN');
      switch (intent.method) {
        case 'action/select': {
          this.purgeSelections();
          if (this.selections.size >= quickLaunchLimits.pendingApprovals) return fail(request, 'BUSY');
          if (intent.payload.kind === 'HTTPS') {
            const raw = 'manualHttpsUrl' in intent.payload ? intent.payload.manualHttpsUrl : null;
            if (typeof raw !== 'string' || normalizeHttpsTarget(raw) === null) return fail(request, 'INVALID_TARGET');
            // This renderer-supplied text is only a user preview candidate.
            // QuickLaunchPolicy canonicalizes it and native modal independently
            // discloses the full URL. It cannot directly dispatch or persist.
            this.manualHttps = { sender, raw };
          }
          const prepared = await this.policy.prepareAdd(intent.payload.kind, { sender, expectedRevision: intent.payload.expectedRevision });
          if (!prepared.ok) return fail(request, prepared.code);
          if (!await this.current(sender)) return fail(request, 'FORBIDDEN');
          const selection: BoundSelection = { sender, workspaceRevision: intent.payload.expectedRevision,
            expiresAt: prepared.expiresAt, preview: prepared.preview };
          this.selections.set(prepared.token, selection);
          return { requestId: request.requestId, method: 'action/select', ok: true, data: selectionView(prepared.token, selection) };
        }
        case 'action/add':
        case 'action/reapprove': return await this.finalize({ ...request, intent }, sender);
        case 'action/run': {
          const runId = this.createRunId();
          if (!ID.test(runId)) return fail(request, 'SERVICE_UNAVAILABLE');
          const { actionId, expectedRevision } = intent.payload;
          const result = await this.policy.launchSavedAction(actionId, { sender, expectedRevision });
          if (!result.ok) return fail(request, result.code);
          const resolved = outcome(result.outcome);
          await this.record({ targetId: actionId, actionRevision: expectedRevision, runId, source: 'MANUAL', outcome: resolved });
          return { requestId: request.requestId, method: 'action/run', ok: true, data: { runId, targetId: actionId, outcome: resolved } };
        }
        case 'suggestion/run': {
          const found = await this.request({ method: 'suggestion/lookup', payload: intent.payload }, undefined, sender);
          if (!found?.ok || found.method !== 'suggestion/lookup') return fail(request, 'SERVICE_UNAVAILABLE');
          const proposal = found.data;
          if (!proposal || proposal.expiresAt <= this.now() || !await this.current(sender)) return fail(request, 'APPROVAL_EXPIRED');

          const { targetId, targetRevision, expiresAt, petId, proposalId } = proposal;
          const runId = this.createRunId();
          if (!ID.test(runId)) return fail(request, 'SERVICE_UNAVAILABLE');
          const monotonicExpiry = performance.now() + Math.max(0, expiresAt - this.now());
          const current = () => this.boundCurrent(sender) && this.now() < expiresAt && performance.now() < monotonicExpiry;
          const result = await this.policy.launchSavedAction(targetId, { sender, expectedRevision: targetRevision }, {
            current,
            consume: async () => {
              if (!current() || !await this.current(sender)) return false;
              const consumed = await this.request({ method: 'suggestion/consume',
                payload: { petId, proposalId, targetId, targetRevision, expiresAt } }, undefined, sender);
              return consumed?.ok === true && consumed.method === 'suggestion/consume' && consumed.data !== null;
            },
          });
          if (!result.ok) return fail(request, result.code);
          const resolved = outcome(result.outcome);
          await this.record({ targetId, actionRevision: targetRevision, runId, source: 'SUGGESTION', outcome: resolved });
          return { requestId: request.requestId, method: 'suggestion/run', ok: true, data: { runId, targetId, petId, proposalId, outcome: resolved } };
        }
        case 'routine/run': {
          const result = await this.routines.run(intent.payload, sender);
          return result.ok ? { requestId: request.requestId, method: 'routine/run', ok: true, data: result.result }
            : fail(request, result.code);
        }
        default: return fail(request, 'INVALID_REQUEST');
      }
    } finally { this.nativeBusy = false; this.manualHttps = null; }
  }

  private async seen(request: WorkspaceRequest & { intent: Extract<WorkspaceIntent, { method: 'recommendation/seen' }> },
    sender: QuickLaunchSender, document: DocumentState): Promise<WorkspaceResult> {
    if (this.impressionBusy) return fail(request, 'BUSY');
    const { expectedRevision, targetIds } = request.intent.payload;
    const offered = document.offeredRecommendations;
    if (!offered || offered.revision !== expectedRevision || targetIds.some(id => !offered.ids.has(id)))
      return fail(request, 'REVISION_CONFLICT');
    // One acknowledgement only for a recommendation actually returned to
    // this document. Main cannot independently attest the pixels; the trusted
    // UI visibility path reports them, and storage rechecks eligibility/cap.
    for (const id of targetIds) {
      offered.ids.delete(id);
      if (document.seenRecommendations.size >= workspaceLimits.actions) {
        const oldest = document.seenRecommendations.values().next().value;
        if (oldest !== undefined) document.seenRecommendations.delete(oldest);
      }
      document.seenRecommendations.add(id);
    }
    this.impressionBusy = true;
    try {
      const listIntent = { method: 'workspace/manage', payload: { intent: { method: 'workspace/list', payload: {} } } } as const;
      const page = await this.request(listIntent, undefined, sender);
      if (!page?.ok || page.method !== 'workspace/manage') return fail(request, 'SERVICE_UNAVAILABLE');
      const eligible = new Set(page.data.recommendations.map(row => row.targetId));
      if (page.data.revision !== expectedRevision || !page.data.settings.enabled || targetIds.some(id => !eligible.has(id))
        || page.data.shownToday + targetIds.length > workspaceLimits.impressionsPerDay) return fail(request, 'REVISION_CONFLICT');
      if (!await this.current(sender)) return fail(request, 'FORBIDDEN');
      const recorded = await this.request({ method: 'impression/record', payload: { expectedRevision,
        displayed: targetIds.map(targetId => ({ targetId, impressionId: 'impression-' + randomUUID() })) } }, undefined, sender);
      if (!recorded) return fail(request, 'SERVICE_UNAVAILABLE');
      if (!recorded.ok) return fail(request, recorded.error.code);
      if (recorded.method !== 'impression/record' || recorded.data.recorded !== targetIds.length) return fail(request, 'REVISION_CONFLICT');
      const updated = await this.request(listIntent, undefined, sender);
      if (!updated?.ok || updated.method !== 'workspace/manage') return fail(request, 'SERVICE_UNAVAILABLE');
      if (updated.data.revision !== expectedRevision || updated.data.shownToday < page.data.shownToday + targetIds.length)
        return fail(request, 'REVISION_CONFLICT');
      return { requestId: request.requestId, method: 'recommendation/seen', ok: true, data: updated.data };
    } finally { this.impressionBusy = false; }
  }

  /** Null means malformed request, so no untrusted ID/method is reflected.
   * A valid request always gets an exact closed correlated public result. */
  async handle(raw: unknown, sender: QuickLaunchSender | null): Promise<WorkspaceResult | null> {
    const parsed = workspaceRequestSchema.safeParse(raw);
    if (!parsed.success) return null;
    const request = parsed.data;
    if (this.closed) return fail(request, 'SERVICE_UNAVAILABLE');
    if (!validSender(sender)) return fail(request, 'FORBIDDEN');
    sender = Object.freeze({ ...sender });
    if (this.pending >= MAX_PENDING + (request.intent.method === 'routine/cancel' ? 1 : 0)) return fail(request, 'BUSY');
    this.pending++;
    try {
      const document = await this.bind(sender);
      if (!document || !await this.current(sender)) return fail(request, 'FORBIDDEN');
      if (document.used.has(request.requestId)) return fail(request, 'INVALID_REQUEST');
      if (document.used.size >= MAX_DOCUMENT_REQUESTS) return fail(request, 'BUSY');
      document.used.add(request.requestId);
      let result: WorkspaceResult;
      if (request.intent.method === 'routine/cancel') {
        result = { requestId: request.requestId, method: 'routine/cancel', ok: true,
          data: { cancelled: this.routines.cancel(request.intent.payload.routineId, sender) } };
      } else if (request.intent.method === 'recommendation/seen') {
        result = await this.seen({ ...request, intent: request.intent }, sender, document);
      } else {
        const management = workspaceManagementIntentSchema.safeParse(request.intent);
        if (management.success) {
          const authority = await this.request({ method: 'workspace/manage', payload: { intent: management.data } }, undefined, sender);
          if (!authority) result = fail(request, 'SERVICE_UNAVAILABLE');
          else if (!authority.ok) result = fail(request, authority.error.code);
          else if (authority.method !== 'workspace/manage') result = fail(request, 'SERVICE_UNAVAILABLE');
          else result = { requestId: request.requestId, method: management.data.method, ok: true, data: authority.data };
        } else result = await this.native(request, sender);
      }
      if (!await this.current(sender)) return fail(request, 'FORBIDDEN');
      const checked = workspaceResultSchema.safeParse(result);
      if (!checked.success || !workspaceResultMatches(request, checked.data)) return fail(request, 'SERVICE_UNAVAILABLE');
      if (checked.data.ok && 'recommendations' in checked.data.data) {
        const page = checked.data.data;
        if (page.shownToday < document.lastShownToday) document.seenRecommendations.clear();
        document.lastShownToday = page.shownToday;
        document.offeredRecommendations = { revision: page.revision,
          ids: new Set(page.recommendations.map(row => row.targetId).filter(id => !document.seenRecommendations.has(id))) };
      }
      return checked.data;
    } catch { return fail(request, 'SERVICE_UNAVAILABLE'); }
    finally { this.pending--; }
  }

  revokeSender(senderId: number, documentId?: string): void {
    const doc = this.documents.get(senderId);
    if (doc && (documentId === undefined || doc.documentId === documentId)) doc.revoked = true;
    for (const [token, selection] of this.selections) if (selection.sender.senderId === senderId
      && (documentId === undefined || selection.sender.documentId === documentId)) this.selections.delete(token);
    if (this.manualHttps?.sender.senderId === senderId && (documentId === undefined || this.manualHttps.sender.documentId === documentId))
      this.manualHttps = null;
    this.policy.revokeSender(senderId, documentId); this.routines.revokeSender(senderId, documentId);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.selections.clear(); this.manualHttps = null;
    for (const state of this.documents.values()) state.revoked = true;
    for (const controller of [...this.authorityCalls]) controller.abort();
    this.policy.clear(); this.routines.close();
  }
}
