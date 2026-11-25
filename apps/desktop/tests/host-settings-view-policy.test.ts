import { describe, expect, it, vi } from 'vitest';
import {
  backupViewResultSchema, hostPreferencesViewResultSchema, hostPreferencesViewSchema, hostScalePercents,
  preferenceDraft, preferenceSaveMatches, preferenceSavePayload, resolveHostPreferencesViewBridge, resolveHostSettingsViewBridge,
} from '../src/renderer/shared/host-settings-view-policy.js';
import type { HostPreferencesView } from '../src/renderer/shared/host-settings-view-policy.js';

const preferences: HostPreferencesView = { values: { hotkeysEnabled: true, scalePercent: 100, reducedMotion: false },
  revision: 7, updatedAt: '2026-11-25T17:00:00.000Z' };

describe('closed host preference renderer draft and actual-save confirmation', () => {
  it('projects only editable visual preferences, not the shortcut preference', () => {
    expect(preferenceDraft(preferences)).toEqual({ scalePercent: 100, reducedMotion: false });
    expect(preferenceSavePayload(preferences, { scalePercent: 150, reducedMotion: true })).toEqual({
      scalePercent: 150, reducedMotion: true, expectedRevision: 7,
    });
    expect(preferenceSavePayload(preferences, { scalePercent: 150, reducedMotion: false, hotkeysEnabled: false })).toBeNull();
    expect(preferenceSavePayload(preferences, { scalePercent: 150, reducedMotion: false, expectedRevision: 0 })).toBeNull();
  });
  it('does not allow a no-op, unconfirmed base or malformed stale revision to save', () => {
    expect(preferenceSavePayload(preferences, preferenceDraft(preferences))).toBeNull();
    expect(preferenceSavePayload(null, { scalePercent: 150, reducedMotion: true })).toBeNull();
    expect(preferenceSavePayload({ ...preferences, revision: -1 }, { scalePercent: 150, reducedMotion: true })).toBeNull();
  });
  it.each([0, 49, 60, 125.5, 250, '100', NaN, Infinity, null])('rejects unsupported scale %j', scalePercent => {
    expect(preferenceSavePayload(preferences, { scalePercent, reducedMotion: false })).toBeNull();
  });
  it('accepts the exact fixed scale choices and strict boolean motion flag', () => {
    expect(hostScalePercents).toEqual([50, 75, 100, 125, 150, 200]);
    for (const scalePercent of hostScalePercents) {
      expect(hostPreferencesViewSchema.safeParse({ ...preferences, values: { ...preferences.values, scalePercent } }).success).toBe(true);
    }
    expect(preferenceSavePayload(preferences, { scalePercent: 150, reducedMotion: 'true' })).toBeNull();
  });
  it('correlates successful save only on exact expected next revision and requested visual values', () => {
    const input = { scalePercent: 75 as const, reducedMotion: true, expectedRevision: 7 };
    const returned = { ...preferences, revision: 8, values: { ...preferences.values, scalePercent: 75 as const, reducedMotion: true } };
    expect(preferenceSaveMatches(input, returned)).toBe(true);
    expect(preferenceSaveMatches(input, { ...returned, revision: 7 })).toBe(false);
    expect(preferenceSaveMatches(input, { ...returned, revision: 9 })).toBe(false);
    expect(preferenceSaveMatches(input, { ...returned, values: { ...returned.values, reducedMotion: false } })).toBe(false);
    expect(preferenceSaveMatches(input, { ...returned, values: { ...returned.values, scalePercent: 100 } })).toBe(false);
  });
  it('rejects raw paths/extra keys or fabricated response status, accepts authoritative default or timestamp', () => {
    expect(hostPreferencesViewResultSchema.safeParse({ ok: true, preferences }).success).toBe(true);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: true, preferences: { ...preferences, updatedAt: null } }).success).toBe(true);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: true, preferences: { ...preferences, updatedAt: 'not a date' } }).success).toBe(false);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: true, preferences: { ...preferences, path: 'C:\\private' } }).success).toBe(false);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: false, code: 'CONFLICT' }).success).toBe(true);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: false, code: 'CONFLICT', rawError: 'private' }).success).toBe(false);
    expect(hostPreferencesViewResultSchema.safeParse({ ok: false, code: 'C:\\private' }).success).toBe(false);
  });
  it('backup success has only a valid schema version, never output location or raw errors', () => {
    expect(backupViewResultSchema.safeParse({ ok: true, schemaVersion: 11 }).success).toBe(true);
    expect(backupViewResultSchema.safeParse({ ok: true, schemaVersion: 0 }).success).toBe(false);
    expect(backupViewResultSchema.safeParse({ ok: true, schemaVersion: 11, path: 'C:\\private\\backup.db' }).success).toBe(false);
    expect(backupViewResultSchema.safeParse({ ok: false, code: 'CANCELLED' }).success).toBe(true);
    expect(backupViewResultSchema.safeParse({ ok: false, code: 'CANCELLED', path: 'C:\\private' }).success).toBe(false);
  });
});

describe('view degrades safely for old/missing preload, uses only explicit fixed calls', () => {
  const methods = () => ({
    role: 'control-center', getHostSettings: vi.fn().mockResolvedValue({ ok: true }), setHostShortcutEnabled: vi.fn().mockResolvedValue({ ok: true }),
    setLoginStart: vi.fn().mockResolvedValue({ ok: true }), getHostPreferences: vi.fn().mockResolvedValue({ ok: true, preferences }),
    saveHostPreferences: vi.fn().mockResolvedValue({ ok: true, preferences }), exportBackup: vi.fn().mockResolvedValue({ ok: true, schemaVersion: 11 }),
  });
  it('does not expose host actions through a pet bridge or partially available host', () => {
    expect(resolveHostSettingsViewBridge(null)).toBeNull();
    expect(resolveHostPreferencesViewBridge(undefined)).toBeNull();
    expect(resolveHostSettingsViewBridge({ ...methods(), role: 'pet' })).toBeNull();
    expect(resolveHostPreferencesViewBridge({ ...methods(), role: 'pet' })).toBeNull();
    expect(resolveHostSettingsViewBridge({ ...methods(), setLoginStart: null })).toBeNull();
    expect(resolveHostPreferencesViewBridge({ ...methods(), exportBackup: undefined })).toBeNull();
  });
  it('forwards exact fixed calls without any invocation during guard creation', async () => {
    const raw = methods(), host = resolveHostSettingsViewBridge(raw)!, pref = resolveHostPreferencesViewBridge(raw)!;
    expect(raw.getHostSettings).not.toHaveBeenCalled();
    expect(raw.setLoginStart).not.toHaveBeenCalled();
    expect(raw.exportBackup).not.toHaveBeenCalled();
    await host.getHostSettings(); await host.setHostShortcutEnabled(false); await host.setLoginStart(true);
    await pref.getHostPreferences(); await pref.saveHostPreferences({ scalePercent: 125, reducedMotion: true, expectedRevision: 7 });
    await pref.exportBackup();
    expect(raw.getHostSettings).toHaveBeenCalledExactlyOnceWith();
    expect(raw.setHostShortcutEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(raw.setLoginStart).toHaveBeenCalledExactlyOnceWith(true);
    expect(raw.getHostPreferences).toHaveBeenCalledExactlyOnceWith();
    expect(raw.saveHostPreferences).toHaveBeenCalledExactlyOnceWith({ scalePercent: 125, reducedMotion: true, expectedRevision: 7 });
    expect(raw.exportBackup).toHaveBeenCalledExactlyOnceWith();
  });
});
