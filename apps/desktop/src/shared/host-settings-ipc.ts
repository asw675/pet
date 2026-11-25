import { z } from 'zod';
import { idSchema } from '@pet-desktop/contracts';
import { defaultHostShortcutBindings, hostShortcutAcceleratorSchema, hostShortcutBindingsSchema, hostShortcutIds } from '@pet-desktop/contracts/host-shortcuts';
import type { HostShortcutId } from '@pet-desktop/contracts/host-shortcuts';

/** Fixed host-only actions and their initial combinations. */
export const hostShortcuts = Object.freeze([
  Object.freeze({ id: hostShortcutIds[0], accelerator: defaultHostShortcutBindings.OPEN_CONTROL_CENTER }),
  Object.freeze({ id: hostShortcutIds[1], accelerator: defaultHostShortcutBindings.TOGGLE_PET_VISIBILITY }),
  Object.freeze({ id: hostShortcutIds[2], accelerator: defaultHostShortcutBindings.RESCUE_INTERACTION }),
] as const);
export type { HostShortcutId };
export const hostShortcutStatusSchema = z.enum(['REGISTERED', 'CONFLICT', 'DISABLED', 'UNSUPPORTED', 'UNAVAILABLE', 'ERROR']);
export type HostShortcutStatus = z.infer<typeof hostShortcutStatusSchema>;
const shortcut = <I extends HostShortcutId>(id: I) =>
  z.strictObject({ id: z.literal(id), accelerator: hostShortcutAcceleratorSchema, status: hostShortcutStatusSchema });
const shortcutAvailabilitySchema = z.enum(['READY', 'NON_WINDOWS', 'NOT_READY', 'STOPPED']);
export const hostShortcutSettingsSchema = z.strictObject({
  availability: shortcutAvailabilitySchema,
  /** This is the requested preference, not a promise that the OS granted
   * every key. Each key has a separate measured registration status. */
  enabled: z.boolean(),
  preferenceScope: z.enum(['PERSISTED', 'SESSION']),
  entries: z.tuple([
    shortcut(hostShortcuts[0].id),
    shortcut(hostShortcuts[1].id),
    shortcut(hostShortcuts[2].id),
  ]),
}).refine(value => value.entries.every(entry => {
  if (value.availability === 'NON_WINDOWS') return entry.status === 'UNSUPPORTED';
  if (value.availability !== 'READY') return entry.status === 'UNAVAILABLE';
  return value.enabled ? entry.status === 'REGISTERED' || entry.status === 'CONFLICT' || entry.status === 'ERROR'
    : entry.status === 'DISABLED' || entry.status === 'ERROR';
}), 'Shortcut status must agree with availability and requested preference')
  .refine(value => new Set(value.entries.map(entry => entry.accelerator)).size === hostShortcutIds.length, 'Shortcut combinations must be distinct');
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
export const petScaleDirectionSchema = z.enum(['increase', 'decrease']);
export type PetScaleDirection = z.infer<typeof petScaleDirectionSchema>;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
export const hostShortcutBindingsViewSchema = z.strictObject({ revision, bindings: hostShortcutBindingsSchema });
export type HostShortcutBindingsView = z.infer<typeof hostShortcutBindingsViewSchema>;
export const hostShortcutBindingsEditSchema = z.strictObject({ expectedRevision: revision, bindings: hostShortcutBindingsSchema });
export type HostShortcutBindingsEdit = z.infer<typeof hostShortcutBindingsEditSchema>;
export const hostShortcutBindingsResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), preferences: hostShortcutBindingsViewSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['CONFLICT', 'OS_ERROR']), id: z.enum(hostShortcutIds) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'UNSUPPORTED', 'BUSY', 'REVISION_CONFLICT']) }),
]);
export type HostShortcutBindingsResult = z.infer<typeof hostShortcutBindingsResultSchema>;
const shortcutBindingsRead = z.strictObject({ kind: z.literal('shortcut-bindings') });
const shortcutBindingsSave = z.strictObject({ kind: z.literal('save-shortcut-bindings'), edit: hostShortcutBindingsEditSchema });
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
export const hostRenderPreferencesSchema = z.strictObject({ reducedMotion: z.boolean(), scalePercent: hostScaleSchema });
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
  shortcutBindingsRead,
  shortcutBindingsSave,
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
  shortcutBindingsRead,
  shortcutBindingsSave,
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
  z.strictObject({ kind: z.literal('shortcut-bindings'), result: hostShortcutBindingsResultSchema }),
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
  if (request.kind === 'save-shortcut-bindings') return 'shortcut-bindings';
  return request.kind === 'save' || request.kind === 'shortcuts' ? 'preferences' : request.kind;
}

export function hostAuthorityFailure(request: HostAuthorityRequest): HostAuthorityResult {
  return { kind: hostAuthorityResultKind(request), result: { ok: false, code: 'SERVICE_UNAVAILABLE' } };
}
