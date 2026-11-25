import { z } from 'zod';
import { idSchema } from '@pet-desktop/contracts';

/** Fixed host-only keyboard actions. No arbitrary accelerator, process,
 * login command, registry key, filename or executable arguments cross IPC. */
export const hostShortcuts = Object.freeze([
  Object.freeze({ id: 'OPEN_CONTROL_CENTER', accelerator: 'CommandOrControl+Shift+P' }),
  Object.freeze({ id: 'TOGGLE_PET_VISIBILITY', accelerator: 'CommandOrControl+Shift+H' }),
  Object.freeze({ id: 'RESCUE_INTERACTION', accelerator: 'CommandOrControl+Shift+I' }),
] as const);
export type HostShortcutId = typeof hostShortcuts[number]['id'];
export const hostShortcutStatusSchema = z.enum(['REGISTERED', 'CONFLICT', 'DISABLED', 'UNSUPPORTED', 'UNAVAILABLE', 'ERROR']);
export type HostShortcutStatus = z.infer<typeof hostShortcutStatusSchema>;
const shortcut = <I extends HostShortcutId, A extends typeof hostShortcuts[number]['accelerator']>(id: I, accelerator: A) =>
  z.strictObject({ id: z.literal(id), accelerator: z.literal(accelerator), status: hostShortcutStatusSchema });
const shortcutAvailabilitySchema = z.enum(['READY', 'NON_WINDOWS', 'NOT_READY', 'STOPPED']);
export const hostShortcutSettingsSchema = z.strictObject({
  availability: shortcutAvailabilitySchema,
  /** This is the requested preference, not a promise that the OS granted
   * every key. Each key has a separate measured registration status. */
  enabled: z.boolean(),
  preferenceScope: z.enum(['PERSISTED', 'SESSION']),
  entries: z.tuple([
    shortcut(hostShortcuts[0].id, hostShortcuts[0].accelerator),
    shortcut(hostShortcuts[1].id, hostShortcuts[1].accelerator),
    shortcut(hostShortcuts[2].id, hostShortcuts[2].accelerator),
  ]),
}).refine(value => value.entries.every(entry => {
  if (value.availability === 'NON_WINDOWS') return entry.status === 'UNSUPPORTED';
  if (value.availability !== 'READY') return entry.status === 'UNAVAILABLE';
  return value.enabled ? entry.status === 'REGISTERED' || entry.status === 'CONFLICT' || entry.status === 'ERROR'
    : entry.status === 'DISABLED' || entry.status === 'ERROR';
}), 'Shortcut status must agree with availability and requested preference');
export type HostShortcutSettings = z.infer<typeof hostShortcutSettingsSchema>;

/** Electron Windows provides two different booleans. openAtLogin identifies
 * the configured executable+arguments. executableWillLaunchAtLogin reports
 * an enabled launch of that executable with any arguments. Never send the
 * underlying OS registry entries, paths or arguments to renderer. */
export const hostLoginSettingsSchema = z.discriminatedUnion('availability', [
  z.strictObject({ availability: z.literal('READY'), openAtLogin: z.boolean(), executableWillLaunchAtLogin: z.boolean() }),
  z.strictObject({ availability: z.enum(['NON_WINDOWS', 'DEVELOPMENT', 'NOT_READY', 'STOPPED', 'OS_ERROR']),
    openAtLogin: z.null(), executableWillLaunchAtLogin: z.null() }),
]);
export type HostLoginSettings = z.infer<typeof hostLoginSettingsSchema>;
export const hostSettingsSchema = z.strictObject({ shortcuts: hostShortcutSettingsSchema, loginStart: hostLoginSettingsSchema });
export type HostSettings = z.infer<typeof hostSettingsSchema>;
export const hostSettingsErrorCodeSchema = z.enum(['INVALID_REQUEST', 'FORBIDDEN', 'SERVICE_UNAVAILABLE', 'UNSUPPORTED', 'OS_REJECTED']);
export type HostSettingsErrorCode = z.infer<typeof hostSettingsErrorCodeSchema>;
export const hostSettingsResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), settings: hostSettingsSchema }),
  z.strictObject({ ok: z.literal(false), code: hostSettingsErrorCodeSchema, settings: hostSettingsSchema.nullable() }),
]);
export type HostSettingsResult = z.infer<typeof hostSettingsResultSchema>;
export const hostSettingsToggleSchema = z.boolean();

export const hostScalePercents = Object.freeze([50, 75, 100, 125, 150, 200] as const);
const hostScaleSchema = z.union([z.literal(50), z.literal(75), z.literal(100), z.literal(125), z.literal(150), z.literal(200)]);
export type HostScale = z.infer<typeof hostScaleSchema>;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
export const hostPreferencesViewSchema = z.strictObject({
  values: z.strictObject({ hotkeysEnabled: z.boolean(), scalePercent: hostScaleSchema, reducedMotion: z.boolean() }),
  revision, updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type HostPreferencesView = z.infer<typeof hostPreferencesViewSchema>;
export const hostPreferencesViewResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), preferences: hostPreferencesViewSchema }),
  z.strictObject({ ok: z.literal(false), code: errorCode }),
]);
export const backupViewResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), schemaVersion: z.number().int().min(1).max(100_000) }),
  z.strictObject({ ok: z.literal(false), code: errorCode }),
]);
const restoreFailureSchema = z.strictObject({ ok: z.literal(false), code: errorCode });
export const restoreBackupResultSchema = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true) }), restoreFailureSchema]);
export const restoreBackupStatusSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), status: z.enum(['NONE', 'PENDING', 'RESTORED', 'FAILED']) }),
  restoreFailureSchema,
]);
export type RestoreBackupResult = z.infer<typeof restoreBackupResultSchema>;
export type RestoreBackupStatus = z.infer<typeof restoreBackupStatusSchema>;
export const managedBackupDirectory = '.pet-snapshots';
export const periodicBackupStatusSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), status: z.enum(['WAITING', 'AVAILABLE', 'FAILED']), lastCompletedAt: z.iso.datetime().nullable() }),
  restoreFailureSchema,
]);
export type PeriodicBackupStatus = z.infer<typeof periodicBackupStatusSchema>;
const preferenceEditSchema = z.strictObject({ scalePercent: hostScaleSchema, reducedMotion: z.boolean() });
export type HostPreferenceEdit = z.infer<typeof preferenceEditSchema>;
export const hostPreferenceSaveSchema = preferenceEditSchema.extend({ expectedRevision: revision });
export type HostPreferenceSave = z.infer<typeof hostPreferenceSaveSchema>;
export type HostPreferencesViewResult = z.infer<typeof hostPreferencesViewResultSchema>;
export type BackupViewResult = z.infer<typeof backupViewResultSchema>;
export const hostRenderPreferencesSchema = z.strictObject({ reducedMotion: z.boolean() });
export type HostRenderPreferences = z.infer<typeof hostRenderPreferencesSchema>;

const coordinate = z.number().int().min(-1_000_000).max(1_000_000);
const extent = z.number().int().min(1).max(32_768);
const anchorFields = {
  displayId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  offsetX: coordinate, offsetY: coordinate, x: coordinate, y: coordinate, width: extent, height: extent,
  displayScale1000: z.number().int().min(250).max(8000), observedAt: revision,
};
export const hostWindowAnchorSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('control-center'), petId: z.null(), ...anchorFields }),
  z.strictObject({ role: z.literal('pet'), petId: idSchema, ...anchorFields }),
]);
export type HostWindowAnchor = z.infer<typeof hostWindowAnchorSchema>;

export const hostRendererRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('settings') }),
  z.strictObject({ kind: z.literal('shortcuts'), enabled: hostSettingsToggleSchema }),
  z.strictObject({ kind: z.literal('login'), enabled: hostSettingsToggleSchema }),
  z.strictObject({ kind: z.literal('preferences') }),
  z.strictObject({ kind: z.literal('save'), edit: hostPreferenceSaveSchema }),
  z.strictObject({ kind: z.literal('backup') }),
  z.strictObject({ kind: z.literal('restore-backup') }),
  z.strictObject({ kind: z.literal('restore-status') }),
  z.strictObject({ kind: z.literal('periodic-backup-status') }),
]);

export const hostAuthorityRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('window-anchors') }),
  z.strictObject({ kind: z.literal('save-window-anchor'), anchor: hostWindowAnchorSchema }),
  z.strictObject({ kind: z.literal('preferences') }),
  z.strictObject({ kind: z.literal('save'), edit: hostPreferenceSaveSchema }),
  z.strictObject({ kind: z.literal('shortcuts'), enabled: hostSettingsToggleSchema, expectedRevision: revision }),
  z.strictObject({ kind: z.literal('backup'), destination: z.string().min(1).max(4096).refine(value => !value.includes('\0')) }),
  z.strictObject({ kind: z.literal('restore-backup'), source: z.string().min(1).max(4096).refine(value => !value.includes('\0')) }),
  z.strictObject({ kind: z.literal('restore-status') }),
  z.strictObject({ kind: z.literal('periodic-backup-status') }),
]);
export type HostAuthorityRequest = z.infer<typeof hostAuthorityRequestSchema>;
export const hostAuthorityResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('window-anchors'), result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), anchors: z.array(hostWindowAnchorSchema).max(101) }), restoreFailureSchema,
  ]) }),
  z.strictObject({ kind: z.literal('save-window-anchor'), result: restoreBackupResultSchema }),
  z.strictObject({ kind: z.literal('preferences'), result: hostPreferencesViewResultSchema }),
  z.strictObject({ kind: z.literal('backup'), result: backupViewResultSchema }),
  z.strictObject({ kind: z.literal('restore-backup'), result: restoreBackupResultSchema }),
  z.strictObject({ kind: z.literal('restore-status'), result: restoreBackupStatusSchema }),
  z.strictObject({ kind: z.literal('periodic-backup-status'), result: periodicBackupStatusSchema }),
]);
export type HostAuthorityResult = z.infer<typeof hostAuthorityResultSchema>;

export function hostAuthorityResultKind(request: HostAuthorityRequest): HostAuthorityResult['kind'] {
  return request.kind === 'save' || request.kind === 'shortcuts' ? 'preferences' : request.kind;
}

export function hostAuthorityFailure(request: HostAuthorityRequest): HostAuthorityResult {
  return { kind: hostAuthorityResultKind(request), result: { ok: false, code: 'SERVICE_UNAVAILABLE' } };
}
