import {
  aiQuickActionSchema, approvedActionInputSchema, launchAuthorityActionSchema, launchHistoryFactSchema,
  quickActionMetadataSchema, quickActionRecordSchema, quickActionViewSchema, recommendationPreferenceSchema,
  recommendationSettingsSchema, routineDefinitionSchema, routineSchema, workspaceLimits, workspacePageSchema,
} from '@pet-desktop/contracts/workspace';
import type {
  AiQuickAction, ApprovedActionInput, LaunchAuthorityAction, LaunchHistoryFact, LocalRecommendation, QuickActionMetadata,
  QuickActionRecord, QuickActionView, RecommendationPreference, RecommendationSettings, Routine, RoutineDefinition, WorkspacePage,
} from '@pet-desktop/contracts/workspace';
import { recommendTargets } from '@pet-desktop/domain/recommendation-engine';
import type { SqliteConnection } from './ports.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DAY = 86_400_000;
const MINUTE = 60_000;
const MAX_TIME = 8_640_000_000_000_000 - DAY;
const idCheck = (column: string): string => `length(${column}) BETWEEN 1 AND 128 AND ${column} GLOB '[A-Za-z0-9]*' AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const unsigned = (column: string): string => `${column} BETWEEN 0 AND ${MAX_SAFE}`;

/** Additive DDL for the shared repository's later migration. The class below
 * never opens a database, runs this migration, starts a transaction, or
 * bypasses the existing single-writer scope. Do not alter after mounting. */
export const WORKSPACE_MIGRATION_SQL = `
CREATE TABLE workspace_settings (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(${unsigned('revision')}),
  recommendation_enabled INTEGER NOT NULL CHECK(recommendation_enabled IN (0,1)),
  retention_days INTEGER NOT NULL CHECK(retention_days IN (7,30))
) STRICT;
INSERT INTO workspace_settings VALUES(1,0,0,30);
CREATE TABLE quick_actions (
  action_id TEXT PRIMARY KEY NOT NULL CHECK(${idCheck('action_id')}),
  kind TEXT NOT NULL CHECK(kind IN ('WIN32_EXE','FOLDER','HTTPS')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  locator TEXT,
  fingerprint_json TEXT,
  revision INTEGER NOT NULL CHECK(${unsigned('revision')}),
  approved_at INTEGER CHECK(${unsigned('approved_at')}),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  recommendable INTEGER NOT NULL CHECK(recommendable IN (0,1)),
  CHECK((approved_at IS NOT NULL AND locator IS NOT NULL AND length(locator) BETWEEN 1 AND 2048
    AND fingerprint_json IS NOT NULL AND json_valid(fingerprint_json) AND json_type(fingerprint_json)='object')
    OR (approved_at IS NULL AND locator IS NULL AND fingerprint_json IS NULL AND enabled=0 AND recommendable=0))
) STRICT;
CREATE TRIGGER quick_actions_limit BEFORE INSERT ON quick_actions
WHEN (SELECT COUNT(*) FROM quick_actions)>=100
BEGIN SELECT RAISE(ABORT,'Workspace action capacity'); END;
CREATE TABLE routines (
  routine_id TEXT PRIMARY KEY NOT NULL CHECK(${idCheck('routine_id')}),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL CHECK(${unsigned('revision')}),
  mode TEXT NOT NULL CHECK(mode IN ('SEQUENTIAL','PARALLEL')),
  delay_ms INTEGER NOT NULL CHECK(delay_ms BETWEEN 0 AND 5000),
  failure_policy TEXT NOT NULL CHECK(failure_policy IN ('CONTINUE','STOP')),
  skip_duplicates INTEGER NOT NULL CHECK(skip_duplicates=1),
  CHECK(mode='SEQUENTIAL' OR (delay_ms=0 AND failure_policy='CONTINUE'))
) STRICT;
CREATE TRIGGER routines_limit BEFORE INSERT ON routines
WHEN (SELECT COUNT(*) FROM routines)>=100
BEGIN SELECT RAISE(ABORT,'Workspace routine capacity'); END;
CREATE TABLE routine_targets (
  routine_id TEXT NOT NULL REFERENCES routines(routine_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 11),
  target_id TEXT NOT NULL REFERENCES quick_actions(action_id) ON DELETE RESTRICT,
  PRIMARY KEY(routine_id,position), UNIQUE(routine_id,target_id)
) STRICT;
CREATE INDEX routine_targets_action ON routine_targets(target_id,routine_id);
CREATE TABLE launch_history (
  target_id TEXT NOT NULL REFERENCES quick_actions(action_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK(${idCheck('run_id')}),
  source TEXT NOT NULL CHECK(source IN ('MANUAL','ROUTINE','SUGGESTION')),
  outcome TEXT NOT NULL CHECK(outcome IN ('ACCEPTED','FAILED','SKIPPED','UNKNOWN')),
  time_bucket INTEGER NOT NULL CHECK(${unsigned('time_bucket')} AND time_bucket%300000=0),
  utc_offset_minutes INTEGER NOT NULL CHECK(utc_offset_minutes BETWEEN -840 AND 840),
  PRIMARY KEY(target_id,run_id)
) STRICT;
CREATE INDEX launch_history_bucket ON launch_history(time_bucket,target_id,run_id);
CREATE TRIGGER launch_history_opt_in BEFORE INSERT ON launch_history
WHEN NOT EXISTS(SELECT 1 FROM workspace_settings WHERE singleton=1 AND recommendation_enabled=1)
  OR NOT EXISTS(SELECT 1 FROM quick_actions WHERE action_id=NEW.target_id AND approved_at IS NOT NULL AND enabled=1)
BEGIN SELECT RAISE(ABORT,'Launch statistics not permitted'); END;
CREATE TRIGGER launch_history_limit AFTER INSERT ON launch_history BEGIN
  DELETE FROM launch_history WHERE rowid IN (
    SELECT rowid FROM launch_history ORDER BY time_bucket DESC,target_id,run_id LIMIT -1 OFFSET 1000
  );
END;
CREATE TABLE recommendation_preferences (
  target_id TEXT PRIMARY KEY NOT NULL REFERENCES quick_actions(action_id) ON DELETE CASCADE,
  ignored_until INTEGER CHECK(${unsigned('ignored_until')}),
  permanently_excluded INTEGER NOT NULL CHECK(permanently_excluded IN (0,1)),
  CHECK(permanently_excluded=0 OR ignored_until IS NULL)
) STRICT;
CREATE TABLE recommendation_impressions (
  local_day INTEGER NOT NULL CHECK(local_day BETWEEN -1 AND 100000001),
  impression_id TEXT NOT NULL CHECK(${idCheck('impression_id')}),
  PRIMARY KEY(local_day,impression_id)
) STRICT;
CREATE TRIGGER recommendation_impression_opt_in BEFORE INSERT ON recommendation_impressions
WHEN NOT EXISTS(SELECT 1 FROM workspace_settings WHERE singleton=1 AND recommendation_enabled=1)
BEGIN SELECT RAISE(ABORT,'Recommendation impressions not permitted'); END;
CREATE TRIGGER recommendation_impression_daily_limit BEFORE INSERT ON recommendation_impressions
WHEN NOT EXISTS(SELECT 1 FROM recommendation_impressions WHERE local_day=NEW.local_day AND impression_id=NEW.impression_id)
AND (SELECT COUNT(*) FROM recommendation_impressions WHERE local_day=NEW.local_day)>=2
BEGIN SELECT RAISE(ABORT,'Recommendation daily impression limit'); END;
`;

export type WorkspaceStorageErrorCode = 'INACTIVE' | 'INVALID_RECORD' | 'REVISION_CONFLICT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CAPACITY' | 'CONFLICT';
export class WorkspaceStorageError extends Error {
  readonly code: WorkspaceStorageErrorCode;
  constructor(code: WorkspaceStorageErrorCode) { super(code); this.name = 'WorkspaceStorageError'; this.code = code; }
}
function fail(code: WorkspaceStorageErrorCode): never { throw new WorkspaceStorageError(code); }
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
function id(value: unknown): string { if (!safeId(value)) fail('INVALID_RECORD'); return value; }
function uint(value: unknown, max = MAX_SAFE): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_RECORD');
  return value;
}
function offset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -840 || value > 840) fail('INVALID_RECORD');
  return value;
}
function bool(value: unknown): boolean { if (value !== 0 && value !== 1) fail('INVALID_RECORD'); return value === 1; }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RECORD');
  return value as Record<string, unknown>;
}
function json(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 4096) fail('INVALID_RECORD');
  try { return JSON.parse(value); } catch { return fail('INVALID_RECORD'); }
}
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  try { const result = schema.safeParse(value); if (result.success) return result.data; } catch { /* sanitized */ }
  return fail('INVALID_RECORD');
}
function changed(value: number | bigint): number { return uint(typeof value === 'bigint' ? Number(value) : value); }
function one(value: number | bigint): void { if (changed(value) !== 1) fail('REVISION_CONFLICT'); }
function currentDay(now: number, utcOffsetMinutes: number): number { return Math.floor((uint(now, MAX_TIME) + offset(utcOffsetMinutes) * MINUTE) / DAY); }

function actionFromRow(value: unknown): QuickActionRecord {
  const r = row(value);
  return parse(quickActionRecordSchema, { id: r.action_id, kind: r.kind, label: r.label, locator: r.locator,
    fingerprint: r.fingerprint_json === null ? null : json(r.fingerprint_json), revision: uint(r.revision),
    approvedAt: r.approved_at === null ? null : uint(r.approved_at), enabled: bool(r.enabled), recommendable: bool(r.recommendable) });
}
function launchProjection(action: QuickActionRecord): LaunchAuthorityAction | null {
  if (action.approvedAt === null) return null;
  const { recommendable: _recommendable, ...target } = action;
  return parse(launchAuthorityActionSchema, target);
}
function safePreview(action: QuickActionRecord): string | null {
  if (action.approvedAt === null) return null;
  if (action.kind === 'HTTPS') return /^https:\/\/([^/]+)/u.exec(action.locator)?.[1] ?? fail('INVALID_RECORD');
  if (action.locator.length === 3) return '本机目录';
  return action.locator.split('\\').at(-1) ?? fail('INVALID_RECORD');
}
function actionView(action: QuickActionRecord): QuickActionView {
  return parse(quickActionViewSchema, { id: action.id, label: action.label, kind: action.kind, revision: action.revision,
    approved: action.approvedAt !== null, enabled: action.enabled, recommendable: action.recommendable, preview: safePreview(action) });
}
function historyFromRow(value: unknown): LaunchHistoryFact {
  const r = row(value);
  return parse(launchHistoryFactSchema, { targetId: r.target_id, runId: r.run_id, source: r.source, outcome: r.outcome,
    timeBucket: r.time_bucket, utcOffsetMinutes: r.utc_offset_minutes });
}

/** Authority-only synchronous workspace persistence on the existing scoped
 * transaction. All failures must abort the owning repository transaction;
 * never catch a failed multi-statement mutation and commit its partial writes.
 * No OS launches, native dialogs, network, telemetry or automatic execution. */
export class WorkspaceStorage {
  private readonly connection: SqliteConnection;
  private readonly inScope: () => boolean;
  constructor(connection: SqliteConnection, inScope: () => boolean) { this.connection = connection; this.inScope = inScope; }

  private get db(): SqliteConnection { if (!this.inScope()) fail('INACTIVE'); return this.connection; }
  private settingsRow(): Record<string, unknown> { return row(this.db.prepare('SELECT * FROM workspace_settings WHERE singleton=1').get()); }
  getRevision(): number { return uint(this.settingsRow().revision); }
  getRecommendationSettings(): RecommendationSettings {
    const r = this.settingsRow();
    return parse(recommendationSettingsSchema, { enabled: bool(r.recommendation_enabled), retentionDays: r.retention_days });
  }
  private requireWorkspaceRevision(expected: number): void {
    if (this.getRevision() !== uint(expected) || expected === MAX_SAFE) fail('REVISION_CONFLICT');
  }
  private requireWorkspaceRoom(): void { if (this.getRevision() === MAX_SAFE) fail('REVISION_CONFLICT'); }
  private bumpWorkspace(): void {
    one(this.db.prepare('UPDATE workspace_settings SET revision=revision+1 WHERE singleton=1 AND revision<?').run(MAX_SAFE).changes);
  }

  getActionRecord(actionId: string): QuickActionRecord | null {
    const value = this.db.prepare('SELECT * FROM quick_actions WHERE action_id=?').get(id(actionId));
    return value === undefined || value === null ? null : actionFromRow(value);
  }
  listActionRecords(): QuickActionRecord[] {
    const rows = this.db.prepare('SELECT * FROM quick_actions ORDER BY action_id LIMIT ?').all(workspaceLimits.actions + 1);
    if (rows.length > workspaceLimits.actions) fail('CAPACITY');
    return rows.map(actionFromRow);
  }
  /** This method is deliberately not part of any UI/AI DTO. Main must be the
   * only recipient of the exact location/identity record. */
  getLaunchAction(actionId: string): LaunchAuthorityAction | null {
    const action = this.getActionRecord(actionId);
    return action ? launchProjection(action) : null;
  }
  listQuickActions(): QuickActionView[] { return this.listActionRecords().map(actionView); }
  listAiActions(now?: number): AiQuickAction[] {
    if (now !== undefined) uint(now, MAX_TIME);
    const prefs = new Map(this.listRecommendationPreferences().map(pref => [pref.targetId, pref]));
    return this.listActionRecords().filter(action => action.approvedAt !== null && action.enabled && action.recommendable)
      .filter(action => {
        const pref = prefs.get(action.id);
        return !pref?.permanentlyExcluded && (pref?.ignoredUntil === undefined || pref.ignoredUntil === null
          || (now !== undefined && pref.ignoredUntil <= now));
      })
      .map(action => parse(aiQuickActionSchema, { targetId: action.id, label: action.label }));
  }

  /** Called only with a freshly consumed native Main approval. Renderer IDs
   * and labels alone can never instantiate this authority record. */
  addApprovedAction(raw: ApprovedActionInput, expectedWorkspaceRevision: number): QuickActionRecord {
    const input = parse(approvedActionInputSchema, raw);
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    if (this.getActionRecord(input.id)) fail('CONFLICT');
    if (this.listActionRecords().length >= workspaceLimits.actions) fail('CAPACITY');
    const action = parse(quickActionRecordSchema, { ...input.target, id: input.id, label: input.label,
      revision: 0, approvedAt: input.approvedAt, enabled: input.enabled, recommendable: input.recommendable });
    this.db.prepare(`INSERT INTO quick_actions(action_id,kind,label,locator,fingerprint_json,revision,approved_at,enabled,recommendable)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(action.id, action.kind, action.label, action.locator, JSON.stringify(action.fingerprint),
      action.revision, action.approvedAt, Number(action.enabled), Number(action.recommendable));
    this.bumpWorkspace();
    return action;
  }

  private expectedAction(actionId: string, expectedRevision: number): QuickActionRecord {
    const action = this.getActionRecord(actionId);
    if (!action) fail('NOT_FOUND');
    if (action.revision !== uint(expectedRevision) || action.revision === MAX_SAFE) fail('REVISION_CONFLICT');
    return action;
  }
  private containingRoutines(actionId: string): Routine[] { return this.listRoutines().filter(routine => routine.targetIds.includes(actionId)); }
  private assureRoutineRoom(routines: readonly Routine[]): void { if (routines.some(routine => routine.revision === MAX_SAFE)) fail('REVISION_CONFLICT'); }
  private bumpRoutines(routines: readonly Routine[]): void {
    for (const routine of routines) one(this.db.prepare('UPDATE routines SET revision=revision+1 WHERE routine_id=? AND revision=?').run(routine.id, routine.revision).changes);
  }

  /** Reapproval is the only operation allowed to replace a locator or
   * fingerprint. Drop old usage evidence rather than training the replacement
   * on a different program/website. No prior locator is retained. */
  reapproveAction(actionId: string, expectedActionRevision: number, expectedWorkspaceRevision: number, raw: ApprovedActionInput): QuickActionRecord {
    const input = parse(approvedActionInputSchema, raw);
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    const previous = this.expectedAction(actionId, expectedActionRevision);
    if (input.id !== previous.id || (previous.approvedAt !== null && input.approvedAt < previous.approvedAt)) fail('INVALID_RECORD');
    const routines = this.containingRoutines(previous.id);
    this.assureRoutineRoom(routines);
    const action = parse(quickActionRecordSchema, { ...input.target, id: previous.id, label: input.label, revision: previous.revision + 1,
      approvedAt: input.approvedAt, enabled: input.enabled, recommendable: input.recommendable });
    one(this.db.prepare(`UPDATE quick_actions SET kind=?,label=?,locator=?,fingerprint_json=?,revision=?,approved_at=?,enabled=?,recommendable=?
      WHERE action_id=? AND revision=?`).run(action.kind, action.label, action.locator, JSON.stringify(action.fingerprint), action.revision,
      action.approvedAt, Number(action.enabled), Number(action.recommendable), previous.id, previous.revision).changes);
    this.db.prepare('DELETE FROM launch_history WHERE target_id=?').run(previous.id);
    this.bumpRoutines(routines);
    this.bumpWorkspace();
    return action;
  }

  updateActionMetadata(actionId: string, expectedRevision: number, raw: QuickActionMetadata): QuickActionRecord {
    const metadata = parse(quickActionMetadataSchema, raw);
    this.requireWorkspaceRoom();
    const previous = this.expectedAction(actionId, expectedRevision);
    if (previous.approvedAt === null && (metadata.enabled || metadata.recommendable)) fail('FORBIDDEN');
    const routines = this.containingRoutines(previous.id);
    this.assureRoutineRoom(routines);
    const action = parse(quickActionRecordSchema, { ...previous, ...metadata, revision: previous.revision + 1 });
    one(this.db.prepare('UPDATE quick_actions SET label=?,enabled=?,recommendable=?,revision=? WHERE action_id=? AND revision=?')
      .run(action.label, Number(action.enabled), Number(action.recommendable), action.revision, previous.id, previous.revision).changes);
    this.bumpRoutines(routines);
    this.bumpWorkspace();
    return action;
  }

  revokeAction(actionId: string, expectedRevision: number, clearHistory: boolean): QuickActionRecord {
    if (typeof clearHistory !== 'boolean') fail('INVALID_RECORD');
    this.requireWorkspaceRoom();
    const previous = this.expectedAction(actionId, expectedRevision);
    const routines = this.containingRoutines(previous.id);
    this.assureRoutineRoom(routines);
    const action = parse(quickActionRecordSchema, { id: previous.id, kind: previous.kind, label: previous.label,
      revision: previous.revision + 1, locator: null, fingerprint: null, approvedAt: null, enabled: false, recommendable: false });
    one(this.db.prepare(`UPDATE quick_actions SET locator=NULL,fingerprint_json=NULL,approved_at=NULL,enabled=0,recommendable=0,revision=?
      WHERE action_id=? AND revision=?`).run(action.revision, previous.id, previous.revision).changes);
    if (clearHistory) this.db.prepare('DELETE FROM launch_history WHERE target_id=?').run(previous.id);
    this.bumpRoutines(routines);
    this.bumpWorkspace();
    return action;
  }

  /** Delete only the selected ID/revision. Remove that ID from ordered
   * routines (deleting now-empty routines); history and preferences cascade. */
  deleteAction(actionId: string, expectedRevision: number): void {
    this.requireWorkspaceRoom();
    const previous = this.expectedAction(actionId, expectedRevision);
    const routines = this.containingRoutines(previous.id);
    this.assureRoutineRoom(routines.filter(routine => routine.targetIds.length > 1));
    for (const routine of routines) {
      const targets = routine.targetIds.filter(targetId => targetId !== previous.id);
      if (!targets.length) one(this.db.prepare('DELETE FROM routines WHERE routine_id=? AND revision=?').run(routine.id, routine.revision).changes);
      else {
        this.db.prepare('DELETE FROM routine_targets WHERE routine_id=?').run(routine.id);
        this.writeRoutineTargets(routine.id, targets);
        one(this.db.prepare('UPDATE routines SET revision=revision+1 WHERE routine_id=? AND revision=?').run(routine.id, routine.revision).changes);
      }
    }
    one(this.db.prepare('DELETE FROM quick_actions WHERE action_id=? AND revision=?').run(previous.id, previous.revision).changes);
    this.bumpWorkspace();
  }

  private routineFromRow(value: unknown): Routine {
    const r = row(value), routineId = id(r.routine_id);
    const targets = this.db.prepare('SELECT position,target_id FROM routine_targets WHERE routine_id=? ORDER BY position LIMIT ?')
      .all(routineId, workspaceLimits.routineTargets + 1).map((value, index) => {
        const target = row(value);
        if (uint(target.position) !== index) fail('INVALID_RECORD');
        return id(target.target_id);
      });
    return parse(routineSchema, { id: routineId, name: r.name, revision: r.revision, targetIds: targets, mode: r.mode,
      delayMs: r.delay_ms, failurePolicy: r.failure_policy, skipDuplicates: bool(r.skip_duplicates) });
  }
  listRoutines(): Routine[] {
    const rows = this.db.prepare('SELECT * FROM routines ORDER BY routine_id LIMIT ?').all(workspaceLimits.routines + 1);
    if (rows.length > workspaceLimits.routines) fail('CAPACITY');
    return rows.map(value => this.routineFromRow(value));
  }
  getRoutine(routineId: string): Routine | null {
    const value = this.db.prepare('SELECT * FROM routines WHERE routine_id=?').get(id(routineId));
    return value === undefined || value === null ? null : this.routineFromRow(value);
  }
  private writeRoutineTargets(routineId: string, targets: readonly string[]): void {
    for (const [index, targetId] of targets.entries()) this.db.prepare('INSERT INTO routine_targets VALUES(?,?,?)').run(routineId, index, targetId);
  }
  private requireRoutineTargets(definition: RoutineDefinition): void {
    for (const targetId of definition.targetIds) {
      const target = this.getActionRecord(targetId);
      if (!target || target.approvedAt === null || !target.enabled) fail('FORBIDDEN');
    }
  }
  createRoutine(routineId: string, raw: RoutineDefinition, expectedWorkspaceRevision: number): Routine {
    const definition = parse(routineDefinitionSchema, raw);
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    if (this.getRoutine(id(routineId))) fail('CONFLICT');
    if (this.listRoutines().length >= workspaceLimits.routines) fail('CAPACITY');
    this.requireRoutineTargets(definition);
    const routine = parse(routineSchema, { ...definition, id: routineId, revision: 0 });
    this.db.prepare('INSERT INTO routines VALUES(?,?,?,?,?,?,1)').run(routine.id, routine.name, routine.revision, routine.mode, routine.delayMs, routine.failurePolicy);
    this.writeRoutineTargets(routine.id, routine.targetIds);
    this.bumpWorkspace();
    return routine;
  }
  updateRoutine(routineId: string, expectedRevision: number, raw: RoutineDefinition): Routine {
    const definition = parse(routineDefinitionSchema, raw);
    this.requireWorkspaceRoom();
    const previous = this.getRoutine(routineId);
    if (!previous) fail('NOT_FOUND');
    if (previous.revision !== uint(expectedRevision) || previous.revision === MAX_SAFE) fail('REVISION_CONFLICT');
    this.requireRoutineTargets(definition);
    const routine = parse(routineSchema, { ...definition, id: previous.id, revision: previous.revision + 1 });
    one(this.db.prepare('UPDATE routines SET name=?,revision=?,mode=?,delay_ms=?,failure_policy=?,skip_duplicates=1 WHERE routine_id=? AND revision=?')
      .run(routine.name, routine.revision, routine.mode, routine.delayMs, routine.failurePolicy, previous.id, previous.revision).changes);
    this.db.prepare('DELETE FROM routine_targets WHERE routine_id=?').run(previous.id);
    this.writeRoutineTargets(routine.id, routine.targetIds);
    this.bumpWorkspace();
    return routine;
  }
  deleteRoutine(routineId: string, expectedRevision: number): void {
    this.requireWorkspaceRoom();
    const previous = this.getRoutine(routineId);
    if (!previous) fail('NOT_FOUND');
    if (previous.revision !== uint(expectedRevision)) fail('REVISION_CONFLICT');
    one(this.db.prepare('DELETE FROM routines WHERE routine_id=? AND revision=?').run(previous.id, previous.revision).changes);
    this.bumpWorkspace();
  }

  updateSettings(raw: RecommendationSettings, expectedWorkspaceRevision: number, now: number, clearHistory = false): RecommendationSettings {
    const settings = parse(recommendationSettingsSchema, raw);
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    uint(now, MAX_TIME);
    if (typeof clearHistory !== 'boolean') fail('INVALID_RECORD');
    one(this.db.prepare('UPDATE workspace_settings SET recommendation_enabled=?,retention_days=? WHERE singleton=1')
      .run(Number(settings.enabled), settings.retentionDays).changes);
    if (clearHistory) {
      this.db.prepare('DELETE FROM launch_history').run();
      // Keep the privacy-minimized daily budget, so clearing usage history
      // or toggling settings cannot circumvent the two-actual-impression cap.
    }
    this.pruneHistory(now);
    this.bumpWorkspace();
    return settings;
  }

  /** Rolling retention operates only on local usage facts and old daily
   * counts; not on users' explicit ignored/permanent preferences. */
  pruneHistory(now: number): void {
    const at = uint(now, MAX_TIME), { retentionDays } = this.getRecommendationSettings();
    this.db.prepare('DELETE FROM launch_history WHERE time_bucket<=?').run(at - retentionDays * DAY);
    // Local offsets differ, keep one extra day so a DST/timezone change cannot
    // discard a same-local-day impression and accidentally exceed its cap.
    this.db.prepare('DELETE FROM recommendation_impressions WHERE local_day<?').run(Math.floor(at / DAY) - retentionDays - 1);
  }
  listLaunchHistory(now: number): LaunchHistoryFact[] {
    this.pruneHistory(now);
    const rows = this.db.prepare('SELECT * FROM launch_history WHERE time_bucket<=? ORDER BY time_bucket DESC,target_id,run_id LIMIT ?')
      .all(uint(now, MAX_TIME), workspaceLimits.history);
    return rows.map(historyFromRow);
  }
  clearLaunchHistory(expectedWorkspaceRevision: number, targetId?: string): number {
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    if (targetId !== undefined && !this.getActionRecord(targetId)) fail('NOT_FOUND');
    const removed = targetId === undefined ? this.db.prepare('DELETE FROM launch_history').run()
      : this.db.prepare('DELETE FROM launch_history WHERE target_id=?').run(id(targetId));
    this.bumpWorkspace();
    return changed(removed.changes);
  }

  /** Main-only actual app-origin outcome. Off by default; no launch/path/raw
   * timestamp or process data is persisted. First receipt per target/run wins. */
  recordLaunchOutcome(raw: LaunchHistoryFact, now: number, expectedActionRevision: number): boolean {
    const fact = parse(launchHistoryFactSchema, raw);
    const at = uint(now, MAX_TIME), revision = uint(expectedActionRevision), settings = this.getRecommendationSettings();
    if (!settings.enabled || fact.timeBucket > at || fact.timeBucket <= at - settings.retentionDays * DAY) return false;
    const action = this.getActionRecord(fact.targetId);
    if (!action || action.approvedAt === null || !action.enabled || action.revision !== revision) return false;
    // The bucket can legitimately begin before approval within the same five
    // minutes, but can never be an event from an earlier identity's history.
    if (fact.timeBucket < Math.floor(action.approvedAt / workspaceLimits.timeBucketMs) * workspaceLimits.timeBucketMs) return false;
    this.pruneHistory(at);
    const inserted = this.db.prepare('INSERT OR IGNORE INTO launch_history VALUES(?,?,?,?,?,?)')
      .run(fact.targetId, fact.runId, fact.source, fact.outcome, fact.timeBucket, fact.utcOffsetMinutes);
    return changed(inserted.changes) === 1 && this.db.prepare('SELECT 1 AS retained FROM launch_history WHERE target_id=? AND run_id=?')
      .get(fact.targetId, fact.runId) != null;
  }

  listRecommendationPreferences(): RecommendationPreference[] {
    const rows = this.db.prepare('SELECT * FROM recommendation_preferences ORDER BY target_id LIMIT ?').all(workspaceLimits.actions + 1);
    if (rows.length > workspaceLimits.actions) fail('CAPACITY');
    return rows.map(value => {
      const r = row(value);
      return parse(recommendationPreferenceSchema, { targetId: r.target_id, ignoredUntil: r.ignored_until, permanentlyExcluded: bool(r.permanently_excluded) });
    });
  }
  setRecommendationPreference(raw: RecommendationPreference, expectedWorkspaceRevision: number): RecommendationPreference {
    const pref = parse(recommendationPreferenceSchema, raw);
    this.requireWorkspaceRevision(expectedWorkspaceRevision);
    if (!this.getActionRecord(pref.targetId)) fail('NOT_FOUND');
    if (!pref.permanentlyExcluded && pref.ignoredUntil === null) this.db.prepare('DELETE FROM recommendation_preferences WHERE target_id=?').run(pref.targetId);
    else this.db.prepare(`INSERT INTO recommendation_preferences VALUES(?,?,?) ON CONFLICT(target_id) DO UPDATE SET
      ignored_until=excluded.ignored_until,permanently_excluded=excluded.permanently_excluded`).run(pref.targetId, pref.ignoredUntil, Number(pref.permanentlyExcluded));
    this.bumpWorkspace();
    return pref;
  }

  shownToday(now: number, utcOffsetMinutes: number): number {
    const day = currentDay(now, utcOffsetMinutes);
    return uint(row(this.db.prepare('SELECT COUNT(*) AS count FROM recommendation_impressions WHERE local_day=?').get(day)).count, workspaceLimits.impressionsPerDay);
  }
  /** Only call from the trusted presentation path after an actual impression,
   * not while computing recommendations. No target/path is stored. */
  recordRecommendationImpression(impressionId: string, now: number, utcOffsetMinutes: number): boolean {
    const key = id(impressionId), day = currentDay(now, utcOffsetMinutes);
    if (!this.getRecommendationSettings().enabled) return false;
    this.pruneHistory(now);
    if (this.shownToday(now, utcOffsetMinutes) >= workspaceLimits.impressionsPerDay) return false;
    return changed(this.db.prepare('INSERT OR IGNORE INTO recommendation_impressions VALUES(?,?)').run(day, key).changes) === 1;
  }

  private recommend(actions: readonly QuickActionView[], settings: RecommendationSettings, history: readonly LaunchHistoryFact[],
    preferences: readonly RecommendationPreference[], shownToday: number, now: number, utcOffsetMinutes: number): LocalRecommendation[] {
    return recommendTargets({ enabled: settings.enabled, now: uint(now, MAX_TIME), utcOffsetMinutes: offset(utcOffsetMinutes),
      retentionDays: settings.retentionDays, targets: actions.map(action => ({ targetId: action.id, label: action.label,
        enabled: action.enabled, approved: action.approved, recommendable: action.recommendable })), history, preferences, shownToday })
      .map(recommendation => ({ ...recommendation, evidence: { ...recommendation.evidence, contextTargetIds: [...recommendation.evidence.contextTargetIds] },
        routineSuggestion: [...recommendation.routineSuggestion] }));
  }
  listRecommendations(now: number, utcOffsetMinutes: number): LocalRecommendation[] {
    return this.recommend(this.listQuickActions(), this.getRecommendationSettings(), this.listLaunchHistory(now),
      this.listRecommendationPreferences(), this.shownToday(now, utcOffsetMinutes), now, utcOffsetMinutes);
  }
  getPage(now: number, utcOffsetMinutes: number): WorkspacePage {
    const actions = this.listQuickActions(), settings = this.getRecommendationSettings(), history = this.listLaunchHistory(now);
    const preferences = this.listRecommendationPreferences(), shownToday = this.shownToday(now, utcOffsetMinutes);
    const recommendations = this.recommend(actions, settings, history, preferences, shownToday, now, utcOffsetMinutes);
    return parse(workspacePageSchema, { revision: this.getRevision(), actions, routines: this.listRoutines(), settings, history,
      preferences, shownToday, recommendations });
  }
}
