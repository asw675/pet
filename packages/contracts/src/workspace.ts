import { z } from 'zod';

/** Workspace capabilities are closed data, never shell instructions. Authority
 * target records are Main/app-service-only; UI and AI projections below do not
 * contain a locator, file identity, fingerprint, OS handle or executable args. */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const workspaceLimits = Object.freeze({
  actions: 100, routines: 100, routineTargets: 12, history: 1000, impressionsPerDay: 2,
  maxDelayMs: 5000, timeBucketMs: 5 * 60 * 1000, label: 80,
  executableBytes: 256 * 1024 * 1024, pathUnits: 259, urlUnits: 2048,
});
const safeDisplay = (max: number) => z.string().min(1).max(max)
  .refine(text => text.trim().length > 0 && !/[/\\\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(text), 'Only a safe display name, not a locator');
const label = safeDisplay(workspaceLimits.label);
const previewText = safeDisplay(260);
export const quickLaunchKindSchema = z.enum(['WIN32_EXE', 'FOLDER', 'HTTPS']);
export type QuickLaunchKind = z.infer<typeof quickLaunchKindSchema>;

// A second, structural storage boundary. The actual native handle, drive,
// canonical path, reparse and PE/hash checks remain exclusively Main's job.
const reserved = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|(?:COM|LPT)[0-9¹²³])$/iu;
const win32Locator = z.string().max(workspaceLimits.pathUnits).refine(value => {
  const parts = /^([A-Z]):\\(.*)$/su.exec(value);
  if (!parts || parts[2] === undefined) return false;
  if (parts[2] === '') return true;
  const segments = parts[2].split('\\');
  return segments.length <= 64 && segments.every(part => part.length > 0 && part.length <= 255 && part.trim() === part
    && part !== '.' && part !== '..' && !part.endsWith('.') && !/[<>:"/\\|?*~\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(part)
    && !reserved.test(part.split('.')[0] ?? ''));
}, 'Expected a canonical local Win32 path spelling');
const deniedExeNames = new Set(['cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec',
  'runas', 'schtasks', 'wmic', 'wsl', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'python', 'pythonw', 'py', 'node', 'nodejs',
  'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'java', 'javaw', 'dotnet', 'csi', 'csc', 'msbuild', 'installutil', 'conhost', 'wt',
  'windowsterminal', 'reg', 'regedit', 'certutil', 'bitsadmin', 'curl', 'ftp', 'sc', 'services', 'taskkill', 'explorer', 'mmc', 'control', 'diskpart']);
const exeLocator = win32Locator.refine(value => {
  const file = value.split('\\').at(-1) ?? '';
  if (!/\.exe$/iu.test(file)) return false;
  const stem = file.slice(0, -4).toLowerCase();
  return stem.length > 0 && !deniedExeNames.has(stem) && !/^(?:python|ruby|perl|php|lua|node|java|pwsh)(?:\d+(?:\.\d+)*)?w?$/u.test(stem);
}, 'No shell, interpreter, script or general execution utility target');
const httpsLocator = z.string().max(workspaceLimits.urlUnits).refine(value => {
  if (/[\s\\\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value) || /%(?![\da-f]{2})/iu.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(value)) return false;
  const parsed = /^https:\/\/([a-z0-9.-]+)(?::([1-9]\d{0,4}))?\//u.exec(value);
  if (!parsed || parsed[1] === undefined || parsed[1].length > 253 || (parsed[2] !== undefined && (Number(parsed[2]) > 65535 || Number(parsed[2]) === 443))) return false;
  const host = parsed[1].split('.');
  if (host.length < 2 || host.some(part => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(part))) return false;
  if (/^(?:\d+|0x[\da-f]+)$/u.test(host.at(-1) ?? '')
    && (host.length !== 4 || host.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255))) return false;
  const fragmentAt = value.indexOf('#'), queryAt = value.indexOf('?');
  try {
    if (fragmentAt >= 0 && /[=&]/u.test(decodeURIComponent(value.slice(fragmentAt + 1)))) return false;
    if (queryAt >= 0 && (fragmentAt < 0 || queryAt < fragmentAt)) {
      const query = value.slice(queryAt + 1, fragmentAt < 0 ? value.length : fragmentAt);
      for (const pair of query.split('&')) {
        const key = decodeURIComponent((pair.split('=')[0] ?? '').replace(/\+/g, ' '));
        if (/(?:token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|session|signature|code)/iu.test(key)) return false;
      }
    }
  } catch { return false; }
  return true;
}, 'Expected a canonical HTTPS target without userinfo or credential-shaped query');

export const localFileIdentitySchema = z.strictObject({
  volumeSerial: z.string().regex(/^[0-9a-f]{16}$/u).refine(value => !/^0+$/u.test(value)),
  fileId: z.string().regex(/^[0-9a-f]{32}$/u).refine(value => !/^0+$/u.test(value)),
});
const exeFingerprint = z.strictObject({ kind: z.literal('EXECUTABLE'), identity: localFileIdentitySchema,
  sizeBytes: uint.min(1).max(workspaceLimits.executableBytes), modifiedAtMs: uint, sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const directoryFingerprint = z.strictObject({ kind: z.literal('DIRECTORY'), identity: localFileIdentitySchema });
const httpsFingerprint = z.strictObject({ kind: z.literal('HTTPS'), canonicalUrl: httpsLocator });
export const quickLaunchFingerprintSchema = z.discriminatedUnion('kind', [exeFingerprint, directoryFingerprint, httpsFingerprint]);
export type QuickLaunchFingerprint = z.infer<typeof quickLaunchFingerprintSchema>;
const executableFields = { kind: z.literal('WIN32_EXE'), locator: exeLocator, fingerprint: exeFingerprint };
const folderFields = { kind: z.literal('FOLDER'), locator: win32Locator, fingerprint: directoryFingerprint };
const httpsFields = { kind: z.literal('HTTPS'), locator: httpsLocator, fingerprint: httpsFingerprint };
function coherentTarget(target: { kind: QuickLaunchKind; locator: string; fingerprint: QuickLaunchFingerprint }): boolean {
  return target.kind !== 'HTTPS' || (target.fingerprint.kind === 'HTTPS' && target.fingerprint.canonicalUrl === target.locator);
}

/** Authority-only descriptor received after a native Main approval flow. */
export const approvedQuickTargetSchema = z.discriminatedUnion('kind', [z.strictObject(executableFields), z.strictObject(folderFields), z.strictObject(httpsFields)])
  .refine(coherentTarget, 'HTTPS fingerprint must be the exact approved canonical location');
export type ApprovedQuickTarget = z.infer<typeof approvedQuickTargetSchema>;

const identityFields = { id, label, revision: uint };
const approvedFields = { ...identityFields, approvedAt: uint, enabled: z.boolean() };
/** Exact shape for the Main-only saved-target execution recheck. No history,
 * path projection, recommendation preference, or untrusted renderer fields. */
export const launchAuthorityActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...executableFields, ...approvedFields }), z.strictObject({ ...folderFields, ...approvedFields }),
  z.strictObject({ ...httpsFields, ...approvedFields }),
]).refine(coherentTarget, 'HTTPS fingerprint differs from approved target');
export type LaunchAuthorityAction = z.infer<typeof launchAuthorityActionSchema>;

const approvedRecord = z.discriminatedUnion('kind', [
  z.strictObject({ ...executableFields, ...approvedFields, recommendable: z.boolean() }),
  z.strictObject({ ...folderFields, ...approvedFields, recommendable: z.boolean() }),
  z.strictObject({ ...httpsFields, ...approvedFields, recommendable: z.boolean() }),
]).refine(coherentTarget, 'HTTPS fingerprint differs from approved target');
export const quickActionRecordSchema = z.union([
  approvedRecord,
  // Revocation retains only a manageable ID/name/kind, never a stale locator
  // or reusable approval. Reapproval must come from a fresh native selection.
  z.strictObject({ ...identityFields, kind: quickLaunchKindSchema, locator: z.null(), fingerprint: z.null(),
    approvedAt: z.null(), enabled: z.literal(false), recommendable: z.literal(false) }),
]);
export type QuickActionRecord = z.infer<typeof quickActionRecordSchema>;

export const quickActionViewSchema = z.strictObject({ ...identityFields, kind: quickLaunchKindSchema,
  approved: z.boolean(), enabled: z.boolean(), recommendable: z.boolean(), preview: previewText.nullable(),
}).refine(value => value.approved ? value.preview !== null : !value.enabled && !value.recommendable && value.preview === null,
  'Revoked action cannot expose a preview or be enabled/recommendable');
export type QuickActionView = z.infer<typeof quickActionViewSchema>;
export const aiQuickActionSchema = z.strictObject({ targetId: id, label });
export type AiQuickAction = z.infer<typeof aiQuickActionSchema>;

const uniqueTargetIds = z.array(id).max(workspaceLimits.actions).refine(values => new Set(values).size === values.length, 'Duplicate target ID');
const routineFields = { name: label, targetIds: uniqueTargetIds.min(1).max(workspaceLimits.routineTargets),
  mode: z.enum(['SEQUENTIAL', 'PARALLEL']), delayMs: uint.max(workspaceLimits.maxDelayMs),
  failurePolicy: z.enum(['CONTINUE', 'STOP']), skipDuplicates: z.literal(true) };
const routineCoherent = (value: { mode: 'SEQUENTIAL' | 'PARALLEL'; delayMs: number; failurePolicy: 'CONTINUE' | 'STOP' }) =>
  value.mode === 'SEQUENTIAL' || (value.delayMs === 0 && value.failurePolicy === 'CONTINUE');
export const routineDefinitionSchema = z.strictObject(routineFields).refine(routineCoherent, 'Parallel runs cannot delay or stop already-issued targets');
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export const routineSchema = z.strictObject({ id, revision: uint, ...routineFields }).refine(routineCoherent, 'Invalid parallel mode policy');
export type Routine = z.infer<typeof routineSchema>;

export const launchSourceSchema = z.enum(['MANUAL', 'ROUTINE', 'SUGGESTION']);
export const launchOutcomeSchema = z.enum(['ACCEPTED', 'FAILED', 'SKIPPED', 'UNKNOWN']);
export const launchHistoryFactSchema = z.strictObject({ targetId: id, runId: id, source: launchSourceSchema, outcome: launchOutcomeSchema,
  timeBucket: uint.refine(value => value % workspaceLimits.timeBucketMs === 0, 'Only five-minute time buckets'),
  utcOffsetMinutes: z.number().int().min(-840).max(840),
});
export type LaunchHistoryFact = z.infer<typeof launchHistoryFactSchema>;
export const recommendationSettingsSchema = z.strictObject({ enabled: z.boolean(), retentionDays: z.union([z.literal(7), z.literal(30)]) });
export type RecommendationSettings = z.infer<typeof recommendationSettingsSchema>;
export const recommendationPreferenceSchema = z.strictObject({ targetId: id, ignoredUntil: uint.nullable(), permanentlyExcluded: z.boolean() })
  .refine(pref => !pref.permanentlyExcluded || pref.ignoredUntil === null, 'Permanent exclusion supersedes a finite cooldown');
export type RecommendationPreference = z.infer<typeof recommendationPreferenceSchema>;
export const localRecommendationSchema = z.strictObject({ targetId: id, label, score: z.number().min(0).max(1),
  evidence: z.strictObject({ count7: uint.max(workspaceLimits.history), count30: uint.max(workspaceLimits.history),
    sameLocalPeriod: uint.max(workspaceLimits.history), weekdayKind: z.enum(['WEEKDAY', 'WEEKEND']),
    period: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT']), sharedUses: uint.max(workspaceLimits.history), contextTargetIds: uniqueTargetIds }),
  routineSuggestion: uniqueTargetIds.max(workspaceLimits.routineTargets),
}).refine(value => value.evidence.count7 <= value.evidence.count30 && value.evidence.sameLocalPeriod <= value.evidence.count30
  && value.evidence.count30 >= 3 && (value.routineSuggestion.length === 0 || value.routineSuggestion[0] === value.targetId), 'Inconsistent recommendation evidence');
export type LocalRecommendation = z.infer<typeof localRecommendationSchema>;

/** Workspace revision is independent of the game's snapshot revision. */
export const workspacePageSchema = z.strictObject({ revision: uint, actions: z.array(quickActionViewSchema).max(workspaceLimits.actions),
  routines: z.array(routineSchema).max(workspaceLimits.routines), settings: recommendationSettingsSchema,
  history: z.array(launchHistoryFactSchema).max(workspaceLimits.history), preferences: z.array(recommendationPreferenceSchema).max(workspaceLimits.actions),
  recommendations: z.array(localRecommendationSchema).max(workspaceLimits.impressionsPerDay), shownToday: uint.max(workspaceLimits.impressionsPerDay),
}).superRefine((page, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const actions = new Map<string, QuickActionView>();
  for (const [index, action] of page.actions.entries()) {
    if (actions.has(action.id)) issue(['actions', index], 'Duplicate action ID');
    actions.set(action.id, action);
  }
  const routineIds = new Set<string>(), historyKeys = new Set<string>(), preferenceIds = new Set<string>(), recommendationIds = new Set<string>();
  for (const [index, routine] of page.routines.entries()) {
    if (routineIds.has(routine.id) || routine.targetIds.some(targetId => !actions.has(targetId))) issue(['routines', index], 'Duplicate routine or absent action reference');
    routineIds.add(routine.id);
  }
  for (const [index, fact] of page.history.entries()) {
    const key = JSON.stringify([fact.targetId, fact.runId]);
    if (historyKeys.has(key) || !actions.has(fact.targetId)) issue(['history', index], 'Duplicate launch fact or absent action');
    historyKeys.add(key);
  }
  for (const [index, pref] of page.preferences.entries()) {
    if (preferenceIds.has(pref.targetId) || !actions.has(pref.targetId)) issue(['preferences', index], 'Duplicate preference or absent action');
    preferenceIds.add(pref.targetId);
  }
  const eligible = (targetId: string) => { const target = actions.get(targetId); return target?.approved === true && target.enabled && target.recommendable; };
  for (const [index, suggestion] of page.recommendations.entries()) {
    if (!eligible(suggestion.targetId) || actions.get(suggestion.targetId)?.label !== suggestion.label || recommendationIds.has(suggestion.targetId)
      || suggestion.routineSuggestion.some(targetId => !eligible(targetId)) || suggestion.evidence.contextTargetIds.some(targetId => !eligible(targetId))
      || page.preferences.some(pref => pref.targetId === suggestion.targetId && pref.permanentlyExcluded)) issue(['recommendations', index], 'Invalid recommendation action reference');
    recommendationIds.add(suggestion.targetId);
  }
  if ((!page.settings.enabled && page.recommendations.length > 0) || page.recommendations.length + page.shownToday > workspaceLimits.impressionsPerDay) {
    issue(['recommendations'], 'Recommendations are opt-in and capped per local day');
  }
});
export type WorkspacePage = z.infer<typeof workspacePageSchema>;

/** Renderer-only intents. No renderer can submit a locator/fingerprint,
 * approvedAt, arbitrary launch args, receipt/source/outcome or confirmation
 * boolean. Main binds a native approval token to the actual selection. */
const approvalToken = z.string().regex(/^quick-[1-9]\d{0,15}-[a-f0-9]{64}$/u);
const targetRevision = { actionId: id, expectedRevision: uint };
export const workspaceNativeSelectIntentSchema = z.strictObject({ kind: quickLaunchKindSchema, expectedRevision: uint });
export const workspaceFinalizeAddIntentSchema = z.strictObject({ approvalToken, label, recommendable: z.boolean(), expectedRevision: uint });
export const workspaceReapproveIntentSchema = z.strictObject({ actionId: id, expectedActionRevision: uint, expectedWorkspaceRevision: uint, approvalToken });
export const workspaceActionMetadataIntentSchema = z.strictObject({ ...targetRevision, label, enabled: z.boolean(), recommendable: z.boolean() });
export const workspaceRevokeActionIntentSchema = z.strictObject({ ...targetRevision, clearHistory: z.boolean() });
export const workspaceDeleteActionIntentSchema = z.strictObject(targetRevision);
export const workspaceRunActionIntentSchema = z.strictObject(targetRevision);
export const workspaceCreateRoutineIntentSchema = z.strictObject({ expectedRevision: uint, definition: routineDefinitionSchema });
export const workspaceUpdateRoutineIntentSchema = z.strictObject({ routineId: id, expectedRevision: uint, definition: routineDefinitionSchema });
export const workspaceDeleteRoutineIntentSchema = z.strictObject({ routineId: id, expectedRevision: uint });
export const workspaceRunRoutineIntentSchema = z.strictObject({ routineId: id, expectedRevision: uint });
export const workspaceRecommendationSettingsIntentSchema = z.strictObject({ expectedRevision: uint, settings: recommendationSettingsSchema, clearHistory: z.boolean() });
export const workspaceRecommendationPreferenceIntentSchema = z.strictObject({ expectedRevision: uint, preference: recommendationPreferenceSchema });
export const workspaceClearHistoryIntentSchema = z.strictObject({ expectedRevision: uint, targetId: id.optional() });

/** Internal trusted Main→authority request only, never part of renderer
 * command dispatch. IDs/approval timestamp chosen by the authority. */
export const approvedActionInputSchema = z.strictObject({ id, label, target: approvedQuickTargetSchema, approvedAt: uint,
  enabled: z.boolean(), recommendable: z.boolean() });
export type ApprovedActionInput = z.infer<typeof approvedActionInputSchema>;
export const quickActionMetadataSchema = z.strictObject({ label, enabled: z.boolean(), recommendable: z.boolean() });
export type QuickActionMetadata = z.infer<typeof quickActionMetadataSchema>;
