import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRepository } from '@pet-desktop/app-service';
import type { SqliteConnection } from '@pet-desktop/app-service';
import type { ApprovedQuickTarget, RoutineDefinition, WorkspacePage } from '@pet-desktop/contracts/workspace';
import { WorkspaceControl } from '../src/app-service/workspace/workspace-control';
import { workspaceAuthorityRequestSchema, workspaceAuthorityResultSchema, workspaceAuthorityResultMatches,
  workspaceIntentSchema, workspaceManagementIntentSchema, workspaceRequestSchema, workspaceResultSchema, workspaceResultMatches,
  routineLaunchPlanSchema } from '../src/shared/workspace-ipc';
import type { WorkspaceAuthorityIntent, WorkspaceIntent, WorkspaceManagementIntent, WorkspaceAuthorityResult } from '../src/shared/workspace-ipc';

const START = 1_800_000_000_000;
const DAY = 86_400_000;
const editor: ApprovedQuickTarget = { kind: 'WIN32_EXE', locator: 'C:\\Program Files\\Private Work\\Editor.exe',
  fingerprint: { kind: 'EXECUTABLE', identity: { volumeSerial: '1'.repeat(16), fileId: '2'.repeat(32) }, sizeBytes: 100, modifiedAtMs: 123, sha256: 'a'.repeat(64) } };
const docs: ApprovedQuickTarget = { kind: 'HTTPS', locator: 'https://example.com/private-path', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://example.com/private-path' } };
const routine = (targetIds: string[]): RoutineDefinition => ({ name: '工作场景', targetIds, mode: 'SEQUENTIAL', delayMs: 500, failurePolicy: 'STOP', skipDuplicates: true });
function fixture<T>(work: (test: ReturnType<typeof setup>) => T): T {
  const test = setup(); try { return work(test); } finally { test.repo.close(); }
}
function setup() {
  const db = new DatabaseSync(':memory:');
  const repo = new SQLiteRepository(db as unknown as SqliteConnection, { persistent: false });
  let now = START, sequence = 0;
  const control = new WorkspaceControl({ transaction: run => repo.transaction(tx => run(tx.workspaceState())), now: () => now,
    utcOffsetMinutes: () => 480, createId: kind => `${kind}-${++sequence}` });
  function authority(intent: WorkspaceAuthorityIntent): WorkspaceAuthorityResult {
    const request = workspaceAuthorityRequestSchema.parse({ requestId: `request-${++sequence}`, intent });
    const result = workspaceAuthorityResultSchema.parse(control.handleAuthority(request));
    expect(workspaceAuthorityResultMatches(request, result)).toBe(true); return result;
  }
  function manage(intent: WorkspaceManagementIntent): WorkspacePage {
    const request = workspaceRequestSchema.parse({ requestId: `manage-${++sequence}`, intent });
    const result = workspaceResultSchema.parse(control.handleIntent(request));
    expect(workspaceResultMatches(request, result)).toBe(true);
    if (!result.ok || !('revision' in result.data)) throw new Error('expected management page');
    return result.data;
  }
  function add(target: ApprovedQuickTarget, label: string, recommendable = true): string {
    const page = control.addApprovedAction({ target, label, recommendable, expectedRevision: control.workspaceRevision() });
    return page.actions.find(action => action.label === label)!.id;
  }
  return { repo, db, control, authority, manage, add, advance: (timestamp: number) => { now = timestamp; } };
}

describe('workspace authority over shared real SQLite', () => {
  it('starts opted out, persists only Main-approved location, and returns safe public/AI projections', () => fixture(({ control, manage, authority, add }) => {
    expect(manage({ method: 'workspace/list', payload: {} })).toEqual({ revision: 0, actions: [], routines: [],
      settings: { enabled: false, retentionDays: 30 }, history: [], preferences: [], recommendations: [], shownToday: 0 });
    const id = add(editor, '代码编辑器');
    const page = manage({ method: 'workspace/list', payload: {} });
    expect(page.actions[0]).toMatchObject({ id, preview: 'Editor.exe', label: '代码编辑器', revision: 0 });
    const json = JSON.stringify(page);
    for (const forbidden of ['Private Work','locator','fingerprint','sha256']) expect(json).not.toContain(forbidden);
    expect(control.listAiActions()).toEqual([{ targetId: id, label: '代码编辑器' }]);
    expect(authority({ method: 'action/lookup', payload: { actionId: id } })).toMatchObject({ ok: true, data: { ...editor, id, revision: 0 } });
    expect(control.recordOutcome({ targetId: id, runId: 'off-1', source: 'MANUAL', outcome: 'ACCEPTED', actionRevision: 0 })).toBe(false);
    expect(control.getPage().history).toEqual([]);
  }));

  it('rejects stale approvals/updates atomically, revokes exact identity, and reapproves a fresh target without leaking old path', () => fixture(({ control, authority, add, manage, advance }) => {
    const targetId = add(editor, '我的编辑器');
    const before = control.getPage();
    expect(authority({ method: 'approved/add', payload: { target: docs, label: '文档', recommendable: true, expectedRevision: 0 } }))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(authority({ method: 'workspace/manage', payload: { intent: { method: 'action/metadata', payload: { actionId: targetId, expectedRevision: 1,
      label: '被修改', enabled: true, recommendable: true } } } })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(control.getPage()).toEqual(before);
    const revoked = manage({ method: 'action/revoke', payload: { actionId: targetId, expectedRevision: 0, clearHistory: true } });
    expect(revoked.actions[0]).toMatchObject({ approved: false, enabled: false, recommendable: false, preview: null, revision: 1 });
    expect(control.getLaunchAction(targetId)).toBeNull();
    expect(control.listAiActions()).toEqual([]);
    advance(START+1000);
    expect(authority({ method: 'approved/reapprove', payload: { target: docs, actionId: targetId, expectedActionRevision: 1,
      expectedWorkspaceRevision: revoked.revision } })).toMatchObject({ ok: true, data: { actions: [{ id: targetId, label: '我的编辑器', kind: 'HTTPS',
        enabled: true, recommendable: false, preview: 'example.com', revision: 2 }] } });
    expect(control.getLaunchAction(targetId)).toMatchObject({ ...docs, approvedAt: START+1000 });
  }));

  it('prepares an exact ordered atomic plan with action revisions; disabling/reapproval and deletion update dependent routines', () => fixture(({ control, authority, add, manage }) => {
    const first = add(editor, '编辑器'), second = add(docs, '文档');
    const page = manage({ method: 'routine/create', payload: { expectedRevision: control.workspaceRevision(), definition: routine([second,first]) } });
    const saved = page.routines[0]!;
    expect(control.getRoutinePlan(saved.id)).toEqual({ routine: saved, targets: [
      { targetId: second, action: control.getLaunchAction(second) }, { targetId: first, action: control.getLaunchAction(first) },
    ] });
    const edited = manage({ method: 'action/metadata', payload: { actionId: first, expectedRevision: 0, label: '编辑器', enabled: false, recommendable: true } });
    expect(edited.routines[0]!.revision).toBe(saved.revision+1);
    expect(authority({ method: 'routine/plan', payload: { routineId: saved.id } })).toMatchObject({ ok: true, data: {
      routine: { revision: saved.revision+1 }, targets: [{ targetId: second }, { targetId: first, action: { enabled: false, revision: 1 } }],
    } });
    const deleted = manage({ method: 'action/delete', payload: { actionId: first, expectedRevision: 1 } });
    expect(deleted.routines[0]!.targetIds).toEqual([second]);
    expect(manage({ method: 'action/delete', payload: { actionId: second, expectedRevision: 0 } }).routines).toEqual([]);
    expect(control.getRoutinePlan(saved.id)).toBeNull();
  }));

  it('records only consented actual outcome and trusted coarse time, rejects stale revision/forged time and keeps first result', () => fixture(({ control, manage, add, authority, advance }) => {
    const targetId = add(editor, '编辑器');
    const input = { targetId, runId: 'real-run', actionRevision: 0, source: 'MANUAL' as const, outcome: 'ACCEPTED' as const };
    expect(control.recordOutcome(input)).toBe(false);
    manage({ method: 'recommendation/settings', payload: { expectedRevision: control.workspaceRevision(), settings: { enabled: true, retentionDays: 7 }, clearHistory: false } });
    advance(START+12_345);
    expect(authority({ method: 'launch/record', payload: input })).toMatchObject({ ok: true, data: { recorded: true } });
    expect(control.recordOutcome({ ...input, outcome: 'FAILED' })).toBe(false);
    expect(control.recordOutcome({ ...input, runId: 'stale', actionRevision: 1 })).toBe(false);
    expect(control.getPage().history).toEqual([{ targetId, runId: 'real-run', source: 'MANUAL', outcome: 'ACCEPTED',
      timeBucket: Math.floor((START+12_345)/300_000)*300_000, utcOffsetMinutes: 480 }]);
    expect(control.handleAuthority({ requestId: 'forged', intent: { method: 'launch/record', payload: { ...input, timeBucket: START, utcOffsetMinutes: 0 } } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    advance(START+8*DAY);
    expect(control.getPage().history).toEqual([]); // retention enforced on read
  }));

  it('learns only actual accepted manual history and spends two daily impressions only on displayed current recommendations', () => fixture(({ control, authority, manage, add, advance }) => {
    const ids = [add(editor, '编辑器'), add(docs, '文档')];
    manage({ method: 'recommendation/settings', payload: { expectedRevision: control.workspaceRevision(), settings: { enabled: true, retentionDays: 30 }, clearHistory: false } });
    for (let day = 0; day < 3; day++) {
      advance(START+day*DAY);
      for (const targetId of ids) expect(control.recordOutcome({ targetId, runId: `manual-${day}`, source: 'MANUAL', outcome: 'ACCEPTED', actionRevision: 0 })).toBe(true);
    }
    advance(START+3*DAY);
    const page = control.getPage();
    expect(page.recommendations.map(row => row.targetId).sort()).toEqual(ids.sort());
    expect(control.getPage()).toEqual(page); // polling never counts impressions
    expect(control.recordImpression({ expectedRevision: page.revision, displayed: [{ targetId: 'absent', impressionId: 'forged' }] })).toBe(0);
    expect(control.getPage().shownToday).toBe(0);
    const impressions = { expectedRevision: page.revision, displayed: page.recommendations.map((row,index) => ({ targetId: row.targetId, impressionId: `actual-${index}` })) };
    expect(authority({ method: 'impression/record', payload: impressions })).toMatchObject({ ok: true, data: { recorded: 2 } });
    expect(control.recordImpression(impressions)).toBe(0);
    expect(control.getPage()).toMatchObject({ shownToday: 2, recommendations: [] });
    const disabled = manage({ method: 'recommendation/settings', payload: { expectedRevision: page.revision, settings: { enabled: false, retentionDays: 30 }, clearHistory: true } });
    expect(disabled.history).toEqual([]); expect(disabled.recommendations).toEqual([]); expect(disabled.shownToday).toBe(2);
    expect(control.recordOutcome({ targetId: ids[0], runId: 'opted-out', source: 'MANUAL', outcome: 'ACCEPTED', actionRevision: 0 })).toBe(false);
  }));
});

describe('closed renderer and Main-only workspace transports', () => {
  it('cannot smuggle approved locators, launch args, time, origin, recorded outcomes or native confirmation through renderer intents', () => {
    const unsafe = [
      { method: 'action/add', payload: { target: editor, label: '编辑器', recommendable: true, expectedRevision: 0 } },
      { method: 'action/run', payload: { actionId: 'id', expectedRevision: 0, args: ['secret'] } },
      { method: 'routine/run', payload: { routineId: 'id', expectedRevision: 0, confirmed: true } },
      { method: 'launch/record', payload: { targetId: 'id', runId: 'id', source: 'MANUAL', outcome: 'ACCEPTED', actionRevision: 0 } },
      { method: 'action/lookup', payload: { actionId: 'id' } },
      { method: 'action/select', payload: { kind: 'HTTPS', expectedRevision: 0, locator: 'https://example.com/' } },
    ];
    for (const raw of unsafe) expect(workspaceIntentSchema.safeParse(raw).success).toBe(false);
    const run = { method: 'action/run', payload: { actionId: 'id', expectedRevision: 0 } } satisfies WorkspaceIntent;
    expect(workspaceIntentSchema.safeParse(run).success).toBe(true);
    expect(workspaceManagementIntentSchema.safeParse(run).success).toBe(false);
    expect(workspaceAuthorityRequestSchema.safeParse({ requestId: 'id', intent: { method: 'workspace/manage', payload: { intent: run } } }).success).toBe(false);
    fixture(({ control }) => expect(control.handleIntent({ requestId: 'id', intent: run })).toEqual({ requestId: 'id', method: 'action/run', ok: false, error: { code: 'FORBIDDEN' } }));
  });

  it('rejects any native preview carrying full location or fingerprint and cross-correlates action/routine result identity', () => {
    const selection = { requestId: 'pick', method: 'action/select', ok: true, data: { approvalToken: `quick-1-${'a'.repeat(64)}`, expiresAt: START,
      kind: 'WIN32_EXE', suggestedLabel: '编辑器', preview: 'Editor.exe' } };
    expect(workspaceResultSchema.safeParse(selection).success).toBe(true);
    expect(workspaceResultSchema.safeParse({ ...selection, data: { ...selection.data, preview: editor.locator } }).success).toBe(false);
    expect(workspaceResultSchema.safeParse({ ...selection, data: { ...selection.data, fingerprint: editor.fingerprint } }).success).toBe(false);
    const request = workspaceRequestSchema.parse({ requestId: 'req', intent: { method: 'action/run', payload: { actionId: 'expected', expectedRevision: 0 } } });
    const wrong = workspaceResultSchema.parse({ requestId: 'req', method: 'action/run', ok: true, data: { runId: 'run', targetId: 'different', outcome: 'ACCEPTED' } });
    expect(workspaceResultMatches(request, wrong)).toBe(false);
    const badPlan = { routine: { id: 'r', revision: 0, ...routine(['a','b']) }, targets: [{ targetId: 'b', action: null }, { targetId: 'a', action: null }] };
    expect(routineLaunchPlanSchema.safeParse(badPlan).success).toBe(false);
    expect(workspaceAuthorityResultSchema.safeParse({ requestId: 'req', method: 'routine/plan', ok: true, data: badPlan }).success).toBe(false);
  });
});
