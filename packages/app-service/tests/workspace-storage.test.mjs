import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspacePageSchema, launchAuthorityActionSchema, workspaceLimits } from '@pet-desktop/contracts/workspace';
import { WorkspaceStorage, WorkspaceStorageError, WORKSPACE_MIGRATION_SQL } from '../src/workspace-storage.ts';

const DAY = 86_400_000, now = 1_800_000_000_000;
const localId = { volumeSerial: '1'.repeat(16), fileId: '2'.repeat(32) };
const editor = { kind: 'WIN32_EXE', locator: 'C:\\Program Files\\私密项目\\Editor.exe',
  fingerprint: { kind: 'EXECUTABLE', identity: localId, sha256: 'a'.repeat(64), sizeBytes: 111, modifiedAtMs: 1000 } };
const folder = { kind: 'FOLDER', locator: 'C:\\Users\\私密用户\\Projects', fingerprint: { kind: 'DIRECTORY', identity: localId } };
const web = { kind: 'HTTPS', locator: 'https://example.com/private-path?q=tea', fingerprint: { kind: 'HTTPS', canonicalUrl: 'https://example.com/private-path?q=tea' } };
const sevenDaysAgo = now - 7 * DAY;
function input(id = 'editor', target = editor, options = {}) {
  return { id, label: id, target, approvedAt: now - 40 * DAY, enabled: true, recommendable: true, ...options };
}
function routine(targetIds, options = {}) {
  return { name: '工作组合', targetIds, mode: 'SEQUENTIAL', delayMs: 500, failurePolicy: 'STOP', skipDuplicates: true, ...options };
}
function fact(targetId = 'editor', runId = 'run-1', timeBucket = now - DAY, source = 'MANUAL', outcome = 'ACCEPTED') {
  return { targetId, runId, timeBucket, source, outcome, utcOffsetMinutes: 480 };
}

/** Real SQLite, exactly one injected connection and an external UnitOfWork
 * guard matching the future shared repository mount. No mock SQL engine. */
function connect(db, migrate = true) {
  db.exec('PRAGMA foreign_keys=ON');
  if (migrate) db.exec(WORKSPACE_MIGRATION_SQL);
  let active = false;
  const storage = new WorkspaceStorage(db, () => active);
  const tx = (work) => {
    if (active) throw new Error('nested tx in test');
    db.exec('BEGIN IMMEDIATE');
    active = true;
    try {
      const result = work(storage, db);
      active = false;
      db.exec('COMMIT');
      return result;
    } catch (error) {
      active = false;
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return { storage, tx, db };
}
function withMemory(work) {
  const connection = new DatabaseSync(':memory:');
  const test = connect(connection);
  try { return work(test); } finally { connection.close(); }
}
function add(storage, raw) { return storage.addApprovedAction(raw, storage.getRevision()); }
function enable(storage, retentionDays = 30) {
  return storage.updateSettings({ enabled: true, retentionDays }, storage.getRevision(), now);
}
const expectCode = (work, code) => expect(work).toThrow(new WorkspaceStorageError(code));

describe('workspace storage authority and shared transaction', () => {
  it('is additive, opt-out by default, and refuses every query outside the existing transaction scope', () => withMemory(({ storage, tx, db }) => {
    expectCode(() => storage.getRevision(), 'INACTIVE');
    expectCode(() => storage.getLaunchAction('editor'), 'INACTIVE');
    expect(tx(s => s.getPage(now, 480))).toEqual({ revision: 0, actions: [], routines: [], settings: { enabled: false, retentionDays: 30 },
      history: [], preferences: [], recommendations: [], shownToday: 0 });
    tx(s => { add(s, input()); expect(s.recordLaunchOutcome(fact(), now, 0)).toBe(false); expect(s.recordRecommendationImpression('imp-1', now, 480)).toBe(false); });
    expect(db.prepare('SELECT COUNT(*) AS count FROM launch_history').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM recommendation_impressions').get().count).toBe(0);
    expect(() => tx((_s, connection) => connection.prepare('INSERT INTO launch_history VALUES(?,?,?,?,?,?)')
      .run('editor', 'bypass', 'MANUAL', 'ACCEPTED', now, 480))).toThrow();
  }));

  it('projects exact saved authority only to Main, safe preview to UI, and approved ID/name only to AI', () => withMemory(({ tx }) => {
    tx(s => {
      const editorRecord = add(s, input('editor', editor, { label: '编辑器' }));
      add(s, input('folder', folder, { label: '项目目录', recommendable: false }));
      add(s, input('web', web, { label: '文档', enabled: false }));
      expect(editorRecord.revision).toBe(0);
      const authority = s.getLaunchAction('editor');
      expect(authority).toEqual({ ...editor, id: 'editor', label: '编辑器', approvedAt: now - 40 * DAY, revision: 0, enabled: true });
      expect(launchAuthorityActionSchema.safeParse(authority).success).toBe(true);
      expect(authority).not.toHaveProperty('recommendable');
      const actions = s.listQuickActions();
      expect(actions).toEqual([
        { id: 'editor', label: '编辑器', kind: 'WIN32_EXE', revision: 0, approved: true, enabled: true, recommendable: true, preview: 'Editor.exe' },
        { id: 'folder', label: '项目目录', kind: 'FOLDER', revision: 0, approved: true, enabled: true, recommendable: false, preview: 'Projects' },
        { id: 'web', label: '文档', kind: 'HTTPS', revision: 0, approved: true, enabled: false, recommendable: true, preview: 'example.com' },
      ]);
      expect(s.listAiActions(now)).toEqual([{ targetId: 'editor', label: '编辑器' }]);
      expect(workspacePageSchema.safeParse(s.getPage(now, 480)).success).toBe(true);
      const publicJson = JSON.stringify(s.getPage(now, 480));
      expect(publicJson).not.toContain('私密');
      expect(publicJson).not.toContain('private-path');
      expect(publicJson).not.toContain('fingerprint');
      expect(publicJson).not.toContain('locator');
    });
  }));

  it('rejects stale workspace/action revisions, ID collisions and renderer-like malformed target data without partial changes', () => withMemory(({ tx }) => {
    tx(s => { add(s, input()); });
    expectCode(() => tx(s => s.addApprovedAction(input('new'), 0)), 'REVISION_CONFLICT');
    expectCode(() => tx(s => add(s, input())), 'CONFLICT');
    expectCode(() => tx(s => add(s, input('unsafe', { ...editor, locator: 'C:\\Apps\\cmd.exe' }))), 'INVALID_RECORD');
    expectCode(() => tx(s => s.updateActionMetadata('editor', 1, { label: '新名字', enabled: true, recommendable: true })), 'REVISION_CONFLICT');
    expectCode(() => tx(s => s.updateActionMetadata('editor', 0, { label: '新名字', enabled: true, recommendable: true, locator: web.locator })), 'INVALID_RECORD');
    expect(tx(s => s.getRevision())).toBe(1);
    expect(tx(s => s.getLaunchAction('editor')).locator).toBe(editor.locator);
  }));

  it('uses explicit native reapproval to change the exact target, bumps scene revisions and drops old usage evidence', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input());
      add(s, input('folder', folder));
      s.createRoutine('scene', routine(['editor', 'folder']), s.getRevision());
      enable(s);
      expect(s.recordLaunchOutcome(fact(), now, 0)).toBe(true);
      const replaced = s.reapproveAction('editor', 0, s.getRevision(), input('editor', web, { approvedAt: now }));
      expect(replaced).toMatchObject({ revision: 1, kind: 'HTTPS', locator: web.locator, approvedAt: now });
      expect(s.getRoutine('scene').revision).toBe(1);
      expect(s.listLaunchHistory(now)).toEqual([]);
      // Same time bucket and ID cannot train the replacement using a stale run.
      expect(s.recordLaunchOutcome(fact('editor', 'late-old-run', now), now, 0)).toBe(false);
      expect(s.recordLaunchOutcome(fact('editor', 'new-run', now), now, 1)).toBe(true);
    });
    expectCode(() => tx(s => s.reapproveAction('editor', 1, 0, input('editor', editor))), 'REVISION_CONFLICT');
    expectCode(() => tx(s => s.reapproveAction('editor', 0, s.getRevision(), input('editor', editor))), 'REVISION_CONFLICT');
    expect(tx(s => s.getLaunchAction('editor')).locator).toBe(web.locator);
  }));

  it('revocation removes locator, fingerprint and reusable approval; history deletion is explicit and metadata cannot restore consent', () => withMemory(({ tx, db }) => {
    tx(s => {
      add(s, input());
      enable(s);
      s.recordLaunchOutcome(fact(), now, 0);
      const revoked = s.revokeAction('editor', 0, false);
      expect(revoked).toEqual({ id: 'editor', kind: 'WIN32_EXE', label: 'editor', revision: 1,
        approvedAt: null, locator: null, fingerprint: null, enabled: false, recommendable: false });
      expect(s.getLaunchAction('editor')).toBeNull();
      expect(s.listQuickActions()[0]).toMatchObject({ approved: false, preview: null, enabled: false });
      expect(s.listAiActions(now)).toEqual([]);
      expect(s.listLaunchHistory(now)).toHaveLength(1);
      expect(s.recordLaunchOutcome(fact('editor', 'late'), now, 1)).toBe(false);
    });
    expect(db.prepare('SELECT locator,fingerprint_json,approved_at FROM quick_actions').get()).toMatchObject({
      locator: null, fingerprint_json: null, approved_at: null,
    });
    expectCode(() => tx(s => s.updateActionMetadata('editor', 1, { label: '改名', enabled: true, recommendable: true })), 'FORBIDDEN');
    tx(s => { s.revokeAction('editor', 1, true); expect(s.listLaunchHistory(now)).toEqual([]); });
    tx(s => {
      s.reapproveAction('editor', 2, s.getRevision(), input('editor', folder, { approvedAt: now }));
      expect(s.getLaunchAction('editor')).toMatchObject({ kind: 'FOLDER', revision: 3 });
    });
  }));

  it('delete cascades history/preferences, removes only the selected action from ordered scenes, and deletes any now-empty scene', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input('editor', editor)); add(s, input('folder', folder)); add(s, input('web', web));
      s.createRoutine('mixed', routine(['web', 'editor', 'folder']), s.getRevision());
      s.createRoutine('single', routine(['editor']), s.getRevision());
      enable(s);
      s.recordLaunchOutcome(fact('editor'), now, 0);
      s.recordLaunchOutcome(fact('folder'), now, 0);
      s.setRecommendationPreference({ targetId: 'editor', ignoredUntil: null, permanentlyExcluded: true }, s.getRevision());
      s.deleteAction('editor', 0);
      expect(s.getActionRecord('editor')).toBeNull();
      expect(s.getRoutine('mixed')).toMatchObject({ targetIds: ['web', 'folder'], revision: 1 });
      expect(s.getRoutine('single')).toBeNull();
      expect(s.listLaunchHistory(now).map(row => row.targetId)).toEqual(['folder']);
      expect(s.listRecommendationPreferences()).toEqual([]);
      expect(workspacePageSchema.safeParse(s.getPage(now, 480)).success).toBe(true);
    });
  }));

  it('rolls all workspace/game writes back in the owning UnitOfWork; no independent transaction or connection', () => withMemory(({ tx, db, storage }) => {
    db.exec('CREATE TABLE unrelated_app_state(value TEXT) STRICT');
    expect(() => tx((s, connection) => {
      connection.prepare('INSERT INTO unrelated_app_state VALUES(?)').run('temporary');
      add(s, input());
      s.createRoutine('scene', routine(['editor']), s.getRevision());
      throw new Error('abort owning operation');
    })).toThrow('abort owning operation');
    expect(db.prepare('SELECT COUNT(*) AS count FROM unrelated_app_state').get().count).toBe(0);
    expect(tx(s => s.getRevision())).toBe(0);
    expect(tx(s => s.listQuickActions())).toEqual([]);
    expect(tx(s => s.listRoutines())).toEqual([]);
    expectCode(() => storage.listRoutines(), 'INACTIVE');
  }));

  it('persists the approved and revoked states across actual local database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pet-workspace-storage-test-'));
    const filename = join(directory, 'state.sqlite3');
    let db = new DatabaseSync(filename);
    try {
      let { tx } = connect(db);
      tx(s => { add(s, input()); add(s, input('folder', folder)); enable(s); s.recordLaunchOutcome(fact(), now, 0); s.revokeAction('folder', 0, true); });
      db.close();
      db = new DatabaseSync(filename);
      ({ tx } = connect(db, false));
      expect(tx(s => s.getLaunchAction('editor')).locator).toBe(editor.locator);
      expect(tx(s => s.getLaunchAction('folder'))).toBeNull();
      expect(tx(s => s.listLaunchHistory(now))).toEqual([fact()]);
      expect(tx(s => s.getRecommendationSettings())).toEqual({ enabled: true, retentionDays: 30 });
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('routine persistence, deterministic order and no auto-execution', () => {
  it('round-trips ordered IDs, supported sequential/parallel policies and revision changes', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input('a')); add(s, input('b', folder)); add(s, input('c', web));
      const first = s.createRoutine('scene', routine(['c', 'a', 'b']), s.getRevision());
      expect(first).toMatchObject({ targetIds: ['c', 'a', 'b'], revision: 0, skipDuplicates: true });
      expect(s.getRoutine('scene')).toEqual(first);
      const edited = s.updateRoutine('scene', 0, routine(['b', 'c'], { mode: 'PARALLEL', delayMs: 0, failurePolicy: 'CONTINUE' }));
      expect(s.getRoutine('scene')).toEqual(edited);
      expect(edited.revision).toBe(1);
      s.deleteRoutine('scene', 1);
      expect(s.listRoutines()).toEqual([]);
      expect(s.listQuickActions()).toHaveLength(3);
    });
  }));

  it('rejects duplicate/unknown/revoked/disabled target definitions and stale routine changes', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input('valid'));
      add(s, input('disabled', folder, { enabled: false }));
      add(s, input('revoked', web));
      s.revokeAction('revoked', 0, true);
      s.createRoutine('valid-scene', routine(['valid']), s.getRevision());
    });
    for (const targetIds of [['missing'], ['disabled'], ['revoked']]) {
      expectCode(() => tx(s => s.createRoutine('bad', routine(targetIds), s.getRevision())), 'FORBIDDEN');
    }
    expectCode(() => tx(s => s.createRoutine('bad', routine(['valid', 'valid']), s.getRevision())), 'INVALID_RECORD');
    expectCode(() => tx(s => s.updateRoutine('valid-scene', 1, routine(['valid']))), 'REVISION_CONFLICT');
    expect(tx(s => s.listRoutines())).toHaveLength(1);
    tx(s => { s.updateActionMetadata('valid', 0, { label: '改名', enabled: false, recommendable: false }); });
    expect(tx(s => s.getRoutine('valid-scene')).revision).toBe(1);
    // Keeping the ID in a now-disabled routine does not confer launch authority.
    expect(tx(s => s.getRoutine('valid-scene')).targetIds).toEqual(['valid']);
  }));

  it('enforces bounded action/routine capacities and foreign keys rather than truncating saved definitions', () => withMemory(({ tx }) => {
    tx(s => {
      for (let index = 0; index < workspaceLimits.actions; index++) add(s, input('target-' + index));
      expect(s.listQuickActions()).toHaveLength(workspaceLimits.actions);
      for (let index = 0; index < workspaceLimits.routines; index++) s.createRoutine('scene-' + index, routine(['target-0']), s.getRevision());
      expect(s.listRoutines()).toHaveLength(workspaceLimits.routines);
    });
    expectCode(() => tx(s => add(s, input('overflow'))), 'CAPACITY');
    expectCode(() => tx(s => s.createRoutine('overflow', routine(['target-0']), s.getRevision())), 'CAPACITY');
    expect(() => tx((_s, db) => db.prepare('INSERT INTO routine_targets VALUES(?,?,?)').run('scene-0', 1, 'missing'))).toThrow();
  }));
});

describe('opt-in local app-run facts, recommendation preferences and impressions', () => {
  it('stores only enumerated app-origin bucketed outcomes; duplicate run receipt is first-wins and history writes stop when disabled', () => withMemory(({ tx, db }) => {
    tx(s => {
      add(s, input()); enable(s);
      for (const [i, outcome] of ['ACCEPTED', 'FAILED', 'SKIPPED', 'UNKNOWN'].entries()) {
        expect(s.recordLaunchOutcome(fact('editor', 'run-' + i, now - i * workspaceLimits.timeBucketMs, 'MANUAL', outcome), now, 0)).toBe(true);
      }
      expect(s.recordLaunchOutcome(fact('editor', 'run-0', now, 'MANUAL', 'FAILED'), now, 0)).toBe(false);
      expect(s.recordLaunchOutcome(fact('editor', 'late', now), now, 1)).toBe(false);
      expect(s.listLaunchHistory(now).find(row => row.runId === 'run-0').outcome).toBe('ACCEPTED');
      const saved = s.listLaunchHistory(now);
      s.updateSettings({ enabled: false, retentionDays: 30 }, s.getRevision(), now);
      expect(s.recordLaunchOutcome(fact('editor', 'stopped'), now, 0)).toBe(false);
      expect(s.listLaunchHistory(now)).toEqual(saved);
      expect(s.recordRecommendationImpression('stopped', now, 480)).toBe(false);
    });
    expect(db.prepare('PRAGMA table_info(launch_history)').all().map(row => row.name)).toEqual([
      'target_id', 'run_id', 'source', 'outcome', 'time_bucket', 'utc_offset_minutes',
    ]);
    expectCode(() => tx(s => s.recordLaunchOutcome({ ...fact(), locator: editor.locator }, now, 0)), 'INVALID_RECORD');
  }));

  it('prunes rolling 7/30-day retention and never saves future/expired buckets', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input()); enable(s, 30);
      expect(s.recordLaunchOutcome(fact('editor', 'too-old', now - 31 * DAY), now, 0)).toBe(false);
      expect(s.recordLaunchOutcome(fact('editor', 'at-30', now - 30 * DAY), now, 0)).toBe(false);
      expect(s.recordLaunchOutcome(fact('editor', 'old', now - 8 * DAY), now, 0)).toBe(true);
      expect(s.recordLaunchOutcome(fact('editor', 'at-7', sevenDaysAgo), now, 0)).toBe(true);
      expect(s.recordLaunchOutcome(fact('editor', 'recent', now - DAY), now, 0)).toBe(true);
      expect(s.recordLaunchOutcome(fact('editor', 'future', now + workspaceLimits.timeBucketMs), now, 0)).toBe(false);
      expect(s.listLaunchHistory(now)).toHaveLength(3);
      s.updateSettings({ enabled: true, retentionDays: 7 }, s.getRevision(), now);
      expect(s.listLaunchHistory(now).map(row => row.runId)).toEqual(['recent']);
    });
  }));

  it('enforces bounded newest 1000 history facts in SQLite and leaves no invisible overflow rows', () => withMemory(({ tx, db }) => {
    tx(s => {
      add(s, input()); enable(s);
      for (let i = workspaceLimits.history + 2; i >= 0; i--) {
        s.recordLaunchOutcome(fact('editor', 'run-' + i, now - i * workspaceLimits.timeBucketMs), now, 0);
      }
      const history = s.listLaunchHistory(now);
      expect(history).toHaveLength(workspaceLimits.history);
      expect(history[0].runId).toBe('run-0');
      expect(history.at(-1).runId).toBe('run-999');
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM launch_history').get().count).toBe(workspaceLimits.history);
  }));

  it('derives local recommendations via domain engine, not automatic launches; actual impressions only, two per day', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input('editor', editor, { label: '编辑器' })); add(s, input('folder', folder, { label: '项目' }));
      enable(s);
      for (let i = 1; i <= 3; i++) {
        s.recordLaunchOutcome(fact('editor', 'editor-' + i, now - i * DAY), now, 0);
        s.recordLaunchOutcome(fact('folder', 'routine-' + i, now - i * DAY, 'ROUTINE'), now, 0);
        s.recordLaunchOutcome(fact('folder', 'failed-' + i, now - i * DAY, 'MANUAL', 'FAILED'), now, 0);
        s.recordLaunchOutcome(fact('folder', 'suggest-' + i, now - i * DAY, 'SUGGESTION'), now, 0);
      }
      const first = s.getPage(now, 480);
      expect(first.recommendations.map(row => row.targetId)).toEqual(['editor']);
      expect(first.recommendations[0].evidence.count30).toBe(3);
      expect(first.shownToday).toBe(0);
      expect(s.getPage(now, 480).shownToday).toBe(0); // computing does not consume impression quota
      expect(s.recordRecommendationImpression('imp-1', now, 480)).toBe(true);
      expect(s.recordRecommendationImpression('imp-1', now, 480)).toBe(false);
      expect(s.recordRecommendationImpression('imp-2', now, 480)).toBe(true);
      expect(s.recordRecommendationImpression('imp-3', now, 480)).toBe(false);
      expect(s.shownToday(now, 480)).toBe(2);
      expect(s.listRecommendations(now, 480)).toEqual([]);
      expect(s.shownToday(now + DAY, 480)).toBe(0);
      expect(s.recordRecommendationImpression('next-day', now + DAY, 480)).toBe(true);
    });
  }));

  it('supports finite ignore/permanent exclusion, excludes them from AI and local recommendations, and respects opt-out/history clear', () => withMemory(({ tx }) => {
    tx(s => {
      add(s, input()); enable(s);
      for (let i = 1; i <= 3; i++) s.recordLaunchOutcome(fact('editor', 'run-' + i, now - i * DAY), now, 0);
      expect(s.listRecommendations(now, 480)).toHaveLength(1);
      s.setRecommendationPreference({ targetId: 'editor', permanentlyExcluded: false, ignoredUntil: now + DAY }, s.getRevision());
      expect(s.listRecommendations(now, 480)).toEqual([]);
      expect(s.listAiActions(now)).toEqual([]);
      expect(s.listAiActions(now + DAY)).toHaveLength(1);
      s.setRecommendationPreference({ targetId: 'editor', permanentlyExcluded: true, ignoredUntil: null }, s.getRevision());
      expect(s.listRecommendations(now + DAY, 480)).toEqual([]);
      expect(s.listAiActions(now + DAY)).toEqual([]);
      s.setRecommendationPreference({ targetId: 'editor', permanentlyExcluded: false, ignoredUntil: null }, s.getRevision());
      expect(s.listRecommendationPreferences()).toEqual([]);
      s.recordRecommendationImpression('one', now, 480);
      s.recordRecommendationImpression('two', now, 480);
      expect(s.clearLaunchHistory(s.getRevision(), 'editor')).toBe(3);
      s.updateSettings({ enabled: false, retentionDays: 30 }, s.getRevision(), now, true);
      expect(s.listLaunchHistory(now)).toEqual([]);
      s.updateSettings({ enabled: true, retentionDays: 30 }, s.getRevision(), now);
      expect(s.shownToday(now, 480)).toBe(2); // clearing stats cannot reset today's actual-impression cap
      expect(s.recordRecommendationImpression('third', now, 480)).toBe(false);
    });
  }));

  it('SQL itself prevents records while off or for revoked actions, and prohibits a third actual impression on the same day', () => withMemory(({ tx }) => {
    tx(s => { add(s, input()); enable(s); s.revokeAction('editor', 0, true); });
    expect(() => tx((_s, db) => db.prepare('INSERT INTO launch_history VALUES(?,?,?,?,?,?)')
      .run('editor', 'raw', 'MANUAL', 'ACCEPTED', now, 480))).toThrow();
    tx(s => { s.recordRecommendationImpression('first', now, 480); s.recordRecommendationImpression('second', now, 480); });
    const day = Math.floor((now + 480 * 60_000) / DAY);
    expect(() => tx((_s, db) => db.prepare('INSERT INTO recommendation_impressions VALUES(?,?)').run(day, 'third'))).toThrow();
  }));
});
