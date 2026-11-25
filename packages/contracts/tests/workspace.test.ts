import { describe, expect, it } from 'vitest';
import {
  aiQuickActionSchema, approvedActionInputSchema, approvedQuickTargetSchema, launchAuthorityActionSchema,
  launchHistoryFactSchema, localRecommendationSchema, quickActionRecordSchema, quickActionViewSchema,
  recommendationPreferenceSchema, recommendationSettingsSchema, routineDefinitionSchema, routineSchema, workspaceActionMetadataIntentSchema,
  workspaceCreateRoutineIntentSchema, workspaceFinalizeAddIntentSchema, workspaceLimits, workspaceNativeSelectIntentSchema,
  workspacePageSchema, workspaceReapproveIntentSchema, workspaceRecommendationSettingsIntentSchema, workspaceRunActionIntentSchema,
  workspaceRunRoutineIntentSchema,
} from '../src/workspace.js';

const identity = { volumeSerial: '1'.repeat(16), fileId: '2'.repeat(32) };
const exe = { kind: 'WIN32_EXE', locator: 'C:\\Program Files\\示例\\Editor.exe', fingerprint: {
  kind: 'EXECUTABLE', identity, sizeBytes: 128, modifiedAtMs: 1000, sha256: 'a'.repeat(64),
} };
const folder = { kind: 'FOLDER', locator: 'C:\\Projects\\测试', fingerprint: { kind: 'DIRECTORY', identity } };
const web = { kind: 'HTTPS', locator: 'https://example.com/docs?q=tea#intro', fingerprint: {
  kind: 'HTTPS', canonicalUrl: 'https://example.com/docs?q=tea#intro',
} };
const action = { ...exe, id: 'target-1', label: '编辑器', revision: 0, approvedAt: 1234, enabled: true };
const stored = { ...action, recommendable: true };
const view = { id: 'target-1', label: '编辑器', kind: 'WIN32_EXE', revision: 0, approved: true, enabled: true, recommendable: true, preview: 'Editor.exe' };
const routineDefinition = { name: '开始工作', targetIds: ['target-1'], mode: 'SEQUENTIAL', delayMs: 500, failurePolicy: 'STOP', skipDuplicates: true };
const routine = { ...routineDefinition, id: 'routine-1', revision: 0 };
const history = { targetId: 'target-1', runId: 'run-1', source: 'MANUAL', outcome: 'ACCEPTED', timeBucket: 300000, utcOffsetMinutes: 480 };
const recommendation = { targetId: 'target-1', label: '编辑器', score: 0.8, evidence: {
  count7: 3, count30: 3, sameLocalPeriod: 3, weekdayKind: 'WEEKDAY', period: 'MORNING', sharedUses: 0, contextTargetIds: [],
}, routineSuggestion: [] };
const page = { revision: 5, actions: [view], routines: [routine], settings: { enabled: true, retentionDays: 30 },
  history: [history], preferences: [], recommendations: [recommendation], shownToday: 1 };

describe('closed native-approved authority target vs safe public projections', () => {
  it.each([exe, folder, web])('accepts exact approved target data without treating it as authority proof', target => {
    expect(approvedQuickTargetSchema.parse(target)).toEqual(target);
    expect(launchAuthorityActionSchema.safeParse({ ...target, id: 'target', label: '目标', revision: 0, approvedAt: 10, enabled: true }).success).toBe(true);
  });

  it.each([
    { ...exe, locator: '\\\\host\\share\\editor.exe' }, { ...exe, locator: '\\\\?\\C:\\editor.exe' },
    { ...exe, locator: 'c:\\editor.exe' }, { ...exe, locator: 'C:\\Apps\\..\\editor.exe' },
    { ...exe, locator: 'C:\\Apps\\editor.exe:alternate' }, { ...exe, locator: 'C:\\Apps\\NUL.exe' },
    { ...exe, locator: 'C:\\Apps\\script.cmd' }, { ...exe, locator: 'C:\\Apps\\cmd.exe' },
    { ...exe, locator: 'C:\\Apps\\node.exe' }, { ...exe, locator: 'C:\\Apps\\editor.exe --extra' },
    { ...exe, fingerprint: folder.fingerprint }, { ...exe, fingerprint: { ...exe.fingerprint, sizeBytes: 0 } },
    { ...exe, fingerprint: { ...exe.fingerprint, sha256: 'not-a-hash' } },
    { ...exe, fingerprint: { ...exe.fingerprint, identity: { ...identity, fileId: '0'.repeat(32) } } },
    { ...web, locator: 'http://example.com/' }, { ...web, locator: 'https://user@example.com/' },
    { ...web, locator: 'https://example.com/?token=fake', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://example.com/?token=fake' } },
    { ...web, locator: 'https://example.com/#code=fake', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://example.com/#code=fake' } },
    { ...web, locator: 'https://127.1/', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://127.1/' } },
    { ...web, locator: 'https://example.com/different' }, { ...exe, args: ['custom'] },
  ])('rejects malformed, ambiguous, unsupported or incoherent target: %#', target => {
    expect(approvedQuickTargetSchema.safeParse(target).success).toBe(false);
  });

  it('separates exact Main authority from internal recommendation metadata and revoked state', () => {
    expect(launchAuthorityActionSchema.parse(action)).toEqual(action);
    expect(launchAuthorityActionSchema.safeParse(stored).success).toBe(false); // no extra fields crossing this boundary
    expect(quickActionRecordSchema.parse(stored)).toEqual(stored);
    const revoked = { ...stored, locator: null, fingerprint: null, approvedAt: null, enabled: false, recommendable: false };
    expect(quickActionRecordSchema.parse(revoked)).toEqual(revoked);
    expect(quickActionRecordSchema.safeParse({ ...revoked, enabled: true }).success).toBe(false);
    expect(quickActionRecordSchema.safeParse({ ...revoked, locator: exe.locator }).success).toBe(false);
    expect(launchAuthorityActionSchema.safeParse(revoked).success).toBe(false);
  });

  it('accepts UI display and AI ID/label-only capability, never raw path/fingerprint', () => {
    expect(quickActionViewSchema.parse(view)).toEqual(view);
    expect(quickActionViewSchema.safeParse({ ...view, locator: exe.locator }).success).toBe(false);
    expect(quickActionViewSchema.safeParse({ ...view, preview: exe.locator }).success).toBe(false);
    expect(quickActionViewSchema.safeParse({ ...view, preview: 'https://example.com/private' }).success).toBe(false);
    expect(quickActionViewSchema.safeParse({ ...view, approved: false, enabled: false, recommendable: false, preview: null }).success).toBe(true);
    expect(quickActionViewSchema.safeParse({ ...view, approved: false }).success).toBe(false);
    const ai = { targetId: view.id, label: view.label };
    expect(aiQuickActionSchema.parse(ai)).toEqual(ai);
    for (const extra of [{ locator: exe.locator }, { fingerprint: exe.fingerprint }, { kind: 'HTTPS' }, { preview: 'safe.exe' }]) {
      expect(aiQuickActionSchema.safeParse({ ...ai, ...extra }).success).toBe(false);
    }
    expect(aiQuickActionSchema.safeParse({ ...ai, label: exe.locator }).success).toBe(false);
  });
});

describe('ordered routine policy, bounded local usage and recommendations', () => {
  it('accepts a fixed ordered sequential definition and parallel no-delay continue mode', () => {
    expect(routineSchema.parse(routine)).toEqual(routine);
    expect(routineDefinitionSchema.safeParse({ ...routineDefinition, targetIds: ['one', 'two'], mode: 'PARALLEL', delayMs: 0, failurePolicy: 'CONTINUE' }).success).toBe(true);
  });

  it.each([
    { targetIds: [] }, { targetIds: ['target-1', 'target-1'] },
    { targetIds: Array.from({ length: workspaceLimits.routineTargets + 1 }, (_, i) => 'target-' + i) },
    { mode: 'PARALLEL' }, { mode: 'PARALLEL', delayMs: 0, failurePolicy: 'STOP' },
    { delayMs: -1 }, { delayMs: workspaceLimits.maxDelayMs + 1 }, { skipDuplicates: false },
    { locator: exe.locator }, { autorun: true },
  ])('rejects invalid or autonomous routine policy %#', change => {
    expect(routineDefinitionSchema.safeParse({ ...routineDefinition, ...change }).success).toBe(false);
  });

  it('allows only privacy-minimized 5-minute app-origin outcome facts, no raw timestamp or path', () => {
    expect(launchHistoryFactSchema.parse(history)).toEqual(history);
    for (const invalid of [{ ...history, timeBucket: 123 }, { ...history, source: 'SYSTEM' }, { ...history, outcome: 'RUNNING' },
      { ...history, utcOffsetMinutes: 841 }, { ...history, locator: exe.locator }, { ...history, launchedAt: 1234000 }, { ...history, pid: 999 }]) {
      expect(launchHistoryFactSchema.safeParse(invalid).success).toBe(false);
    }
    expect(recommendationSettingsSchema.safeParse({ enabled: false, retentionDays: 7 }).success).toBe(true);
    expect(recommendationSettingsSchema.safeParse({ enabled: true, retentionDays: 31 }).success).toBe(false);
    expect(recommendationPreferenceSchema.safeParse({ targetId: 'target-1', ignoredUntil: null, permanentlyExcluded: true }).success).toBe(true);
    expect(recommendationPreferenceSchema.safeParse({ targetId: 'target-1', ignoredUntil: 100, permanentlyExcluded: true }).success).toBe(false);
  });

  it('validates page references/eligibility and enforces opt-in plus remaining daily impression budget', () => {
    expect(workspacePageSchema.parse(page)).toEqual(page);
    for (const invalid of [
      { ...page, actions: [] },
      { ...page, actions: [view, view] },
      { ...page, routines: [{ ...routine, targetIds: ['missing'] }] },
      { ...page, history: [history, history] },
      { ...page, preferences: [{ targetId: 'missing', ignoredUntil: null, permanentlyExcluded: false }] },
      { ...page, preferences: [{ targetId: view.id, ignoredUntil: null, permanentlyExcluded: true }] },
      { ...page, actions: [{ ...view, enabled: false }] },
      { ...page, settings: { ...page.settings, enabled: false } },
      { ...page, shownToday: 2 },
      { ...page, recommendations: [{ ...recommendation, label: '其他名称' }] },
      { ...page, recommendations: [{ ...recommendation, evidence: { ...recommendation.evidence, contextTargetIds: ['missing'] } }] },
      { ...page, recommendations: [{ ...recommendation, routineSuggestion: ['target-1', 'missing'] }] },
    ]) expect(workspacePageSchema.safeParse(invalid).success).toBe(false);
    expect(localRecommendationSchema.safeParse({ ...recommendation, evidence: { ...recommendation.evidence, count30: 2 } }).success).toBe(false);
  });
});

describe('renderer intents have no arbitrary launcher authority', () => {
  const token = 'quick-1-' + 'a'.repeat(64);
  const nativeSelect = { kind: 'WIN32_EXE', expectedRevision: 0 };
  const finalize = { approvalToken: token, label: '编辑器', recommendable: true, expectedRevision: 0 };
  const run = { actionId: view.id, expectedRevision: 0 };
  it('permits only kind/token/explicit saved IDs and revision, with internal approved target separate', () => {
    expect(workspaceNativeSelectIntentSchema.safeParse(nativeSelect).success).toBe(true);
    expect(workspaceFinalizeAddIntentSchema.safeParse(finalize).success).toBe(true);
    expect(workspaceReapproveIntentSchema.safeParse({ actionId: view.id, expectedActionRevision: 0, expectedWorkspaceRevision: 2, approvalToken: token }).success).toBe(true);
    expect(workspaceRunActionIntentSchema.safeParse(run).success).toBe(true);
    expect(workspaceRunRoutineIntentSchema.safeParse({ routineId: routine.id, expectedRevision: 0 }).success).toBe(true);
    expect(workspaceCreateRoutineIntentSchema.safeParse({ expectedRevision: 0, definition: routineDefinition }).success).toBe(true);
    expect(approvedActionInputSchema.safeParse({ id: view.id, label: view.label, target: exe, approvedAt: 1234, enabled: true, recommendable: true }).success).toBe(true);
  });

  it.each([
    [workspaceNativeSelectIntentSchema, { ...nativeSelect, locator: exe.locator }],
    [workspaceNativeSelectIntentSchema, { ...nativeSelect, kind: 'SHELL' }],
    [workspaceFinalizeAddIntentSchema, { ...finalize, fingerprint: exe.fingerprint }],
    [workspaceFinalizeAddIntentSchema, { ...finalize, approvalToken: 'made-up' }],
    [workspaceFinalizeAddIntentSchema, { ...finalize, approvedAt: 100 }],
    [workspaceRunActionIntentSchema, { ...run, locator: exe.locator }],
    [workspaceRunActionIntentSchema, { ...run, args: [] }],
    [workspaceRunActionIntentSchema, { ...run, confirmed: true }],
    [workspaceRunActionIntentSchema, { ...run, source: 'MANUAL' }],
    [workspaceRunActionIntentSchema, { ...run, outcome: 'ACCEPTED' }],
    [workspaceRunRoutineIntentSchema, { routineId: routine.id, expectedRevision: 0, targetIds: ['different'] }],
    [workspaceActionMetadataIntentSchema, { ...run, label: '编辑器', enabled: true, recommendable: true, locator: exe.locator }],
    [workspaceRecommendationSettingsIntentSchema, { expectedRevision: 0, settings: { enabled: true, retentionDays: 30 }, clearHistory: false, autoLaunch: true }],
  ] as const)('never accepts extra authority/execution fields case %#', (schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
