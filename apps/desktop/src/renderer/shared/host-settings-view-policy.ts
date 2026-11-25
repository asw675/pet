import { hostPreferencesViewSchema } from '../../shared/host-settings-ipc';
import type { HostPreferenceEdit, HostPreferenceSave, HostPreferencesView } from '../../shared/host-settings-ipc';

export { backupViewResultSchema, hostPreferencesViewResultSchema, hostPreferencesViewSchema, hostScalePercents } from '../../shared/host-settings-ipc';
export type { HostPreferenceEdit, HostPreferenceSave, HostPreferencesView, HostScale } from '../../shared/host-settings-ipc';

const preferenceEditSchema = hostPreferencesViewSchema.shape.values.pick({ scalePercent: true, reducedMotion: true });

export function preferenceDraft(preferences: HostPreferencesView): HostPreferenceEdit {
  return { scalePercent: preferences.values.scalePercent, reducedMotion: preferences.values.reducedMotion };
}
/** Save exactly the two editable fields with the last confirmed revision.
 * No optimistic update and never send hotkeysEnabled on this separate path. */
export function preferenceSavePayload(current: HostPreferencesView | null, input: unknown): HostPreferenceSave | null {
  const stored = hostPreferencesViewSchema.safeParse(current);
  const draft = preferenceEditSchema.safeParse(input);
  if (!stored.success || !draft.success) return null;
  if (stored.data.values.scalePercent === draft.data.scalePercent && stored.data.values.reducedMotion === draft.data.reducedMotion) return null;
  return { ...draft.data, expectedRevision: stored.data.revision };
}
/** A success to a save has to be an actual post-CAS projection, not an
 * unchanged/uncorrelated revision or a result with unrelated preference data. */
export function preferenceSaveMatches(input: HostPreferenceSave, response: HostPreferencesView): boolean {
  const result = hostPreferencesViewSchema.safeParse(response);
  return result.success && result.data.revision === input.expectedRevision + 1
    && result.data.values.scalePercent === input.scalePercent && result.data.values.reducedMotion === input.reducedMotion;
}

export interface HostSettingsViewBridge {
  getHostSettings(): Promise<unknown>;
  setHostShortcutEnabled(enabled: boolean): Promise<unknown>;
  setLoginStart(enabled: boolean): Promise<unknown>;
}
export interface HostPreferencesViewBridge {
  getHostPreferences(): Promise<unknown>;
  saveHostPreferences(edit: HostPreferenceSave): Promise<unknown>;
  exportBackup(): Promise<unknown>;
}
const controlCenter = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).role === 'control-center';
function call(port: Record<string, unknown>, name: string, args: unknown[]): Promise<unknown> {
  try {
    const fn = port[name];
    if (typeof fn !== 'function') return Promise.reject(new Error('Host capability unavailable'));
    return Promise.resolve(Reflect.apply(fn, port, args));
  } catch { return Promise.reject(new Error('Host capability unavailable')); }
}
/** These guards allow the settings route to truthfully degrade if opened
 * outside Electron or during an older preload; not an authorization layer. */
export function resolveHostSettingsViewBridge(raw: unknown): HostSettingsViewBridge | null {
  if (!controlCenter(raw) || ['getHostSettings', 'setHostShortcutEnabled', 'setLoginStart'].some(name => typeof raw[name] !== 'function')) return null;
  return {
    getHostSettings: () => call(raw, 'getHostSettings', []),
    setHostShortcutEnabled: enabled => call(raw, 'setHostShortcutEnabled', [enabled]),
    setLoginStart: enabled => call(raw, 'setLoginStart', [enabled]),
  };
}
export function resolveHostPreferencesViewBridge(raw: unknown): HostPreferencesViewBridge | null {
  if (!controlCenter(raw) || ['getHostPreferences', 'saveHostPreferences', 'exportBackup'].some(name => typeof raw[name] !== 'function')) return null;
  return {
    getHostPreferences: () => call(raw, 'getHostPreferences', []),
    saveHostPreferences: edit => call(raw, 'saveHostPreferences', [edit]),
    exportBackup: () => call(raw, 'exportBackup', []),
  };
}
