import { describe, expect, it } from 'vitest';
import { workspacePageSchema } from '@pet-desktop/contracts/workspace';
import type { LocalRecommendation, WorkspacePage } from '@pet-desktop/contracts/workspace';
import { workspaceIntentSchema, workspaceManagementIntentSchema } from '../src/shared/workspace-ipc';
import { applyStarterRoutineTemplate, starterRoutineTemplates } from '../src/renderer/control-center/workspace-routine-templates';
import {
  applicableWorkspaceIntent, approvalIntent, confirmWorkspaceIntent, createWorkspaceConfirmation, draftFromRecommendation, historyTime,
  moveRoutineTarget, newRoutineDraft, recommendationAction, routineDefinitionForDraft, validateWorkspaceResponse,
  visibleRecommendationCards, visibleRecommendationTargetIds,
} from '../src/renderer/shared/workspace-view-policy';
import type { WorkspaceApproval } from '../src/renderer/shared/workspace-view-policy';
import type { WorkspaceIntent } from '../src/shared/workspace-ipc';

const NOW = 1_800_000_000_000;
const card = (id = 'a'): LocalRecommendation => ({ targetId: id, label: id === 'a' ? '编辑器' : '文档', score: .7,
  evidence: { count7: 3, count30: 4, sameLocalPeriod: 3, weekdayKind: 'WEEKDAY', period: 'MORNING', sharedUses: 3, contextTargetIds: [] },
  routineSuggestion: id === 'a' ? ['a','b'] : ['b','a'] });
function page(): WorkspacePage {
  return workspacePageSchema.parse({ revision: 10, actions: [
    { id: 'a', label: '编辑器', kind: 'WIN32_EXE', revision: 3, approved: true, enabled: true, recommendable: true, preview: 'Editor.exe' },
    { id: 'b', label: '文档', kind: 'HTTPS', revision: 4, approved: true, enabled: true, recommendable: true, preview: 'example.com' },
    { id: 'c', label: '停用', kind: 'FOLDER', revision: 1, approved: true, enabled: false, recommendable: false, preview: 'Projects' },
    { id: 'd', label: '撤销', kind: 'FOLDER', revision: 2, approved: false, enabled: false, recommendable: false, preview: null },
  ], routines: [{ id: 'morning', revision: 5, name: '工作组合', mode: 'SEQUENTIAL', delayMs: 500, failurePolicy: 'STOP', skipDuplicates: true, targetIds: ['b','a'] }],
    settings: { enabled: true, retentionDays: 30 }, history: [], preferences: [], shownToday: 0, recommendations: [card(),card('b')] });
}
const run: WorkspaceIntent = { method: 'action/run', payload: { actionId: 'a', expectedRevision: 3 } };
const rename: WorkspaceIntent = { method: 'action/metadata', payload: { actionId: 'a', expectedRevision: 3, label: '工作编辑器', enabled: true, recommendable: true } };
function approval(replacing: WorkspaceApproval['replacing'] = null): WorkspaceApproval {
  return { generation: 2, workspaceRevision: 10, replacing, selection: { approvalToken: `quick-1-${'a'.repeat(64)}`, expiresAt: NOW+1000,
    kind: 'WIN32_EXE', suggestedLabel: '应用', preview: 'App.exe' } };
}

describe('workspace projection policy binds real worker generation and independent workspace revisions', () => {
  it('permits only a currently enabled/approved saved action with its exact entity revision', () => {
    expect(applicableWorkspaceIntent(page(),run)).toBe(true);
    for (const [actionId,expectedRevision] of [['a',2],['c',1],['d',2],['missing',0]] as const) {
      expect(applicableWorkspaceIntent(page(), { method: 'action/run', payload: { actionId, expectedRevision } })).toBe(false);
    }
    expect(applicableWorkspaceIntent(page(), { method: 'action/run', payload: { actionId: 'a', expectedRevision: 10 } })).toBe(false);
  });
  it('closes confirmation on generation, workspace or entity changes and never presents a local confirmation as native approval', () => {
    const current = page(), quote = createWorkspaceConfirmation(current, 2, rename, '确认', '名称');
    expect(quote).not.toBeNull();
    expect(confirmWorkspaceIntent(quote!, current, 2)).toEqual(rename);
    expect(confirmWorkspaceIntent(quote!, current, 3)).toBeNull();
    expect(confirmWorkspaceIntent(quote!, { ...current, revision: 11 }, 2)).toBeNull();
    current.actions[0]!.revision++;
    expect(confirmWorkspaceIntent(quote!,current,2)).toBeNull();
    expect(createWorkspaceConfirmation(page(),2,run,'启动','伪造 native')).toBeNull();
    expect(createWorkspaceConfirmation(page(),2,{ method: 'routine/run', payload: { routineId: 'morning', expectedRevision: 5 } },'运行','x')).toBeNull();
  });
  it('rejects enabling a revoked identity before a fresh native reapproval', () => {
    const current = page();
    expect(applicableWorkspaceIntent(current, { method: 'action/metadata', payload: { actionId: 'd', expectedRevision: 2, label: '恢复', enabled: true, recommendable: false } })).toBe(false);
    expect(applicableWorkspaceIntent(current, { method: 'action/metadata', payload: { actionId: 'd', expectedRevision: 2, label: '改名称', enabled: false, recommendable: false } })).toBe(true);
  });
  it('uses one preview token only within its original workspace/generation/time and never passes a location', () => {
    const intent = approvalIntent(approval(),page(),2,NOW,' 新应用 ',false);
    expect(intent).toEqual({ method: 'action/add', payload: { approvalToken: approval().selection.approvalToken, label: '新应用', recommendable: false, expectedRevision: 10 } });
    expect(approvalIntent(approval(),page(),2,NOW+1000,'新应用',false)).toBeNull();
    expect(approvalIntent(approval(),page(),3,NOW,'新应用',false)).toBeNull();
    expect(approvalIntent(approval(),{ ...page(), revision: 11 },2,NOW,'新应用',false)).toBeNull();
    expect(approvalIntent(approval(),page(),2,NOW,'C:\\Private\\App.exe',false)).toBeNull();
    expect(approvalIntent(approval(),page(),2,NOW,'',false)).toBeNull();
  });
  it('reapproval uses both exact action and workspace revisions, not a mutable editable locator/label', () => {
    const selected = approval({ actionId: 'd', actionRevision: 2 });
    expect(approvalIntent(selected,page(),2,NOW,'ignored',true)).toEqual({ method: 'action/reapprove', payload: {
      actionId: 'd', expectedActionRevision: 2, expectedWorkspaceRevision: 10, approvalToken: selected.selection.approvalToken } });
    expect(approvalIntent(approval({ actionId: 'd', actionRevision: 1 }),page(),2,NOW,'ignored',true)).toBeNull();
  });
  it('checks strict transport and rejects another action result, stale page mutation, or leaked authority field', () => {
    expect(validateWorkspaceResponse(run,{ requestId:'request',method:'action/run',ok:true,data:{runId:'run',targetId:'b',outcome:'ACCEPTED'} })).toBeNull();
    expect(validateWorkspaceResponse(run,{ requestId:'request',method:'action/run',ok:true,data:{runId:'run',targetId:'a',outcome:'ACCEPTED'} })).not.toBeNull();
    expect(validateWorkspaceResponse(rename,{ requestId:'request',method:'action/metadata',ok:true,data:page() })).toBeNull();
    const leaked = { ...page(), actions: [{ ...page().actions[0], locator:'C:\\Private\\Editor.exe' }] };
    expect(validateWorkspaceResponse({ method:'workspace/list',payload:{} },{ requestId:'request',method:'workspace/list',ok:true,data:leaked })).toBeNull();
  });
});

describe('ordered scene and recommendation interaction', () => {
  it('provides work, entertainment and study drafts that cannot be saved until the user adds targets', () => {
    expect(starterRoutineTemplates.map(template => template.label)).toEqual(['工作', '娱乐', '学习']);
    for (const template of starterRoutineTemplates) {
      const draft = applyStarterRoutineTemplate(template, newRoutineDraft());
      expect(draft).toEqual({
        name: template.name, mode: template.mode, delayMs: template.delayMs, failurePolicy: template.failurePolicy, targetIds: [],
      });
      expect(routineDefinitionForDraft(draft, page())).toBeNull();
    }
  });
  it('keeps manually chosen targets in order and rechecks current availability after changing templates', () => {
    const original = { ...newRoutineDraft(), targetIds: ['b', 'a'] };
    for (const template of starterRoutineTemplates) {
      const draft = applyStarterRoutineTemplate(template, original);
      const current = page();
      expect(routineDefinitionForDraft(draft, current)).toMatchObject({ targetIds: ['b', 'a'], mode: template.mode, skipDuplicates: true });
      current.actions[0]!.enabled = false;
      expect(routineDefinitionForDraft(draft, current)).toBeNull();
      draft.targetIds.pop();
      expect(original.targetIds).toEqual(['b', 'a']);
    }
  });
  it('preserves explicit order, refuses invalid/unapproved targets, duplicate IDs and invalid parallel configuration', () => {
    const draft = { ...newRoutineDraft(), name:' 上午工作 ', targetIds:['b','a'] };
    expect(routineDefinitionForDraft(draft,page())).toMatchObject({ name:'上午工作', targetIds:['b','a'], skipDuplicates: true });
    expect(moveRoutineTarget(draft.targetIds,1,-1)).toEqual(['a','b']); expect(draft.targetIds).toEqual(['b','a']);
    expect(moveRoutineTarget(draft.targetIds,0,-1)).toEqual(['b','a']);
    expect(routineDefinitionForDraft({ ...draft,targetIds:['a','a'] },page())).toBeNull();
    expect(routineDefinitionForDraft({ ...draft,targetIds:['a','d'] },page())).toBeNull();
    expect(routineDefinitionForDraft({ ...draft,mode:'PARALLEL',delayMs:500 },page())).toBeNull();
    expect(routineDefinitionForDraft({ ...draft,mode:'PARALLEL',delayMs:0,failurePolicy:'STOP' },page())).toBeNull();
    expect(routineDefinitionForDraft({ ...draft,mode:'PARALLEL',delayMs:0,failurePolicy:'CONTINUE' },page())).not.toBeNull();
  });
  it('run/cancel distinctions require a saved scene revision and no renderer-supplied targets or confirmation', () => {
    expect(applicableWorkspaceIntent(page(),{ method:'routine/run',payload:{ routineId:'morning',expectedRevision:5 } })).toBe(true);
    expect(applicableWorkspaceIntent(page(),{ method:'routine/run',payload:{ routineId:'morning',expectedRevision:6 } })).toBe(false);
    expect(applicableWorkspaceIntent(page(),{ method:'routine/cancel',payload:{ routineId:'morning' } })).toBe(false);
    expect(workspaceIntentSchema.safeParse({ method:'routine/run',payload:{ routineId:'morning',expectedRevision:5,confirmed:true } }).success).toBe(false);
  });
  it('recommendation observation requires actual document/card intersection and emits only closed current IDs', () => {
    const entries = [{ targetId:'a',isIntersecting:true,intersectionRatio:.8 },{ targetId:'b',isIntersecting:true,intersectionRatio:.2 },
      { targetId:'c',isIntersecting:false,intersectionRatio:1 },{ targetId:'a',isIntersecting:true,intersectionRatio:1 }];
    expect(visibleRecommendationTargetIds(entries,false)).toEqual([]);
    expect(visibleRecommendationTargetIds(entries,true)).toEqual(['a']);
    const intent = {method:'recommendation/seen',payload:{expectedRevision:10,targetIds:['a','b']}} as const;
    const parsed = workspaceIntentSchema.parse(intent);
    expect(applicableWorkspaceIntent(page(),parsed)).toBe(true);
    expect(workspaceManagementIntentSchema.safeParse(parsed).success).toBe(false);
    expect(applicableWorkspaceIntent(page(),{method:'recommendation/seen',payload:{expectedRevision:10,targetIds:['c']}})).toBe(false);
    expect(workspaceIntentSchema.safeParse({method:'recommendation/seen',payload:{expectedRevision:10,targetIds:['a','a']}}).success).toBe(false);
    expect(workspaceIntentSchema.safeParse({method:'recommendation/seen',payload:{expectedRevision:10,targetIds:['a'],impressionId:'raw'}}).success).toBe(false);
  });
  it('retains displayed cards after the daily budget is exhausted, still verifies saved action identity and ignores invalidated cards', () => {
    const exhausted: WorkspacePage = { ...page(), shownToday: 2, recommendations: [] };
    expect(visibleRecommendationCards(exhausted,[card(),card('b')],NOW).map(row=>row.targetId)).toEqual(['a','b']);
    expect(recommendationAction(exhausted,card(),false,NOW)).toBeNull();
    expect(recommendationAction(exhausted,card(),true,NOW)).toEqual(run);
    const ignored = { ...exhausted,preferences:[{targetId:'a',ignoredUntil:NOW+1000,permanentlyExcluded:false}] };
    expect(visibleRecommendationCards(ignored,[card(),card('b')],NOW).map(row=>row.targetId)).toEqual(['b']);
    expect(recommendationAction(ignored,card(),true,NOW)).toBeNull();
    expect(visibleRecommendationCards({ ...exhausted,settings:{ ...exhausted.settings,enabled:false } },[card(),card('b')],NOW)).toEqual([]);
  });
  it('suggested routine creates an editable ordered draft, never a launch; all saved members must remain eligible', () => {
    expect(draftFromRecommendation(page(),card(),false,NOW)).toMatchObject({ targetIds:['a','b'],mode:'SEQUENTIAL' });
    const stale = page(); stale.actions[1]!.enabled = false;
    expect(draftFromRecommendation(stale,card(),true,NOW)).toBeNull();
    const excluded = { ...page(), preferences: [{ targetId:'b',ignoredUntil:null,permanentlyExcluded:true }] };
    expect(draftFromRecommendation(excluded,card(),true,NOW)).toBeNull();
  });
  it('formats only the recorded time bucket with its original offset, not current device time or locator', () => {
    expect(historyTime({targetId:'a',runId:'run',source:'MANUAL',outcome:'ACCEPTED',timeBucket:0,utcOffsetMinutes:480})).toBe('1970-01-01 08:00 UTC+08:00');
    expect(historyTime({targetId:'b',runId:'run',source:'ROUTINE',outcome:'UNKNOWN',timeBucket:0,utcOffsetMinutes:-330})).toBe('1969-12-31 18:30 UTC-05:30');
  });
});
