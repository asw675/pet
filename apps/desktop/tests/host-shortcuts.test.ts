import { describe, expect, it, vi } from 'vitest';
import { HostShortcutController } from '../src/main/host-shortcuts.js';
import type { HostGlobalShortcutPort, HostLoginAppPort, HostShortcutActions } from '../src/main/host-shortcuts.js';
import { hostSettingsResultSchema, hostSettingsSchema, hostSettingsToggleSchema, hostShortcuts } from '../src/shared/host-settings-ipc.js';
import type { HostSettingsResult, HostShortcutSettings } from '../src/shared/host-settings-ipc.js';

const p = hostShortcuts[0].accelerator, h = hostShortcuts[1].accelerator, i = hostShortcuts[2].accelerator;
const statuses = (result: HostSettingsResult) => result.settings?.shortcuts.entries.map(entry => entry.status);
function setup(options: { ready?: boolean; packaged?: boolean; platform?: NodeJS.Platform; enabled?: boolean;
  scope?: HostShortcutSettings['preferenceScope'] } = {}) {
  const state = { ready: options.ready ?? true, packaged: options.packaged ?? true, openAtLogin: false, effective: false };
  const registrations = new Map<string, () => void>(), conflicts = new Set<string>();
  const globalShortcut = {
    register: vi.fn<HostGlobalShortcutPort['register']>().mockImplementation((accelerator, callback) => {
      if (conflicts.has(accelerator) || registrations.has(accelerator)) return false;
      registrations.set(accelerator, callback); return true;
    }),
    isRegistered: vi.fn<HostGlobalShortcutPort['isRegistered']>().mockImplementation(accelerator => registrations.has(accelerator)),
    unregister: vi.fn<HostGlobalShortcutPort['unregister']>().mockImplementation(accelerator => { registrations.delete(accelerator); }),
  };
  const loginApp = {
    isReady: vi.fn<HostLoginAppPort['isReady']>().mockImplementation(() => state.ready),
    get isPackaged() { return state.packaged; },
    getLoginItemSettings: vi.fn<HostLoginAppPort['getLoginItemSettings']>().mockImplementation(() =>
      ({ openAtLogin: state.openAtLogin, executableWillLaunchAtLogin: state.effective })),
    setLoginItemSettings: vi.fn<HostLoginAppPort['setLoginItemSettings']>().mockImplementation(({ openAtLogin }) => {
      state.openAtLogin = openAtLogin; state.effective = openAtLogin;
    }),
  };
  const actions = {
    openControlCenter: vi.fn<HostShortcutActions['openControlCenter']>(),
    togglePetVisibility: vi.fn<HostShortcutActions['togglePetVisibility']>(),
    rescueInteraction: vi.fn<HostShortcutActions['rescueInteraction']>(),
  };
  const controller = new HostShortcutController({ platform: options.platform ?? 'win32', globalShortcut, loginApp, actions,
    ...(options.enabled !== undefined ? { initialShortcutEnabled: options.enabled } : {}),
    ...(options.scope !== undefined ? { shortcutPreferenceScope: options.scope } : {}) });
  return { state, registrations, conflicts, globalShortcut, loginApp, actions, controller };
}

describe('fixed global shortcuts registration', () => {
  it('does nothing at construction; starts exact three accelerators after app ready without login changes', () => {
    const d = setup();
    expect(d.globalShortcut.register).not.toHaveBeenCalled();
    expect(d.loginApp.getLoginItemSettings).not.toHaveBeenCalled();
    expect(statuses(d.controller.getHostSettings())).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
    expect(statuses(d.controller.start())).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
    expect(d.globalShortcut.register.mock.calls.map(([key]) => key)).toEqual([p, h, i]);
    expect(d.controller.getHostSettings().settings?.shortcuts.preferenceScope).toBe('SESSION');
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
    expect(d.controller.start().ok).toBe(true);
    expect(d.globalShortcut.register).toHaveBeenCalledTimes(3);
  });
  it('never touches globalShortcut before app readiness and can start after readiness', () => {
    const d = setup({ ready: false });
    expect(d.controller.start()).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE',
      settings: { shortcuts: { availability: 'NOT_READY' }, loginStart: { availability: 'NOT_READY' } } });
    expect(d.globalShortcut.register).not.toHaveBeenCalled();
    expect(d.globalShortcut.isRegistered).not.toHaveBeenCalled();
    d.state.ready = true;
    expect(statuses(d.controller.start())).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
  });
  it('respects persisted initial disabled preference and does not create registrations', () => {
    const d = setup({ enabled: false, scope: 'PERSISTED' });
    const result = d.controller.start();
    expect(result.settings?.shortcuts).toMatchObject({ enabled: false, preferenceScope: 'PERSISTED', availability: 'READY' });
    expect(statuses(result)).toEqual(['DISABLED', 'DISABLED', 'DISABLED']);
    expect(d.globalShortcut.register).not.toHaveBeenCalled();
    expect(d.globalShortcut.unregister).not.toHaveBeenCalled();
  });
  it('registered callbacks invoke only their fixed host action', () => {
    const d = setup(); d.controller.start();
    d.registrations.get(p)!(); expect(d.actions.openControlCenter).toHaveBeenCalledOnce();
    expect(d.actions.togglePetVisibility).not.toHaveBeenCalled();
    expect(d.actions.rescueInteraction).not.toHaveBeenCalled();
    d.registrations.get(h)!(); expect(d.actions.togglePetVisibility).toHaveBeenCalledOnce();
    d.registrations.get(i)!(); expect(d.actions.rescueInteraction).toHaveBeenCalledOnce();
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('reports partial OS registration failure and does not disable other keys or retry the conflict on reads', () => {
    const d = setup(); d.conflicts.add(h);
    expect(statuses(d.controller.start())).toEqual(['REGISTERED', 'CONFLICT', 'REGISTERED']);
    expect(statuses(d.controller.getHostSettings())).toEqual(['REGISTERED', 'CONFLICT', 'REGISTERED']);
    expect(d.globalShortcut.register).toHaveBeenCalledTimes(3);
    expect(d.registrations.has(h)).toBe(false);
    d.registrations.get(i)!();
    expect(d.actions.rescueInteraction).toHaveBeenCalledOnce();
    d.conflicts.delete(h);
    expect(statuses(d.controller.setHostShortcutEnabled(true))).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
    expect(d.globalShortcut.register.mock.calls.map(([key]) => key)).toEqual([p, h, i, h]);
  });
  it('does not overwrite or unregister a shortcut owned by another in-process subsystem', () => {
    const d = setup(), unrelated = vi.fn();
    d.registrations.set(p, unrelated); d.registrations.set('Control+F12', unrelated);
    expect(statuses(d.controller.start())).toEqual(['CONFLICT', 'REGISTERED', 'REGISTERED']);
    expect(d.globalShortcut.register.mock.calls.map(([key]) => key)).toEqual([h, i]);
    d.controller.close();
    expect(d.globalShortcut.unregister.mock.calls.map(([key]) => key)).toEqual([h, i]);
    expect(d.registrations.get(p)).toBe(unrelated);
    expect(d.registrations.has('Control+F12')).toBe(true);
  });
  it('does not trust true register result without actual isRegistered confirmation', () => {
    const d = setup();
    d.globalShortcut.register.mockReturnValueOnce(true); // fake reports success without installing callback
    expect(statuses(d.controller.start())).toEqual(['ERROR', 'REGISTERED', 'REGISTERED']);
    expect(d.registrations.has(p)).toBe(false);
    expect(d.controller.getHostSettings().settings?.shortcuts.enabled).toBe(true);
  });
  it('handles throwing registration/identity checks with independent per-key state', () => {
    const d = setup();
    d.globalShortcut.isRegistered.mockImplementationOnce(() => { throw new Error('private'); });
    d.globalShortcut.register.mockImplementationOnce(() => { throw new Error('private'); });
    expect(statuses(d.controller.start())).toEqual(['ERROR', 'ERROR', 'REGISTERED']);
    expect(d.registrations.has(i)).toBe(true);
    d.registrations.get(i)!();
    expect(d.actions.rescueInteraction).toHaveBeenCalledOnce();
  });
  it('disable unregisters exactly owned keys and invalidates stale callbacks across re-enable', () => {
    const d = setup(); d.controller.start();
    const old = d.registrations.get(p)!;
    expect(statuses(d.controller.setHostShortcutEnabled(false))).toEqual(['DISABLED', 'DISABLED', 'DISABLED']);
    expect(d.registrations.size).toBe(0); expect(d.globalShortcut.unregister).toHaveBeenCalledTimes(3);
    old(); expect(d.actions.openControlCenter).not.toHaveBeenCalled();
    expect(statuses(d.controller.setHostShortcutEnabled(true))).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
    old(); expect(d.actions.openControlCenter).not.toHaveBeenCalled();
    d.registrations.get(p)!(); expect(d.actions.openControlCenter).toHaveBeenCalledOnce();
  });
  it('unregister failure leaves status ERROR and old callback inert; a later close retries its own cleanup', () => {
    const d = setup(); d.controller.start();
    const old = d.registrations.get(p)!;
    d.globalShortcut.unregister.mockImplementationOnce(() => { throw new Error('private'); });
    expect(statuses(d.controller.setHostShortcutEnabled(false))).toEqual(['ERROR', 'DISABLED', 'DISABLED']);
    old(); expect(d.actions.openControlCenter).not.toHaveBeenCalled();
    expect(d.registrations.has(p)).toBe(true);
    d.controller.close();
    expect(d.registrations.size).toBe(0); expect(d.globalShortcut.unregister).toHaveBeenCalledTimes(4);
    old(); expect(d.actions.openControlCenter).not.toHaveBeenCalled();
  });
  it('detects registration lost by OS instead of pretending it is available', () => {
    const d = setup(); d.controller.start();
    const old = d.registrations.get(h)!; d.registrations.delete(h);
    old(); expect(d.actions.togglePetVisibility).not.toHaveBeenCalled();
    expect(statuses(d.controller.getHostSettings())).toEqual(['REGISTERED', 'ERROR', 'REGISTERED']);
    expect(d.globalShortcut.register).toHaveBeenCalledTimes(3);
    expect(statuses(d.controller.setHostShortcutEnabled(true))).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
    old(); expect(d.actions.togglePetVisibility).not.toHaveBeenCalled();
  });
  it('callback errors or rejected promises do not propagate or affect other keys', async () => {
    const d = setup(); d.controller.start();
    d.actions.openControlCenter.mockImplementation(() => { throw new Error('private'); });
    d.actions.togglePetVisibility.mockRejectedValue(new Error('private'));
    expect(() => d.registrations.get(p)!()).not.toThrow();
    expect(() => d.registrations.get(h)!()).not.toThrow();
    d.registrations.get(i)!(); expect(d.actions.rescueInteraction).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(statuses(d.controller.getHostSettings())).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
  });
  it('close is idempotent, stops all owned callbacks but never modifies OS login settings', () => {
    const d = setup(); d.controller.start();
    const callbacks = [...d.registrations.values()];
    d.controller.close(); d.controller.close();
    expect(d.globalShortcut.unregister.mock.calls.map(([key]) => key)).toEqual([p, h, i]);
    callbacks.forEach(callback => callback());
    expect(d.actions.openControlCenter).not.toHaveBeenCalled();
    expect(d.actions.togglePetVisibility).not.toHaveBeenCalled();
    expect(d.actions.rescueInteraction).not.toHaveBeenCalled();
    expect(d.controller.start()).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(d.controller.setHostShortcutEnabled(true)).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe('explicit Windows packaged application login setting', () => {
  it.each(['darwin', 'linux'] as const)('does not attempt unsupported host OS calls on %s', platform => {
    const d = setup({ platform });
    expect(d.controller.start()).toMatchObject({ ok: true, settings: { shortcuts: { availability: 'NON_WINDOWS' },
      loginStart: { availability: 'NON_WINDOWS', openAtLogin: null, executableWillLaunchAtLogin: null } } });
    expect(statuses(d.controller.getHostSettings())).toEqual(['UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED']);
    expect(d.controller.setHostShortcutEnabled(true)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(d.globalShortcut.register).not.toHaveBeenCalled(); expect(d.globalShortcut.isRegistered).not.toHaveBeenCalled();
    expect(d.loginApp.getLoginItemSettings).not.toHaveBeenCalled(); expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('allows Windows development hotkeys but explicitly refuses login-start configuration for generic Electron executable', () => {
    const d = setup({ packaged: false });
    expect(statuses(d.controller.start())).toEqual(['REGISTERED', 'REGISTERED', 'REGISTERED']);
    expect(d.controller.getHostSettings().settings?.loginStart.availability).toBe('DEVELOPMENT');
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(d.loginApp.getLoginItemSettings).not.toHaveBeenCalled(); expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('reads only actual OS booleans and never enables login on start or shortcut changes', () => {
    const d = setup(); d.state.openAtLogin = true; d.state.effective = false;
    expect(d.controller.start().settings?.loginStart).toEqual({ availability: 'READY', openAtLogin: true, executableWillLaunchAtLogin: false });
    d.controller.setHostShortcutEnabled(false);
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
    d.state.openAtLogin = false; d.state.effective = true;
    expect(d.controller.getHostSettings().settings?.loginStart).toEqual({ availability: 'READY', openAtLogin: false, executableWillLaunchAtLogin: true });
  });
  it('explicit true/false uses only the app default login item and reads back real state', () => {
    const d = setup(); d.controller.start();
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: true,
      settings: { loginStart: { availability: 'READY', openAtLogin: true, executableWillLaunchAtLogin: true } } });
    expect(d.loginApp.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true });
    expect(d.controller.setLoginStart(false)).toMatchObject({ ok: true,
      settings: { loginStart: { availability: 'READY', openAtLogin: false, executableWillLaunchAtLogin: false } } });
    expect(d.loginApp.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true }], [{ openAtLogin: false }]]);
  });
  it('does not silently mutate unrelated other login entries if our precise item already matches request', () => {
    const d = setup(); d.state.effective = true; d.controller.start();
    expect(d.controller.setLoginStart(false)).toMatchObject({ ok: true,
      settings: { loginStart: { availability: 'READY', openAtLogin: false, executableWillLaunchAtLogin: true } } });
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('reports OS rejection if configured item is not enabled by Windows, including a requested explicit retry', () => {
    const d = setup(); d.controller.start();
    d.loginApp.setLoginItemSettings.mockImplementation(({ openAtLogin }) => { d.state.openAtLogin = openAtLogin; d.state.effective = false; });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'OS_REJECTED',
      settings: { loginStart: { availability: 'READY', openAtLogin: true, executableWillLaunchAtLogin: false } } });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'OS_REJECTED' });
    expect(d.loginApp.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true }], [{ openAtLogin: true }]]);
  });
  it('handles setter exceptions and unchanged read-back honestly', () => {
    const d = setup(); d.controller.start();
    d.loginApp.setLoginItemSettings.mockImplementationOnce(() => { throw new Error('private'); }).mockImplementationOnce(() => {});
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'OS_REJECTED',
      settings: { loginStart: { availability: 'READY', openAtLogin: false } } });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'OS_REJECTED',
      settings: { loginStart: { availability: 'READY', openAtLogin: false } } });
  });
  it('read errors or missing Windows effective boolean never produce a fake state or write', () => {
    const d = setup(); d.controller.start();
    d.loginApp.getLoginItemSettings.mockReturnValue({ openAtLogin: false });
    expect(d.controller.getHostSettings().settings?.loginStart).toEqual({ availability: 'OS_ERROR', openAtLogin: null, executableWillLaunchAtLogin: null });
    expect(d.controller.setLoginStart(true)).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
    d.loginApp.getLoginItemSettings.mockImplementation(() => { throw new Error('raw registry path'); });
    expect(d.controller.getHostSettings().settings?.loginStart.availability).toBe('OS_ERROR');
  });
  it('does not leak OS-reported launchItems/raw paths in host settings', () => {
    const d = setup();
    d.loginApp.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: true,
      launchItems: [{ path: 'C:\\Private\\app.exe', args: ['private'] }] } as ReturnType<HostLoginAppPort['getLoginItemSettings']>);
    const result = d.controller.start();
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(JSON.stringify(result)).not.toContain('launchItems');
  });
});

describe('closed host settings IPC payloads', () => {
  it.each([null, 'true', 1, {}, { enabled: true, args: ['arbitrary'] }])('rejects non-boolean toggle %j before touching OS', raw => {
    const d = setup(); d.controller.start();
    expect(hostSettingsToggleSchema.safeParse(raw).success).toBe(false);
    expect(d.controller.setLoginStart(raw)).toEqual({ ok: false, code: 'INVALID_REQUEST', settings: null });
    expect(d.controller.setHostShortcutEnabled(raw)).toEqual({ ok: false, code: 'INVALID_REQUEST', settings: null });
    expect(d.loginApp.setLoginItemSettings).not.toHaveBeenCalled();
    expect(d.globalShortcut.register).toHaveBeenCalledTimes(3);
  });
  it('validates actual fixed tuple, rejects fake platform states, arbitrary accelerator and raw data', () => {
    const d = setup(); const result = d.controller.start();
    expect(hostSettingsResultSchema.safeParse(result).success).toBe(true);
    const current = result.settings!;
    expect(hostSettingsSchema.safeParse({ ...current, shortcuts: { ...current.shortcuts,
      entries: [{ ...current.shortcuts.entries[0], accelerator: 'Alt+F4' }, ...current.shortcuts.entries.slice(1)] } }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...current, shortcuts: { ...current.shortcuts, enabled: false } }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...current, loginStart: { ...current.loginStart, availability: 'DEVELOPMENT' } }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...current, loginStart: { ...current.loginStart, path: 'C:\\app.exe' } }).success).toBe(false);
    expect(hostSettingsResultSchema.safeParse({ ok: false, code: 'OS_REJECTED', settings: null, rawError: 'private' }).success).toBe(false);
  });
});
