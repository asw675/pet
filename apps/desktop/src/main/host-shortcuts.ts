import { defaultHostShortcutBindings, hostShortcutBindingsSchema, hostShortcutIds } from '@pet-desktop/contracts/host-shortcuts';
import type { HostShortcutBindings } from '@pet-desktop/contracts/host-shortcuts';
import { hostSettingsSchema, hostSettingsToggleSchema } from '../shared/host-settings-ipc';
import type {
  HostLoginSettings, HostSettings, HostSettingsErrorCode, HostSettingsResult,
  HostShortcutBindingsResult, HostShortcutId, HostShortcutSettings, HostShortcutStatus,
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
  initialShortcutBindings?: HostShortcutBindings;
  /** Root may set PERSISTED only when authoritative storage saves this value
   * before calling setHostShortcutEnabled, otherwise runtime session only. */
  shortcutPreferenceScope?: HostShortcutSettings['preferenceScope'];
}
type Shortcut = { id: HostShortcutId; accelerator: string };
interface Registration { readonly accelerator: string; id: HostShortcutId; active: boolean }
type PreparedBindings = { ok: true; apply(): void; discard(): void } | Extract<HostShortcutBindingsResult, { ok: false }>;
const ok = (settings: HostSettings): HostSettingsResult => ({ ok: true, settings });
const fail = (code: HostSettingsErrorCode, settings: HostSettings | null = null): HostSettingsResult => ({ ok: false, code, settings });

/** This controller owns only three app-specific shortcuts and the user's
 * explicit app-login setting. It does not install keyboard hooks, remap keys,
 * run commands, inspect other apps, or mutate login settings at startup. */
export class HostShortcutController {
  private readonly platform: NodeJS.Platform;
  private readonly preferenceScope: HostShortcutSettings['preferenceScope'];
  private readonly owned = new Map<string, Registration>();
  private readonly states = new Map<HostShortcutId, HostShortcutStatus>();
  private desired: boolean;
  private bindings: HostShortcutBindings;
  private pendingBindingChange: symbol | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly options: HostShortcutOptions) {
    this.platform = options.platform ?? process.platform;
    this.preferenceScope = options.shortcutPreferenceScope ?? 'SESSION';
    this.desired = options.initialShortcutEnabled !== false;
    this.bindings = hostShortcutBindingsSchema.parse(options.initialShortcutBindings ?? defaultHostShortcutBindings);
  }
  private appReady(): boolean {
    try { return this.options.loginApp.isReady() === true; } catch { return false; }
  }
  private shortcutAvailability(): HostShortcutSettings['availability'] {
    if (this.closed) return 'STOPPED';
    if (this.platform !== 'win32') return 'NON_WINDOWS';
    return this.started && this.appReady() ? 'READY' : 'NOT_READY';
  }
  private getRegistered(accelerator: string): boolean | null {
    try {
      const result = this.options.globalShortcut.isRegistered(accelerator);
      return typeof result === 'boolean' ? result : null;
    } catch { return null; }
  }
  private fire(registration: Registration): void {
    // Even a late Electron callback after failed OS unregister/shutdown must
    // be inert. Check the registration instance, host lifecycle and intent.
    if (this.closed || !this.started || !this.desired || !registration.active
      || this.owned.get(registration.accelerator) !== registration || this.bindings[registration.id] !== registration.accelerator
      || this.shortcutAvailability() !== 'READY' || this.getRegistered(registration.accelerator) !== true) return;
    try {
      const actions = this.options.actions;
      const pending = registration.id === 'OPEN_CONTROL_CENTER' ? actions.openControlCenter()
        : registration.id === 'TOGGLE_PET_VISIBILITY' ? actions.togglePetVisibility() : actions.rescueInteraction();
      void Promise.resolve(pending).catch(() => undefined); // tray remains independent
    } catch { /* one failed callback cannot disrupt the other shortcuts/tray */ }
  }
  private release(accelerator: string): boolean {
    const registration = this.owned.get(accelerator);
    if (!registration) return true;
    registration.active = false; // disable callback before touching OS
    const present = this.getRegistered(accelerator);
    if (present === false) { this.owned.delete(accelerator); return true; }
    try {
      // Only registrations successfully acquired by this controller. Do not
      // unregisterAll, which may revoke another subsystem's shortcut.
      this.options.globalShortcut.unregister(accelerator);
    } catch { return false; }
    if (this.getRegistered(accelerator) !== false) return false;
    this.owned.delete(accelerator);
    return true;
  }
  private tryRegister(shortcut: Shortcut, active: boolean): HostShortcutStatus {
    const { accelerator, id } = shortcut;
    const previous = this.owned.get(accelerator);
    if (previous && this.getRegistered(accelerator) === true) {
      if (active) { previous.id = id; previous.active = true; }
      return 'REGISTERED';
    }
    if (previous && !this.release(accelerator)) return 'ERROR';
    const already = this.getRegistered(accelerator);
    if (already !== false) {
      // Same accelerator may already belong to a different in-process
      // component. Never replace/unregister someone else's registration.
      return already === true ? 'CONFLICT' : 'ERROR';
    }
    const registration: Registration = { accelerator, id, active: false };
    try {
      const accepted = this.options.globalShortcut.register(accelerator, () => this.fire(registration));
      if (accepted !== true) return accepted === false ? 'CONFLICT' : 'ERROR';
      this.owned.set(accelerator, registration);
      if (this.getRegistered(accelerator) !== true) {
        this.release(accelerator);
        return 'ERROR';
      }
      registration.active = active;
      return 'REGISTERED';
    } catch {
      // Registration only counted when the OS returned true. A throwing or
      // conflicting registration is never reported as success.
      return 'ERROR';
    }
  }
  private applyShortcuts(): void {
    if (this.shortcutAvailability() !== 'READY') return;
    const configured = new Set(Object.values(this.bindings));
    for (const accelerator of this.owned.keys()) {
      if (!this.desired || !configured.has(accelerator)) this.release(accelerator);
    }
    for (const id of hostShortcutIds) {
      const accelerator = this.bindings[id];
      this.states.set(id, this.desired ? this.tryRegister({ id, accelerator }, true) : this.owned.has(accelerator) ? 'ERROR' : 'DISABLED');
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
    const stateFor = (id: HostShortcutId): HostShortcutStatus => {
      if (availability === 'NON_WINDOWS') return 'UNSUPPORTED';
      if (availability !== 'READY') return 'UNAVAILABLE';
      const accelerator = this.bindings[id];
      const owned = this.owned.get(accelerator);
      if (!this.desired) {
        if (!owned) return 'DISABLED';
        const present = this.getRegistered(accelerator);
        if (present === false) { this.owned.delete(accelerator); return 'DISABLED'; }
        return 'ERROR';
      }
      if (owned?.active && owned.id === id) {
        const present = this.getRegistered(accelerator);
        if (present === true) return 'REGISTERED';
        // Lost OS registration or unverifiable state. Callback becomes inert;
        // an explicit enable/retry can reacquire, never steal automatically.
        owned.active = false;
        if (present === false) this.owned.delete(accelerator);
        this.states.set(id, 'ERROR');
        return 'ERROR';
      }
      return this.states.get(id) === 'CONFLICT' ? 'CONFLICT' : 'ERROR';
    };
    const entry = <Id extends HostShortcutId>(id: Id) => ({ id, accelerator: this.bindings[id], status: stateFor(id) });
    return { availability, enabled: this.desired, preferenceScope: this.preferenceScope,
      entries: [entry(hostShortcutIds[0]), entry(hostShortcutIds[1]), entry(hostShortcutIds[2])] };
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
    if (this.pendingBindingChange) return fail('SERVICE_UNAVAILABLE', this.snapshot());
    this.desired = parsed.data;
    this.applyShortcuts();
    return ok(this.snapshot());
  }

  /** Probe new keys with inert callbacks while the old keys still work.
   * Activation follows the caller's authoritative save. Conflicts and a
   * failed save clean up only registrations made by this particular edit. */
  prepareBindings(raw: unknown): PreparedBindings {
    const parsed = hostShortcutBindingsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'INVALID_REQUEST' };
    const availability = this.shortcutAvailability();
    if (availability !== 'READY') return { ok: false, code: availability === 'NON_WINDOWS' ? 'UNSUPPORTED' : 'SERVICE_UNAVAILABLE' };
    if (this.pendingBindingChange) return { ok: false, code: 'BUSY' };
    const token = Symbol(), next = parsed.data;
    const acquired = new Set<string>();
    this.pendingBindingChange = token;
    const discard = (): void => {
      if (this.pendingBindingChange !== token) return;
      this.pendingBindingChange = undefined;
      for (const accelerator of acquired) this.release(accelerator);
    };
    if (this.desired) {
      for (const id of hostShortcutIds) {
        const accelerator = next[id];
        if (accelerator === this.bindings[id]) continue;
        const previous = this.owned.get(accelerator);
        const state = this.tryRegister({ id, accelerator }, false);
        if (this.owned.has(accelerator) && this.owned.get(accelerator) !== previous) acquired.add(accelerator);
        if (state !== 'REGISTERED') {
          discard();
          return { ok: false, code: state === 'CONFLICT' ? 'CONFLICT' : 'OS_ERROR', id };
        }
      }
    }
    return {
      ok: true,
      apply: () => {
        if (this.pendingBindingChange !== token) return;
        this.pendingBindingChange = undefined;
        this.bindings = next;
        this.applyShortcuts();
      },
      discard,
    };
  }

  /** Reconcile a verified writer read after reconnecting or losing an
   * acknowledgment. Registration may have changed at OS level meanwhile. */
  applyStoredBindings(raw: HostShortcutBindings): void {
    if (this.closed || this.pendingBindingChange) return;
    const bindings = hostShortcutBindingsSchema.parse(raw);
    if (hostShortcutIds.every(id => this.bindings[id] === bindings[id])) return;
    this.bindings = bindings;
    this.applyShortcuts();
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
    this.pendingBindingChange = undefined;
    // Invalidate all our callbacks even if the OS denies cleanup. Never
    // unregister other accelerators or modify login-on-start when exiting.
    for (const accelerator of this.owned.keys()) {
      try { this.release(accelerator); } catch { /* callbacks already inert */ }
    }
  }
}
