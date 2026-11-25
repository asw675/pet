import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchAuthorityAction, WorkspacePage, Routine, ApprovedQuickTarget } from '@pet-desktop/contracts/workspace';
import { WorkspaceHost } from '../src/main/workspace-host.js';
import type { WorkspaceAuthorityRequest, WorkspaceAuthorityResult, WorkspaceIntent, WorkspaceResult } from '../src/shared/workspace-ipc.js';
import type { QuickLaunchSender } from '../src/main/quick-launch-policy.js';
import type { WindowsLaunchNativeDialog, WindowsLaunchNativeShell } from '../src/main/windows-launch-adapter.js';

const sender: QuickLaunchSender = { role: 'control-center', senderId: 11, documentId: 'doc-1' };
const url = 'https://example.com/docs?q=tea#chapter';
const url2 = 'https://example.org/work';
const url3 = 'https://example.net/new';
const target = (locator: string): ApprovedQuickTarget => ({ kind: 'HTTPS', locator, fingerprint: { kind: 'HTTPS', canonicalUrl: locator } });
function action(id: string, locator: string): LaunchAuthorityAction {
  return { ...target(locator), id, label: id + '-label', revision: 0, approvedAt: 1, enabled: true };
}
function view(raw: LaunchAuthorityAction, recommendable = true): WorkspacePage['actions'][number] {
  return { id: raw.id, label: raw.label, kind: raw.kind, revision: raw.revision, approved: true, enabled: raw.enabled,
    recommendable, preview: new URL(raw.locator).hostname };
}
function recommendation(id: string, label: string): WorkspacePage['recommendations'][number] {
  return { targetId: id, label, score: 0.8, evidence: { count7: 3, count30: 3, sameLocalPeriod: 3,
    weekdayKind: 'WEEKDAY', period: 'MORNING', sharedUses: 0, contextTargetIds: [] }, routineSuggestion: [] };
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const saved = action('one', url), second = action('two', url2);
  const routine: Routine = { id: 'routine-1', revision: 0, name: '工作台', mode: 'SEQUENTIAL', delayMs: 0,
    failurePolicy: 'CONTINUE', skipDuplicates: true, targetIds: ['one', 'two'] };
  const state = { current: true, time: 1000,
    actions: new Map<string, LaunchAuthorityAction>([['one', saved], ['two', second]]),
    page: { revision: 7, actions: [view(saved), view(second)], routines: [routine], settings: { enabled: false, retentionDays: 7 },
      history: [], preferences: [], recommendations: [], shownToday: 0 } as WorkspacePage };
  const nativeDialog = {
    showOpenDialog: vi.fn<WindowsLaunchNativeDialog['showOpenDialog']>().mockResolvedValue({ canceled: true, filePaths: [] }),
    showMessageBox: vi.fn<WindowsLaunchNativeDialog['showMessageBox']>().mockResolvedValue({ response: 1 }),
  };
  const nativeShell = {
    openPath: vi.fn<WindowsLaunchNativeShell['openPath']>().mockResolvedValue(''),
    openExternal: vi.fn<WindowsLaunchNativeShell['openExternal']>().mockResolvedValue(undefined),
  };
  const success = (request: WorkspaceAuthorityRequest, data: unknown): WorkspaceAuthorityResult =>
    ({ requestId: request.requestId, method: request.intent.method, ok: true, data } as WorkspaceAuthorityResult);
  function realAuthority(request: WorkspaceAuthorityRequest): WorkspaceAuthorityResult {
    const { intent } = request;
    switch (intent.method) {
      case 'workspace/revision': return success(request, state.page.revision);
      case 'workspace/manage': {
        if (intent.payload.intent.method === 'workspace/list') return success(request, state.page);
        return { requestId: request.requestId, method: intent.method, ok: false, error: { code: 'CONFLICT' } };
      }
      case 'action/lookup': return success(request, state.actions.get(intent.payload.actionId) ?? null);
      case 'routine/plan': return success(request, { routine: state.page.routines[0], targets: state.page.routines[0]!.targetIds.map(targetId =>
        ({ targetId, action: state.actions.get(targetId) ?? null })) });
      case 'approved/add': {
        const applied = { ...intent.payload.target, id: 'new-action', revision: 0, approvedAt: state.time,
          enabled: true, label: intent.payload.label };
        state.actions.set(applied.id, applied);
        state.page.actions.push(view(applied, intent.payload.recommendable));
        state.page.revision++;
        return success(request, state.page);
      }
      case 'approved/reapprove': {
        const original = state.actions.get(intent.payload.actionId)!;
        const applied = { ...intent.payload.target, id: original.id, label: original.label, revision: original.revision + 1,
          approvedAt: state.time, enabled: true };
        state.actions.set(applied.id, applied);
        state.page.actions = state.page.actions.map(row => row.id === applied.id ? view(applied, row.recommendable) : row);
        state.page.revision++;
        return success(request, state.page);
      }
      case 'launch/record': return success(request, { recorded: state.page.settings.enabled });
      case 'impression/record': {
        const recorded = Math.min(2 - state.page.shownToday, intent.payload.displayed.length);
        state.page.shownToday += recorded;
        state.page.recommendations = state.page.recommendations.slice(recorded, 2 - state.page.shownToday + recorded);
        return success(request, { recorded });
      }
    }
  }
  const requestAuthority = vi.fn<(request: WorkspaceAuthorityRequest, signal: AbortSignal) => Promise<unknown>>()
    .mockImplementation(async request => realAuthority(request));
  const parent = { isDestroyed: () => false, webContents: { id: sender.senderId } } as unknown as BrowserWindow;
  let runId = 0;
  const host = new WorkspaceHost({ resourcesDirectory: '/unavailable-helper', expectedInspectorSha256: null, platform: 'win32',
    requestAuthority, nativeDialog, nativeShell, senderIsCurrent: () => state.current,
    parentFor: () => parent, now: () => state.time, tokenEntropy: () => 'a'.repeat(64), createRunId: () => 'run-' + ++runId });
  let requestId = 0;
  const ask = (intent: WorkspaceIntent, who: QuickLaunchSender | null = sender) => host.handle({ requestId: 'request-' + ++requestId, intent }, who);
  const select = (locator = url3) => ask({ method: 'action/select', payload: { kind: 'HTTPS', expectedRevision: state.page.revision, manualHttpsUrl: locator } });
  const approve = async (locator = url3) => {
    const selected = await select(locator);
    expect(selected?.ok && selected.method === 'action/select').toBe(true);
    if (!selected?.ok || selected.method !== 'action/select') throw new Error('selection failed');
    return selected.data.approvalToken;
  };
  const calls = (method: WorkspaceAuthorityRequest['intent']['method']) => requestAuthority.mock.calls.filter(([request]) => request.intent.method === method);
  const list = () => ask({ method: 'workspace/list', payload: {} });
  const run = (actionId = 'one', expectedRevision = 0) => ask({ method: 'action/run', payload: { actionId, expectedRevision } });
  const runRoutine = () => ask({ method: 'routine/run', payload: { routineId: routine.id, expectedRevision: routine.revision } });
  return { host, state, nativeDialog, nativeShell, requestAuthority, realAuthority, ask, select, approve, calls, list, run, runRoutine, parent };
}
function code(result: WorkspaceResult | null) { return result && !result.ok ? result.error.code : null; }

describe('workspace Main host public boundary and approved selections', () => {
  it('validates trusted role and closed payload before any worker or OS call', async () => {
    const h = setup();
    expect(await h.host.handle({ requestId: 'r', intent: { method: 'action/run', payload: { actionId: 'one', expectedRevision: 0, locator: url } } }, sender)).toBeNull();
    expect(await h.host.handle({ requestId: 'r2', intent: { method: 'approved/add', payload: {} } }, sender)).toBeNull();
    expect(code(await h.ask({ method: 'workspace/list', payload: {} }, null))).toBe('FORBIDDEN');
    expect(code(await h.ask({ method: 'workspace/list', payload: {} }, { ...sender, role: 'pet' } as unknown as QuickLaunchSender))).toBe('FORBIDDEN');
    expect(h.requestAuthority).not.toHaveBeenCalled(); expect(h.nativeDialog.showMessageBox).not.toHaveBeenCalled();
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('relays management-only requests with exact worker result correlation', async () => {
    const h = setup();
    expect(await h.list()).toMatchObject({ ok: true, method: 'workspace/list', data: h.state.page });
    expect(h.calls('workspace/manage')).toHaveLength(1);
    expect(h.calls('workspace/manage')[0]![0].intent).toEqual({ method: 'workspace/manage', payload: { intent: { method: 'workspace/list', payload: {} } } });
    h.requestAuthority.mockResolvedValueOnce({ requestId: 'forged', method: 'workspace/manage', ok: true, data: h.state.page });
    expect(code(await h.list())).toBe('SERVICE_UNAVAILABLE');
    h.requestAuthority.mockImplementationOnce(async req => ({ requestId: req.requestId, method: 'workspace/revision', ok: true, data: 7 }));
    expect(code(await h.list())).toBe('SERVICE_UNAVAILABLE');
    h.requestAuthority.mockImplementationOnce(async req => ({ requestId: req.requestId, method: 'workspace/manage', ok: true,
      data: { ...h.state.page, actions: [{ ...h.state.page.actions[0], locator: url } ] } }));
    expect(code(await h.list())).toBe('SERVICE_UNAVAILABLE');
  });
  it('handles management errors without exposing raw worker data; rejects duplicate request IDs', async () => {
    const h = setup();
    const raw = { requestId: 'replay', intent: { method: 'workspace/list', payload: {} } };
    expect(await h.host.handle(raw, sender)).toMatchObject({ ok: true });
    expect(code(await h.host.handle(raw, sender))).toBe('INVALID_REQUEST');
    expect(h.calls('workspace/manage')).toHaveLength(1);
    h.requestAuthority.mockRejectedValueOnce(new Error('private'));
    expect(await h.list()).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    h.requestAuthority.mockImplementationOnce(async req => ({ requestId: req.requestId, method: req.intent.method, ok: false, error: { code: 'FORBIDDEN', raw: 'private' } }));
    expect(code(await h.list())).toBe('SERVICE_UNAVAILABLE');
  });
  it('manual HTTPS preview requires explicit native confirmation and returns only a hostname + token', async () => {
    const h = setup(), selected = await h.select(url);
    expect(selected).toMatchObject({ ok: true, method: 'action/select', data: { kind: 'HTTPS', preview: 'example.com',
      suggestedLabel: 'example.com', approvalToken: expect.stringMatching(/^quick-/u) } });
    expect(JSON.stringify(selected)).not.toContain('/docs');
    expect(JSON.stringify(selected)).not.toContain('tea');
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledWith(h.parent, expect.objectContaining({
      detail: expect.stringContaining(url), defaultId: 0, cancelId: 0, buttons: ['取消', '保存'] }));
    expect(h.nativeDialog.showOpenDialog).not.toHaveBeenCalled(); expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
    expect(h.calls('approved/add')).toHaveLength(0);
  });
  it('bounds a long but valid host label without shortening the native approved URL', async () => {
    const h = setup(), hostname = 'a'.repeat(50) + '.' + 'b'.repeat(50) + '.com';
    const locator = 'https://' + hostname + '/docs';
    expect(await h.select(locator)).toMatchObject({ ok: true, method: 'action/select', data: { kind: 'HTTPS',
      suggestedLabel: hostname.slice(0, 80), preview: hostname } });
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledWith(h.parent, expect.objectContaining({ detail: expect.stringContaining(locator) }));
  });
  it('invalid manual HTTPS input never reaches a native dialog or OS launch', async () => {
    const h = setup();
    for (const input of ['http://example.com', 'https://user:password@example.com/', 'https://example.com/?token=secret']) {
      expect(code(await h.select(input))).toBe('INVALID_TARGET');
    }
    expect(h.nativeDialog.showMessageBox).not.toHaveBeenCalled();
    expect(h.requestAuthority).not.toHaveBeenCalled();
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
    expect(await h.host.handle({ requestId: 'bad', intent: { method: 'action/select',
      payload: { kind: 'FOLDER', expectedRevision: 7, manualHttpsUrl: url } } }, sender)).toBeNull();
  });
  it('cancels rejected native preview and never writes it', async () => {
    const h = setup();
    h.nativeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(code(await h.select())).toBe('CANCELLED');
    expect(h.calls('approved/add')).toHaveLength(0);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('consumes exactly one add token, rechecks authority revision, saves approved descriptor only', async () => {
    const h = setup(), token = await h.approve(url3);
    const add = () => h.ask({ method: 'action/add', payload: { approvalToken: token, expectedRevision: 7, label: '网页', recommendable: true } });
    expect(await add()).toMatchObject({ ok: true, method: 'action/add', data: { revision: 8 } });
    expect(h.calls('approved/add')[0]![0].intent).toEqual({ method: 'approved/add', payload: {
      target: target(url3), label: '网页', recommendable: true, expectedRevision: 7 } });
    expect(code(await add())).toBe('APPROVAL_INVALID');
    expect(h.calls('approved/add')).toHaveLength(1);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('token cannot cross native sender or document; true owner still consumes exactly one', async () => {
    const h = setup(), token = await h.approve();
    const intent: WorkspaceIntent = { method: 'action/add', payload: { approvalToken: token, expectedRevision: 7, label: '网页', recommendable: false } };
    expect(code(await h.ask(intent, { ...sender, senderId: 12 }))).toBe('APPROVAL_INVALID');
    expect(await h.ask(intent)).toMatchObject({ ok: true });
    expect(h.calls('approved/add')).toHaveLength(1);
  });
  it.each(['expiry', 'revision', 'revocation'] as const)('rejects token after %s', async mode => {
    const h = setup(), token = await h.approve();
    if (mode === 'expiry') h.state.time += 31_000;
    if (mode === 'revision') h.state.page.revision++;
    if (mode === 'revocation') h.host.revokeSender(sender.senderId, sender.documentId);
    expect(code(await h.ask({ method: 'action/add', payload: { approvalToken: token, expectedRevision: 7, label: '网页', recommendable: false } })))
      .toBe(mode === 'expiry' ? 'APPROVAL_EXPIRED' : mode === 'revision' ? 'REVISION_CONFLICT' : 'FORBIDDEN');
    expect(h.calls('approved/add')).toHaveLength(0);
  });
  it('reapproval presents action-specific replacement confirmation before consuming token', async () => {
    const h = setup(), token = await h.approve(url3);
    const result = await h.ask({ method: 'action/reapprove', payload: { actionId: 'one', expectedActionRevision: 0, expectedWorkspaceRevision: 7, approvalToken: token } });
    expect(result).toMatchObject({ method: 'action/reapprove', ok: true, data: { revision: 8 } });
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(h.nativeDialog.showMessageBox).toHaveBeenLastCalledWith(h.parent, expect.objectContaining({
      message: expect.stringContaining('one-label'), detail: expect.stringContaining(url3), buttons: ['取消', '替换'] }));
    expect(h.calls('approved/reapprove')[0]![0].intent).toEqual({ method: 'approved/reapprove', payload: {
      target: target(url3), actionId: 'one', expectedActionRevision: 0, expectedWorkspaceRevision: 7 } });
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('rejects reapproval-specific cancellation and burns the selection token', async () => {
    const h = setup(), token = await h.approve();
    h.nativeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const intent: WorkspaceIntent = { method: 'action/reapprove', payload: { actionId: 'one', expectedActionRevision: 0, expectedWorkspaceRevision: 7, approvalToken: token } };
    expect(code(await h.ask(intent))).toBe('CANCELLED');
    expect(code(await h.ask(intent))).toBe('APPROVAL_INVALID');
    expect(h.calls('approved/reapprove')).toHaveLength(0);
  });
  it('does not save when sender is revoked during native confirmation', async () => {
    const h = setup();
    h.nativeDialog.showMessageBox.mockImplementationOnce(async () => { h.host.revokeSender(sender.senderId, sender.documentId); return { response: 1 }; });
    expect(code(await h.select())).toBe('FORBIDDEN');
    expect(h.calls('approved/add')).toHaveLength(0);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
});

describe('manual and routine native dispatch', () => {
  it('does not dispatch saved shortcuts during reads; explicit native user approval invokes exactly the fresh target', async () => {
    const h = setup();
    await h.list(); expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
    expect(await h.run()).toMatchObject({ ok: true, method: 'action/run', data: { runId: 'run-1', targetId: 'one', outcome: 'ACCEPTED' } });
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledWith(h.parent, expect.objectContaining({ detail: expect.stringContaining(url), defaultId: 0 }));
    expect(h.nativeShell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(h.calls('launch/record')[0]![0].intent).toEqual({ method: 'launch/record', payload: {
      targetId: 'one', runId: 'run-1', source: 'MANUAL', outcome: 'ACCEPTED', actionRevision: 0 } });
    expect(h.state.page.history).toEqual([]); // opt-in storage owns persistence, not host
  });
  it('native cancellation or changed authority during confirmation never launches or records', async () => {
    const h = setup();
    h.nativeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(code(await h.run())).toBe('FORBIDDEN');
    h.nativeDialog.showMessageBox.mockImplementationOnce(async () => { h.state.actions.set('one', action('one', url3)); return { response: 1 }; });
    expect(code(await h.run())).toBe('FORBIDDEN');
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled(); expect(h.calls('launch/record')).toHaveLength(0);
  });
  it('uses actual shell acceptance failure and never retries or leaks error messages', async () => {
    const h = setup();
    h.nativeShell.openExternal.mockRejectedValueOnce(new Error('private'));
    expect(await h.run()).toMatchObject({ ok: true, data: { outcome: 'FAILED', targetId: 'one' } });
    expect(h.nativeShell.openExternal).toHaveBeenCalledOnce();
    expect(h.calls('launch/record')).toHaveLength(1);
  });
  it('native routine confirmation displays ordered exact targets and policy; private permits dispatch once each', async () => {
    const h = setup(), result = await h.runRoutine();
    expect(result).toMatchObject({ ok: true, method: 'routine/run', data: { routineId: 'routine-1', cancelled: false,
      targets: [{ targetId: 'one', outcome: 'ACCEPTED', reason: null }, { targetId: 'two', outcome: 'ACCEPTED', reason: null }] } });
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledOnce();
    const detail = h.nativeDialog.showMessageBox.mock.calls[0]![1].detail!;
    expect(detail.indexOf(url)).toBeLessThan(detail.indexOf(url2));
    expect(detail).toContain('顺序'); expect(detail).toContain('继续'); expect(detail).toContain('版本 0');
    expect(h.nativeShell.openExternal.mock.calls).toEqual([[url], [url2]]);
    expect(h.calls('launch/record')).toHaveLength(2);
    expect(h.calls('launch/record').every(([req]) => req.intent.method === 'launch/record' && req.intent.payload.source === 'ROUTINE')).toBe(true);
  });
  it('rejects changed entire routine plan after native confirmation', async () => {
    const h = setup();
    h.nativeDialog.showMessageBox.mockImplementationOnce(async () => {
      h.state.actions.set('two', action('two', url3)); return { response: 1 };
    });
    expect(code(await h.runRoutine())).toBe('REVISION_CONFLICT');
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled(); expect(h.calls('launch/record')).toHaveLength(0);
  });
  it('allows cancellation during a routine modal, blocks other native requests until actual modal settles', async () => {
    const h = setup(), modal = defer<{ response: number }>();
    h.nativeDialog.showMessageBox.mockReturnValueOnce(modal.promise);
    const run = h.runRoutine();
    await vi.waitFor(() => expect(h.nativeDialog.showMessageBox).toHaveBeenCalledOnce());
    expect(code(await h.run())).toBe('BUSY');
    expect(await h.ask({ method: 'routine/cancel', payload: { routineId: 'routine-1' } })).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(code(await run)).toBe('CANCELLED');
    expect(code(await h.run())).toBe('BUSY');
    modal.resolve({ response: 1 });
    await vi.waitFor(() => expect(h.nativeDialog.showMessageBox).toHaveBeenCalledOnce());
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('routine confirmation for duplicate target shows skip and only dispatched actual action records history', async () => {
    const h = setup();
    const other = action('two', url);
    h.state.actions.set('two', other); h.state.page.actions[1] = view(other);
    expect(await h.runRoutine()).toMatchObject({ ok: true, data: { targets: [{ targetId: 'one', outcome: 'ACCEPTED' },
      { targetId: 'two', outcome: 'SKIPPED', reason: 'DUPLICATE' }] } });
    expect(h.nativeDialog.showMessageBox.mock.calls[0]![1].detail).toContain('重复，跳过');
    expect(h.nativeShell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(h.calls('launch/record')).toHaveLength(1);
  });
  it('close revokes pending operations, prevents obsolete documents from launching or mutating', async () => {
    const h = setup(), pending = defer<unknown>();
    h.requestAuthority.mockReturnValueOnce(pending.promise);
    const read = h.list();
    await vi.waitFor(() => expect(h.requestAuthority).toHaveBeenCalledOnce());
    h.host.close();
    expect(code(await read)).toBe('FORBIDDEN');
    expect(code(await h.run())).toBe('SERVICE_UNAVAILABLE');
    pending.resolve({});
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
});

describe('opt-in recommendation actual display acknowledgement', () => {
  function enabled() {
    const h = setup();
    h.state.page.settings.enabled = true;
    h.state.page.recommendations = [recommendation('one', 'one-label'), recommendation('two', 'two-label')];
    const seen = (targetIds: string[] = ['one'], expectedRevision = 7) =>
      h.ask({ method: 'recommendation/seen', payload: { targetIds, expectedRevision } });
    return { ...h, seen };
  }
  it('does not record on page polls or ack without actually offering same IDs to current document', async () => {
    const h = enabled();
    expect(code(await h.seen())).toBe('REVISION_CONFLICT');
    await h.list(); await h.list();
    expect(h.calls('impression/record')).toHaveLength(0);
    expect(code(await h.seen(['unknown']))).toBe('REVISION_CONFLICT');
    expect(h.calls('impression/record')).toHaveLength(0);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('rechecks eligibility, submits Main-generated unique impression IDs and returns actual refreshed daily cap', async () => {
    const h = enabled(); await h.list();
    expect(await h.seen(['one', 'two'])).toMatchObject({ method: 'recommendation/seen', ok: true, data: { shownToday: 2, recommendations: [] } });
    const request = h.calls('impression/record')[0]![0];
    expect(request.intent).toEqual({ method: 'impression/record', payload: { expectedRevision: 7,
      displayed: [{ targetId: 'one', impressionId: expect.stringMatching(/^impression-/u) },
        { targetId: 'two', impressionId: expect.stringMatching(/^impression-/u) }] } });
    if (request.intent.method === 'impression/record') expect(request.intent.payload.displayed[0]!.impressionId).not.toBe(request.intent.payload.displayed[1]!.impressionId);
    expect(code(await h.seen(['one']))).toBe('REVISION_CONFLICT');
    expect(h.calls('impression/record')).toHaveLength(1);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('fails closed when the recommendation is no longer eligible or revision changed', async () => {
    const h = enabled(); await h.list();
    h.state.page.revision++;
    expect(code(await h.seen())).toBe('REVISION_CONFLICT');
    expect(h.calls('impression/record')).toHaveLength(0);
    await h.list();
    h.state.page.recommendations = [];
    expect(code(await h.seen(['two'], 8))).toBe('REVISION_CONFLICT');
    expect(h.calls('impression/record')).toHaveLength(0);
  });
});
