import { workspaceRunRoutineIntentSchema } from '@pet-desktop/contracts/workspace';
import type { LaunchAuthorityAction } from '@pet-desktop/contracts/workspace';
import { routineLaunchPlanSchema, routineRunResultSchema } from '../shared/workspace-ipc';
import type { LaunchRecord, RoutineLaunchPlan, RoutineRunResult, RoutineTargetResult, WorkspaceErrorCode } from '../shared/workspace-ipc';
import { QuickLaunchPolicy, quickLaunchLimits } from './quick-launch-policy';
import type { QuickLaunchPorts, QuickLaunchSender, QuickRunResult } from './quick-launch-policy';

/** Only Main supplies these ports. A native confirmation must show the exact
 * ordered saved targets, including unavailable/duplicate entries, revision,
 * mode, delay and failure policy. Never substitute a renderer boolean. */
export interface RoutineLaunchPorts {
  readonly quickLaunch: QuickLaunchPorts;
  loadRoutinePlan(routineId: string, signal: AbortSignal): Promise<RoutineLaunchPlan | null>;
  confirmRoutine(plan: RoutineLaunchPlan, sender: QuickLaunchSender, signal: AbortSignal): Promise<boolean>;
  createRunId(): string;
  /** Optional authority recording; history is disabled by default in storage. */
  recordOutcome?(fact: LaunchRecord): Promise<unknown>;
  /** Optional deterministic wait for tests. Must honor cancellation. */
  delay?(ms: number, signal: AbortSignal): Promise<void>;
}
export type RoutineRunOutcome = { readonly ok: true; readonly result: RoutineRunResult } | { readonly ok: false; readonly code: WorkspaceErrorCode };
const fail = (code: WorkspaceErrorCode): RoutineRunOutcome => ({ ok: false, code });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONFIRM_TIMEOUT_MS = 120_000;
export const routineLaunchLimits = Object.freeze({ parallelism: 3, confirmationTimeoutMs: CONFIRM_TIMEOUT_MS });

interface ActiveRun {
  readonly sender: QuickLaunchSender;
  readonly routineId: string;
  readonly expectedRevision: number;
  readonly controller: AbortController;
  readonly permits: Map<string, number>;
  plan: RoutineLaunchPlan | null;
  fingerprint: string | null;
  cancelled: boolean;
  changed: boolean;
}
function sameSender(a: QuickLaunchSender, b: QuickLaunchSender): boolean {
  return a.role === b.role && a.senderId === b.senderId && a.documentId === b.documentId;
}
function validSender(raw: QuickLaunchSender): boolean {
  return raw !== null && typeof raw === 'object' && Object.keys(raw).length === 3 && raw.role === 'control-center'
    && Number.isSafeInteger(raw.senderId) && raw.senderId > 0 && typeof raw.documentId === 'string' && ID.test(raw.documentId);
}
function identity(action: LaunchAuthorityAction): string {
  // Separate target kind, dedupe canonical HTTPS or exact native file
  // identity (also covers distinct saved aliases of the same application).
  if (action.kind === 'HTTPS') return `HTTPS:${action.fingerprint.canonicalUrl}`;
  return `${action.kind}:${action.fingerprint.identity.volumeSerial}:${action.fingerprint.identity.fileId}`;
}
type Bounded<T> = { kind: 'OK'; value: T } | { kind: 'FAILED' | 'TIMEOUT' | 'CANCELLED' };
async function bounded<T>(ms: number, parent: AbortSignal, task: (signal: AbortSignal) => Promise<T> | T): Promise<Bounded<T>> {
  if (parent.aborted) return { kind: 'CANCELLED' };
  const child = new AbortController();
  return new Promise(resolve => {
    let done = false;
    const finish = (result: Bounded<T>): void => {
      if (done) return;
      done = true; clearTimeout(timer); parent.removeEventListener('abort', onAbort);
      if (result.kind !== 'OK') child.abort();
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: 'CANCELLED' });
    const timer = setTimeout(() => finish({ kind: 'TIMEOUT' }), ms);
    parent.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (child.signal.aborted) return undefined;
      return task(child.signal);
    }).then(value => { if (!child.signal.aborted) finish({ kind: 'OK', value: value as T }); }, () => finish({ kind: 'FAILED' }));
  });
}
function timedDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms === 0) return Promise.resolve();
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function skipped(targetId: string, reason: Exclude<RoutineTargetResult['reason'], null>): RoutineTargetResult {
  return { targetId, outcome: 'SKIPPED', reason };
}
function dispatched(targetId: string, result: QuickRunResult): RoutineTargetResult {
  if (!result.ok) return skipped(targetId, result.code === 'TARGET_CHANGED' || result.code === 'REVISION_CONFLICT' ? 'CHANGED' : 'POLICY_DENIED');
  return { targetId, outcome: result.outcome === 'accepted' ? 'ACCEPTED' : result.outcome === 'failed' ? 'FAILED' : 'UNKNOWN', reason: null };
}

/** A one-shot user-approved batch, not a scheduler. No automatic startup,
 * model path, arbitrary arguments, retries or program termination. This
 * coordinator holds its own private policy instance; routine permits cannot
 * be stolen by concurrent manual action IPC on another policy instance. */
export class RoutineLaunchCoordinator {
  private readonly ports: RoutineLaunchPorts;
  private readonly policy: QuickLaunchPolicy;
  private active: ActiveRun | null = null;
  private closed = false;

  constructor(ports: RoutineLaunchPorts) {
    this.ports = ports;
    const quick = ports.quickLaunch;
    this.policy = new QuickLaunchPolicy({ ...quick,
      dialog: { selectTarget: quick.dialog.selectTarget.bind(quick.dialog), confirmAdd: quick.dialog.confirmAdd.bind(quick.dialog),
        consumeSavedUserClick: (id, revision, sender) => this.consumePermit(id, revision, sender) },
      authority: {
        workspaceRevision: quick.authority.workspaceRevision.bind(quick.authority),
        senderIsCurrent: sender => this.senderCurrent(sender),
        // The existing single-target policy already re-loads before its final
        // adapter invocation. Use the whole exact routine on *each* of those
        // reads, not just a stale copy of one action.
        loadSavedAction: (id, signal) => this.loadConfirmedAction(id, signal),
      },
    });
  }

  private async senderCurrent(sender: QuickLaunchSender): Promise<boolean> {
    const run = this.active;
    if (!run || run.controller.signal.aborted || !sameSender(run.sender, sender)) return false;
    try {
      const current = await this.ports.quickLaunch.authority.senderIsCurrent(sender) === true && this.active === run && !run.controller.signal.aborted;
      if (!current) { if (run.plan && !run.controller.signal.aborted) this.invalidate(run, false); return false; }
      // QuickLaunchPolicy also invokes this as its final authorization, after
      // the native pin check. Recheck the complete plan here too, reducing the
      // gap before the fixed adapter; never authorize later changed targets.
      return run.plan === null ? true : this.verifyPlan(run);
    } catch { if (run.plan && !run.controller.signal.aborted) this.invalidate(run, false); return false; }
  }
  private consumePermit(id: string, revision: number, sender: QuickLaunchSender): boolean {
    const run = this.active;
    if (!run || run.controller.signal.aborted || !sameSender(run.sender, sender) || run.permits.get(id) !== revision) return false;
    run.permits.delete(id); return true;
  }
  private invalidate(run: ActiveRun, changed: boolean): void {
    if (this.active !== run) return;
    if (changed) run.changed = true; else run.cancelled = true;
    run.permits.clear();
    run.controller.abort();
    // Invalidates any still-unconsumed or currently revalidating approvals;
    // adapters already called are allowed to finish reporting their actual
    // result. Never kill/restart an already issued process.
    this.policy.revokeSender(run.sender.senderId, run.sender.documentId);
  }
  private async fetchPlan(run: ActiveRun, signal: AbortSignal): Promise<RoutineLaunchPlan | null> {
    const raw = await this.ports.loadRoutinePlan(run.routineId, signal);
    if (signal.aborted || run.controller.signal.aborted || this.active !== run || raw === null) return null;
    const parsed = routineLaunchPlanSchema.safeParse(raw);
    return parsed.success && parsed.data.routine.id === run.routineId ? parsed.data : null;
  }
  private async verifyPlan(run: ActiveRun): Promise<boolean> {
    if (run.controller.signal.aborted || this.active !== run) return false;
    const result = await bounded(quickLaunchLimits.authorityTimeoutMs, run.controller.signal, signal => this.fetchPlan(run, signal));
    if (result.kind !== 'OK' || result.value === null || JSON.stringify(result.value) !== run.fingerprint) {
      if (!run.controller.signal.aborted) this.invalidate(run, true);
      return false;
    }
    return true;
  }
  private async loadConfirmedAction(id: string, signal: AbortSignal): Promise<LaunchAuthorityAction | null> {
    const run = this.active;
    if (!run || !run.plan || signal.aborted || run.controller.signal.aborted) return null;
    // QuickLaunchPolicy's own authority deadline bounds this read. The
    // confirmed whole-plan comparison includes every action revision/pin.
    const plan = await this.fetchPlan(run, signal);
    if (signal.aborted || run.controller.signal.aborted || this.active !== run) return null;
    if (plan === null || JSON.stringify(plan) !== run.fingerprint) { this.invalidate(run, true); return null; }
    return plan.targets.find(target => target.targetId === id)?.action ?? null;
  }

  async run(raw: unknown, sender: QuickLaunchSender): Promise<RoutineRunOutcome> {
    const parsed = workspaceRunRoutineIntentSchema.safeParse(raw);
    if (!parsed.success || !validSender(sender)) return fail('INVALID_REQUEST');
    if (this.closed) return fail('SERVICE_UNAVAILABLE');
    if (this.active !== null) return fail('BUSY');
    const run: ActiveRun = { sender: Object.freeze({ ...sender }), ...parsed.data, controller: new AbortController(),
      permits: new Map(), plan: null, fingerprint: null, cancelled: false, changed: false };
    this.active = run;
    try {
      const authorized = await bounded(quickLaunchLimits.authorityTimeoutMs, run.controller.signal, () => this.senderCurrent(run.sender));
      if (authorized.kind !== 'OK' || authorized.value !== true) return fail(run.cancelled ? 'CANCELLED' : 'FORBIDDEN');
      const fetched = await bounded(quickLaunchLimits.authorityTimeoutMs, run.controller.signal, signal => this.fetchPlan(run, signal));
      if (fetched.kind !== 'OK') return fail(run.cancelled ? 'CANCELLED' : 'SERVICE_UNAVAILABLE');
      if (fetched.value === null) return fail('NOT_FOUND');
      if (fetched.value.routine.revision !== run.expectedRevision) return fail('REVISION_CONFLICT');
      const plan = fetched.value;
      run.plan = plan; run.fingerprint = JSON.stringify(plan);
      const confirmation = await bounded(CONFIRM_TIMEOUT_MS, run.controller.signal,
        signal => this.ports.confirmRoutine(routineLaunchPlanSchema.parse(JSON.parse(run.fingerprint!)), run.sender, signal));
      if (confirmation.kind !== 'OK' || confirmation.value !== true) return fail(confirmation.kind === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      if (run.controller.signal.aborted) return fail('CANCELLED');
      if (!(await this.verifyPlan(run))) return fail(run.cancelled ? 'CANCELLED' : 'REVISION_CONFLICT');
      const runId = this.ports.createRunId();
      if (typeof runId !== 'string' || !ID.test(runId)) return fail('SERVICE_UNAVAILABLE');
      const results = await this.execute(run, plan, runId);
      return { ok: true, result: routineRunResultSchema.parse({ runId, routineId: run.routineId,
        routineRevision: plan.routine.revision, cancelled: run.cancelled, targets: results }) };
    } catch { return fail('SERVICE_UNAVAILABLE'); }
    finally {
      run.permits.clear(); run.controller.abort(); this.policy.revokeSender(run.sender.senderId, run.sender.documentId);
      if (this.active === run) this.active = null;
    }
  }

  private async record(runId: string, action: LaunchAuthorityAction | null, result: RoutineTargetResult): Promise<void> {
    if (!action || !action.enabled || !this.ports.recordOutcome) return;
    // An outcome is never a reason to retry an actual launch. Record at most
    // once; an ambiguous worker response can remain absent from local history.
    await bounded(quickLaunchLimits.authorityTimeoutMs, new AbortController().signal, () => this.ports.recordOutcome!({
      targetId: action.id, actionRevision: action.revision, runId, source: 'ROUTINE', outcome: result.outcome,
    }));
  }
  private async execute(run: ActiveRun, plan: RoutineLaunchPlan, runId: string): Promise<RoutineTargetResult[]> {
    const identities = new Set<string>(), duplicates = new Set<number>();
    for (const [index, target] of plan.targets.entries()) {
      if (!target.action?.enabled) continue;
      const key = identity(target.action);
      if (identities.has(key)) duplicates.add(index); else identities.add(key);
    }
    const results: Array<RoutineTargetResult | undefined> = Array(plan.targets.length);
    const attempt = async (index: number, stopped: boolean): Promise<RoutineTargetResult> => {
      const { targetId, action } = plan.targets[index]!;
      let result: RoutineTargetResult;
      if (run.cancelled) result = skipped(targetId, 'CANCELLED');
      else if (run.changed) result = skipped(targetId, 'CHANGED');
      else if (stopped) result = skipped(targetId, 'STOPPED');
      else if (duplicates.has(index)) result = skipped(targetId, 'DUPLICATE');
      else if (!action?.enabled) result = skipped(targetId, 'UNAVAILABLE');
      else if (!(await this.verifyPlan(run))) result = skipped(targetId, run.cancelled ? 'CANCELLED' : 'CHANGED');
      else {
        // One permit for this exact saved action + sender/revision. The
        // private policy consumes it and does its own final native recheck.
        run.permits.set(targetId, action.revision);
        const launched = await this.policy.launchSavedAction(targetId, { sender: run.sender, expectedRevision: action.revision });
        run.permits.delete(targetId);
        // If an adapter already issued an operation, keep the actual result,
        // including UNKNOWN. Only an unissued policy denial becomes a skip.
        result = launched.ok ? dispatched(targetId, launched)
          : run.cancelled ? skipped(targetId, 'CANCELLED') : run.changed ? skipped(targetId, 'CHANGED') : dispatched(targetId, launched);
      }
      results[index] = result;
      await this.record(runId, action, result);
      return result;
    };
    if (plan.routine.mode === 'SEQUENTIAL') {
      let stopped = false;
      for (let index = 0; index < plan.targets.length; index++) {
        const outcome = await attempt(index, stopped);
        if (plan.routine.failurePolicy === 'STOP' && outcome.outcome !== 'ACCEPTED' && outcome.reason !== 'DUPLICATE') stopped = true;
        if (!stopped && !run.cancelled && !run.changed && index + 1 < plan.targets.length && plan.routine.delayMs > 0
          && outcome.outcome !== 'SKIPPED') {
          const sleep = this.ports.delay ?? timedDelay;
          const waited = await bounded(plan.routine.delayMs + 1000, run.controller.signal, signal => sleep(plan.routine.delayMs, signal));
          if (waited.kind !== 'OK' && !run.controller.signal.aborted) this.invalidate(run, false);
        }
      }
    } else {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < plan.targets.length) { const index = cursor++; await attempt(index, false); }
      };
      await Promise.all(Array.from({ length: Math.min(plan.targets.length, routineLaunchLimits.parallelism) }, () => worker()));
    }
    return results.map((result, index) => result ?? skipped(plan.targets[index]!.targetId, run.cancelled ? 'CANCELLED' : 'CHANGED'));
  }

  cancel(routineId: string, sender: QuickLaunchSender): boolean {
    const run = this.active;
    if (!run || !validSender(sender) || run.routineId !== routineId || !sameSender(run.sender, sender) || run.controller.signal.aborted) return false;
    this.invalidate(run, false); return true;
  }
  revokeSender(senderId: number, documentId?: string): void {
    const run = this.active;
    if (run && run.sender.senderId === senderId && (documentId === undefined || run.sender.documentId === documentId)) this.invalidate(run, false);
  }
  close(): void { this.closed = true; if (this.active) this.invalidate(this.active, false); this.policy.clear(); }
}
