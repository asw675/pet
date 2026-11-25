import { hostSettingsSchema, hostSettingsToggleSchema, hostShortcuts } from '../shared/host-settings-ipc';
import type {
  HostLoginSettings, HostSettings, HostSettingsErrorCode, HostSettingsResult,
  HostShortcutId, HostShortcutSettings, HostShortcutStatus,
} from '../shared/host-settings-ipc';

/** Main owns this port. Test code injects mocks; no Electron import or
 * registration at module initialization. See Electron's official API:
 * https://www.electronjs.org/docs/latest/api/global-shortcut */
export interface HostGlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  isRegistered(accelerator: string): boolean;
  unregister(accelerator: string): void;
}
/** Only the app's own default login item, never registry/path/args control.
 * https://www.electronjs.org/docs/latest/api/app/#appgetloginitemsettingsoptions-macos-windows */
export interface HostLoginAppPort {
  isReady(): boolean;
  readonly isPackaged: boolean;
  getLoginItemSettings(): { readonly openAtLogin: boolean; readonly executableWillLaunchAtLogin?: boolean };
  setLoginItemSettings(input: { openAtLogin: boolean }): void;
}
export interface HostShortcutActions {
  openControlCenter(): void | Promise<void>;
  togglePetVisibility(): void | Promise<void>;
  /** Trusted caller implements an existing bounded temporary interaction
   * rescue, not an indefinitely non-pass-through transparent window. */
  rescueInteraction(): void | Promise<void>;
}
export interface HostShortcutOptions {
  globalShortcut: HostGlobalShortcutPort;
  loginApp: HostLoginAppPort;
  actions: HostShortcutActions;
  platform?: NodeJS.Platform;
  initialShortcutEnabled?: boolean;
  /** Root may set PERSISTED only when authoritative storage saves this value
   * before calling setHostShortcutEnabled, otherwise runtime session only. */
  shortcutPreferenceScope?: HostShortcutSettings['preferenceScope'];
}
type Shortcut = typeof hostShortcuts[number];
interface Registration { readonly nonce: number; active: boolean }
const ok = (settings: HostSettings): HostSettingsResult => ({ ok: true, settings });
const fail = (code: HostSettingsErrorCode, settings: HostSettings | null = null): HostSettingsResult => ({ ok: false, code, settings });

/** This controller owns only three app-specific shortcuts and the user's
 * explicit app-login setting. It does not install keyboard hooks, remap keys,
 * run commands, inspect other apps, or mutate login settings at startup. */
export class HostShortcutController {
  private readonly platform: NodeJS.Platform;
  private readonly preferenceScope: HostShortcutSettings['preferenceScope'];
  private readonly owned = new Map<HostShortcutId, Registration>();
  private readonly states = new Map<HostShortcutId, HostShortcutStatus>();
  private desired: boolean;
  private started = false;
  private closed = false;
  private nonce = 0;

  constructor(private readonly options: HostShortcutOptions) {
    this.platform = options.platform ?? process.platform;
    this.preferenceScope = options.shortcutPreferenceScope ?? 'SESSION';
    this.desired = options.initialShortcutEnabled !== false;
  }
  private appReady(): boolean {
    try { return this.options.loginApp.isReady() === true; } catch { return false; }
  }
  private shortcutAvailability(): HostShortcutSettings['availability'] {
    if (this.closed) return 'STOPPED';
    if (this.platform !== 'win32') return 'NON_WINDOWS';
    return this.started && this.appReady() ? 'READY' : 'NOT_READY';
  }
  private getRegistered(shortcut: Shortcut): boolean | null {
    try {
      const result = this.options.globalShortcut.isRegistered(shortcut.accelerator);
      return typeof result === 'boolean' ? result : null;
    } catch { return null; }
  }
  private setState(shortcut: Shortcut, state: HostShortcutStatus): void { this.states.set(shortcut.id, state); }
  private fire(shortcut: Shortcut, registration: Registration): void {
    // Even a late Electron callback after failed OS unregister/shutdown must
    // be inert. Check the registration instance, host lifecycle and intent.
    if (this.closed || !this.started || !this.desired || !registration.active || this.owned.get(shortcut.id) !== registration
      || this.shortcutAvailability() !== 'READY' || this.getRegistered(shortcut) !== true) return;
    try {
      const actions = this.options.actions;
      const pending = shortcut.id === 'OPEN_CONTROL_CENTER' ? actions.openControlCenter()
        : shortcut.id === 'TOGGLE_PET_VISIBILITY' ? actions.togglePetVisibility() : actions.rescueInteraction();
      void Promise.resolve(pending).catch(() => undefined); // tray remains independent
    } catch { /* one failed callback cannot disrupt the other shortcuts/tray */ }
  }
  private release(shortcut: Shortcut): boolean {
    const registration = this.owned.get(shortcut.id);
    if (!registration) return true;
    registration.active = false; // disable callback before touching OS
    const present = this.getRegistered(shortcut);
    if (present === false) { this.owned.delete(shortcut.id); return true; }
    try {
      // Only registrations successfully acquired by this controller. Do not
      // unregisterAll, which may revoke another subsystem's shortcut.
      this.options.globalShortcut.unregister(shortcut.accelerator);
    } catch { return false; }
    if (this.getRegistered(shortcut) !== false) return false;
    this.owned.delete(shortcut.id);
    return true;
  }
  private tryRegister(shortcut: Shortcut): void {
    const previous = this.owned.get(shortcut.id);
    if (previous?.active && this.getRegistered(shortcut) === true) { this.setState(shortcut, 'REGISTERED'); return; }
    if (previous && !this.release(shortcut)) { this.setState(shortcut, 'ERROR'); return; }
    const already = this.getRegistered(shortcut);
    if (already !== false) {
      // Same accelerator may already belong to a different in-process
      // component. Never replace/unregister someone else's registration.
      this.setState(shortcut, already === true ? 'CONFLICT' : 'ERROR');
      return;
    }
    if (this.nonce >= Number.MAX_SAFE_INTEGER) { this.setState(shortcut, 'ERROR'); return; }
    const registration: Registration = { nonce: ++this.nonce, active: false };
    try {
      const accepted = this.options.globalShortcut.register(shortcut.accelerator, () => this.fire(shortcut, registration));
      if (accepted !== true) {
        this.setState(shortcut, accepted === false ? 'CONFLICT' : 'ERROR');
        return;
      }
      this.owned.set(shortcut.id, registration);
      if (this.getRegistered(shortcut) !== true) {
        this.release(shortcut);
        this.setState(shortcut, 'ERROR');
        return;
      }
      registration.active = true;
      this.setState(shortcut, 'REGISTERED');
    } catch {
      // Registration only counted when the OS returned true. A throwing or
      // conflicting registration is never reported as success.
      this.setState(shortcut, 'ERROR');
    }
  }
  private applyShortcuts(): void {
    if (this.shortcutAvailability() !== 'READY') return;
    for (const shortcut of hostShortcuts) {
      if (this.desired) this.tryRegister(shortcut);
      else this.setState(shortcut, this.release(shortcut) ? 'DISABLED' : 'ERROR');
    }
  }
  /** Call after app.whenReady and after native tray action callbacks exist.
   * No effect before ready; calling later when ready will initialize. */
  start(): HostSettingsResult {
    if (this.closed) return fail('SERVICE_UNAVAILABLE');
    if (!this.appReady()) return fail('SERVICE_UNAVAILABLE', this.snapshot());
    if (!this.started) { this.started = true; this.applyShortcuts(); }
    return this.getHostSettings();
  }
  private readShortcuts(): HostShortcutSettings {
    const availability = this.shortcutAvailability();
    const stateFor = (shortcut: Shortcut): HostShortcutStatus => {
      if (availability === 'NON_WINDOWS') return 'UNSUPPORTED';
      if (availability !== 'READY') return 'UNAVAILABLE';
      const owned = this.owned.get(shortcut.id);
      if (!this.desired) {
        if (!owned) return 'DISABLED';
        const present = this.getRegistered(shortcut);
        if (present === false) { this.owned.delete(shortcut.id); return 'DISABLED'; }
        return 'ERROR';
      }
      if (owned?.active) {
        const present = this.getRegistered(shortcut);
        if (present === true) return 'REGISTERED';
        // Lost OS registration or unverifiable state. Callback becomes inert;
        // an explicit enable/retry can reacquire, never steal automatically.
        owned.active = false;
        if (present === false) this.owned.delete(shortcut.id);
        this.setState(shortcut, 'ERROR');
        return 'ERROR';
      }
      return this.states.get(shortcut.id) === 'CONFLICT' ? 'CONFLICT' : 'ERROR';
    };
    const [p, h, i] = hostShortcuts;
    return { availability, enabled: this.desired, preferenceScope: this.preferenceScope,
      entries: [{ ...p, status: stateFor(p) }, { ...h, status: stateFor(h) }, { ...i, status: stateFor(i) }] };
  }
  private unavailableLogin(availability: Exclude<HostLoginSettings['availability'], 'READY'>): HostLoginSettings {
    return { availability, openAtLogin: null, executableWillLaunchAtLogin: null };
  }
  private readLogin(): HostLoginSettings {
    if (this.closed) return this.unavailableLogin('STOPPED');
    if (this.platform !== 'win32') return this.unavailableLogin('NON_WINDOWS');
    if (!this.appReady()) return this.unavailableLogin('NOT_READY');
    try {
      // Setting a login item for the generic development Electron binary
      // could launch the wrong project; development is explicitly excluded.
      if (this.options.loginApp.isPackaged !== true) return this.unavailableLogin('DEVELOPMENT');
      const value = this.options.loginApp.getLoginItemSettings();
      if (typeof value?.openAtLogin !== 'boolean' || typeof value.executableWillLaunchAtLogin !== 'boolean')
        return this.unavailableLogin('OS_ERROR');
      return { availability: 'READY', openAtLogin: value.openAtLogin,
        executableWillLaunchAtLogin: value.executableWillLaunchAtLogin };
    } catch { return this.unavailableLogin('OS_ERROR'); }
  }
  private snapshot(login = this.readLogin()): HostSettings {
    return hostSettingsSchema.parse({ shortcuts: this.readShortcuts(), loginStart: login });
  }
  getHostSettings(): HostSettingsResult {
    return this.closed ? fail('SERVICE_UNAVAILABLE', this.snapshot()) : ok(this.snapshot());
  }
  /** Trusted root persists the user's preference first when scope is
   * PERSISTED. Partial conflict is a successful preference update with
   * honest per-key status; explicit enable again permits a retry. */
  setHostShortcutEnabled(raw: unknown): HostSettingsResult {
    const parsed = hostSettingsToggleSchema.safeParse(raw);
    if (!parsed.success) return fail('INVALID_REQUEST');
    const availability = this.shortcutAvailability();
    if (availability !== 'READY') return fail(availability === 'NON_WINDOWS' ? 'UNSUPPORTED' : 'SERVICE_UNAVAILABLE', this.snapshot());
    this.desired = parsed.data;
    this.applyShortcuts();
    return ok(this.snapshot());
  }
  /** Only call from the explicit CC host-setting UI operation. No startup,
   * shortcut lifecycle or background preference can call this method. */
  setLoginStart(raw: unknown): HostSettingsResult {
    const parsed = hostSettingsToggleSchema.safeParse(raw);
    if (!parsed.success) return fail('INVALID_REQUEST');
    const before = this.readLogin();
    if (before.availability !== 'READY') return fail(before.availability === 'NON_WINDOWS' || before.availability === 'DEVELOPMENT'
      ? 'UNSUPPORTED' : 'SERVICE_UNAVAILABLE', this.snapshot(before));
    const enabled = parsed.data;
    // A different Windows launch item can still refer to the same binary;
    // do not silently alter unrelated launch items to force a global state.
    if (before.openAtLogin === enabled && (!enabled || before.executableWillLaunchAtLogin)) return ok(this.snapshot(before));
    try { this.options.loginApp.setLoginItemSettings({ openAtLogin: enabled }); }
    catch { return fail('OS_REJECTED', this.snapshot()); }
    const after = this.readLogin();
    if (after.availability !== 'READY' || after.openAtLogin !== enabled || (enabled && !after.executableWillLaunchAtLogin))
      return fail('OS_REJECTED', this.snapshot(after));
    return ok(this.snapshot(after));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Invalidate all our callbacks even if the OS denies cleanup. Never
    // unregister other accelerators or modify login-on-start when exiting.
    for (const shortcut of hostShortcuts) {
      try { this.release(shortcut); } catch { /* callbacks already inert */ }
    }
  }
}
