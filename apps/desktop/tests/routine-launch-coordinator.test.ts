import { describe, expect, it, vi } from 'vitest';
import type { LaunchAuthorityAction, Routine } from '@pet-desktop/contracts/workspace';
import { RoutineLaunchCoordinator } from '../src/main/routine-launch-coordinator';
import type { AdapterLaunchOutcome, QuickLaunchPorts, QuickLaunchSender } from '../src/main/quick-launch-policy';
import type { RoutineLaunchPlan, LaunchRecord } from '../src/shared/workspace-ipc';

const sender: QuickLaunchSender = { role: 'control-center', senderId: 20, documentId: 'document-1' };
const other: QuickLaunchSender = { ...sender, documentId: 'document-2' };
const runIntent = { routineId: 'morning-work', expectedRevision: 7 };
function web(id: string, url = `https://example.com/${id}`, enabled = true): LaunchAuthorityAction {
  return { kind: 'HTTPS', locator: url, fingerprint: { kind: 'HTTPS', canonicalUrl: url }, id, revision: 2, approvedAt: 10, enabled, label: id };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
function setup(targets: Array<LaunchAuthorityAction | null>, changes: Partial<Routine> = {}) {
  const targetIds = targets.map((target, index) => target?.id ?? `missing-${index}`);
  const state = { current: true, plan: { routine: { id: 'morning-work', revision: 7, name: '工作', targetIds,
    mode: 'SEQUENTIAL', delayMs: 0, failurePolicy: 'CONTINUE', skipDuplicates: true, ...changes },
    targets: targets.map((action, index) => ({ targetId: targetIds[index]!, action })) } as RoutineLaunchPlan | null };
  const quickLaunch = {
    fs: { driveType: vi.fn(async () => 'UNKNOWN' as const), inspect: vi.fn(async () => null), hashExecutable: vi.fn(async () => null) },
    dialog: { selectTarget: vi.fn(async () => null), confirmAdd: vi.fn(async () => false), consumeSavedUserClick: vi.fn(() => false) },
    authority: { senderIsCurrent: vi.fn(() => state.current), workspaceRevision: vi.fn(async () => 0),
      loadSavedAction: vi.fn(async () => { throw new Error('routine must use its exact full-plan lookup'); }) },
    launcher: { launchExecutable: vi.fn(async (_path: string): Promise<AdapterLaunchOutcome> => 'failed'),
      openFolder: vi.fn(async (_path: string): Promise<AdapterLaunchOutcome> => 'failed'),
      openHttps: vi.fn(async (_path: string): Promise<AdapterLaunchOutcome> => 'accepted') },
    now: () => 1000, tokenEntropy: () => 'f'.repeat(64),
  } satisfies QuickLaunchPorts;
  const loadRoutinePlan = vi.fn(async (_id: string, _signal: AbortSignal) => structuredClone(state.plan));
  const confirmRoutine = vi.fn(async (_plan: RoutineLaunchPlan, _sender: QuickLaunchSender, _signal: AbortSignal) => true);
  const recordOutcome = vi.fn(async (_fact: LaunchRecord) => true);
  const delay = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  const coordinator = new RoutineLaunchCoordinator({ quickLaunch, loadRoutinePlan, confirmRoutine, recordOutcome, delay, createRunId: () => 'run-1' });
  return { state, quickLaunch, loadRoutinePlan, confirmRoutine, recordOutcome, delay, coordinator };
}

describe('bounded one-shot routine launcher using the real single-target policy', () => {
  it('confirms exact saved order, skips target aliases/unapproved entries, uses actual dispatch outcomes and no manual-permit sharing', async () => {
    const first = web('editor'), second = web('docs'), alias = web('alias', first.locator), disabled = web('disabled', 'https://example.com/off', false);
    const test = setup([first, alias, disabled, null, second], { delayMs: 250 });
    const result = await test.coordinator.run(runIntent, sender);
    expect(test.confirmRoutine).toHaveBeenCalledOnce();
    expect(test.confirmRoutine.mock.calls[0]![0]).toEqual(test.state.plan);
    expect(test.quickLaunch.launcher.openHttps.mock.calls.map(c => c[0])).toEqual([first.locator, second.locator]);
    expect(test.quickLaunch.dialog.consumeSavedUserClick).not.toHaveBeenCalled();
    expect(test.quickLaunch.authority.loadSavedAction).not.toHaveBeenCalled();
    expect(test.loadRoutinePlan.mock.calls.length).toBeGreaterThan(6);
    expect(result).toEqual({ ok: true, result: { runId: 'run-1', routineId: runIntent.routineId, routineRevision: 7, cancelled: false,
      targets: [{ targetId: 'editor', outcome: 'ACCEPTED', reason: null }, { targetId: 'alias', outcome: 'SKIPPED', reason: 'DUPLICATE' },
        { targetId: 'disabled', outcome: 'SKIPPED', reason: 'UNAVAILABLE' }, { targetId: 'missing-3', outcome: 'SKIPPED', reason: 'UNAVAILABLE' },
        { targetId: 'docs', outcome: 'ACCEPTED', reason: null }] } });
    expect(test.delay).toHaveBeenCalledWith(250, expect.any(AbortSignal));
    expect(test.recordOutcome.mock.calls.map(c => c[0])).toEqual([
      { targetId: 'editor', actionRevision: 2, runId: 'run-1', source: 'ROUTINE', outcome: 'ACCEPTED' },
      { targetId: 'alias', actionRevision: 2, runId: 'run-1', source: 'ROUTINE', outcome: 'SKIPPED' },
      { targetId: 'docs', actionRevision: 2, runId: 'run-1', source: 'ROUTINE', outcome: 'ACCEPTED' },
    ]);
  });

  it.each(['failed','unknown'] as const)('STOP ends remaining sequential launches on %s without retry', async outcome => {
    const test = setup([web('a'), web('b'), web('c')], { failurePolicy: 'STOP' });
    test.quickLaunch.launcher.openHttps.mockResolvedValueOnce(outcome);
    const result = await test.coordinator.run(runIntent, sender);
    expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, result: { targets: [{ targetId: 'a', outcome: outcome.toUpperCase(), reason: null },
      { targetId: 'b', outcome: 'SKIPPED', reason: 'STOPPED' }, { targetId: 'c', outcome: 'SKIPPED', reason: 'STOPPED' }] } });
  });

  it('runs at most three parallel targets and retains original order despite out-of-order dispatch returns', async () => {
    const targets = Array.from({ length: 7 }, (_, i) => web(`a-${i}`));
    const test = setup(targets, { mode: 'PARALLEL', delayMs: 0, failurePolicy: 'CONTINUE' });
    const pending = targets.map(() => deferred<AdapterLaunchOutcome>());
    let inFlight = 0, max = 0;
    test.quickLaunch.launcher.openHttps.mockImplementation(async url => {
      const index = targets.findIndex(target => target.locator === url);
      inFlight++; max = Math.max(max, inFlight);
      try { return await pending[index]!.promise; } finally { inFlight--; }
    });
    const run = test.coordinator.run(runIntent, sender);
    await vi.waitFor(() => expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledTimes(3));
    expect(max).toBe(3);
    pending[2]!.resolve('unknown'); pending[1]!.resolve('accepted');
    await vi.waitFor(() => expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledTimes(5));
    pending[4]!.resolve('failed'); pending[0]!.resolve('accepted');
    await vi.waitFor(() => expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledTimes(7));
    for (const index of [3,5,6]) pending[index]!.resolve('accepted');
    const result = await run;
    expect(max).toBe(3);
    expect(result).toMatchObject({ ok: true, result: { targets: targets.map((target, index) => ({ targetId: target.id,
      outcome: index === 2 ? 'UNKNOWN' : index === 4 ? 'FAILED' : 'ACCEPTED' })) } });
    expect(test.delay).not.toHaveBeenCalled();
  });

  it('rejects malformed and stale intents before native confirmation; exact sender binding required', async () => {
    const test = setup([web('a')]);
    expect(await test.coordinator.run({ ...runIntent, locator: 'https://example.com/' }, sender)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await test.coordinator.run({ ...runIntent, expectedRevision: 6 }, sender)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    test.state.current = false;
    expect(await test.coordinator.run(runIntent, sender)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(test.confirmRoutine).not.toHaveBeenCalled(); expect(test.quickLaunch.launcher.openHttps).not.toHaveBeenCalled();
  });

  it('requires native approval, cannot run twice concurrently, and cancels a pending approval from only its own document', async () => {
    const test = setup([web('a')]);
    const approval = deferred<boolean>();
    test.confirmRoutine.mockImplementationOnce(() => approval.promise);
    const run = test.coordinator.run(runIntent, sender);
    await vi.waitFor(() => expect(test.confirmRoutine).toHaveBeenCalledOnce());
    expect(await test.coordinator.run(runIntent, sender)).toEqual({ ok: false, code: 'BUSY' });
    expect(test.coordinator.cancel(runIntent.routineId, other)).toBe(false);
    expect(test.coordinator.cancel(runIntent.routineId, sender)).toBe(true);
    expect(await run).toEqual({ ok: false, code: 'CANCELLED' });
    approval.resolve(true); // late native answer cannot resume an old run
    expect(test.quickLaunch.launcher.openHttps).not.toHaveBeenCalled();
    test.confirmRoutine.mockResolvedValueOnce(false);
    expect(await test.coordinator.run(runIntent, sender)).toEqual({ ok: false, code: 'CANCELLED' });
    expect(test.recordOutcome).not.toHaveBeenCalled();
  });

  it('never dispatches a plan edited during native confirmation even when the dialog approves', async () => {
    const test = setup([web('a'), web('b')]);
    test.confirmRoutine.mockImplementationOnce(async () => {
      test.state.plan!.routine.revision++;
      test.state.plan!.targets[0]!.action = web('a', 'https://example.com/replacement');
      return true;
    });
    expect(await test.coordinator.run(runIntent, sender)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(test.quickLaunch.launcher.openHttps).not.toHaveBeenCalled();
  });

  it('re-fetches the entire routine before any later launch, stopping on an unseen replacement even under CONTINUE', async () => {
    const test = setup([web('a'), web('b'), web('c')]);
    test.quickLaunch.launcher.openHttps.mockImplementationOnce(async () => { test.state.plan!.targets[2]!.action = web('c', 'https://example.com/changed'); return 'accepted'; });
    const result = await test.coordinator.run(runIntent, sender);
    expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, result: { targets: [{ targetId: 'a', outcome: 'ACCEPTED' },
      { targetId: 'b', outcome: 'SKIPPED', reason: 'CHANGED' }, { targetId: 'c', outcome: 'SKIPPED', reason: 'CHANGED' }] } });
  });

  it('cancels during an explicit inter-target wait without undoing the first accepted launch', async () => {
    const test = setup([web('a'), web('b'), web('c')], { delayMs: 1000 });
    test.delay.mockImplementationOnce(async (_ms, signal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
    const run = test.coordinator.run(runIntent, sender);
    await vi.waitFor(() => expect(test.delay).toHaveBeenCalledOnce());
    expect(test.coordinator.cancel(runIntent.routineId, other)).toBe(false);
    expect(test.coordinator.cancel(runIntent.routineId, sender)).toBe(true);
    expect(await run).toMatchObject({ ok: true, result: { cancelled: true, targets: [{ targetId: 'a', outcome: 'ACCEPTED' },
      { targetId: 'b', outcome: 'SKIPPED', reason: 'CANCELLED' }, { targetId: 'c', outcome: 'SKIPPED', reason: 'CANCELLED' }] } });
    expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce();
  });

  it('revokes still-pending launches on navigation but reports the adapter result already issued', async () => {
    const test = setup([web('a'), web('b')]); const result = deferred<AdapterLaunchOutcome>();
    test.quickLaunch.launcher.openHttps.mockImplementationOnce(() => result.promise);
    const run = test.coordinator.run(runIntent, sender);
    await vi.waitFor(() => expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce());
    test.coordinator.revokeSender(sender.senderId, sender.documentId);
    result.resolve('unknown');
    expect(await run).toMatchObject({ ok: true, result: { cancelled: true, targets: [{ targetId: 'a', outcome: 'UNKNOWN' },
      { targetId: 'b', outcome: 'SKIPPED', reason: 'CANCELLED' }] } });
    expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce();
    test.coordinator.close();
    expect(await test.coordinator.run(runIntent, sender)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
  });

  it('does not retry an actual adapter launch if opt-in history transport fails', async () => {
    const test = setup([web('a')]); test.recordOutcome.mockRejectedValueOnce(new Error('storage offline'));
    expect(await test.coordinator.run(runIntent, sender)).toMatchObject({ ok: true, result: { targets: [{ targetId: 'a', outcome: 'ACCEPTED' }] } });
    expect(test.quickLaunch.launcher.openHttps).toHaveBeenCalledOnce();
    expect(test.recordOutcome).toHaveBeenCalledOnce();
  });
});
