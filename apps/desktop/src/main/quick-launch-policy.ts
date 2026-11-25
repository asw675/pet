/** Main-only quick-workspace policy. Host-specific filesystem observations,
 * trusted native user input and launch adapters are injected. This module
 * neither reads the filesystem directly nor opens a window/process/URL.
 *
 * Platform constraints: Microsoft Learn (Naming Files, Paths, Namespaces;
 * GetDriveTypeW; FILE_ID_INFO; Reparse Points and File Operations), Electron
 * dialog/shell/security, Node child_process. A real Windows adapter is still
 * required to establish the observations below; mock tests do not prove it.
 */
export type QuickLaunchKind = 'WIN32_EXE' | 'FOLDER' | 'HTTPS';
export const quickLaunchLimits = Object.freeze({
  maxPathUnits: 259, maxPathComponents: 64, maxUrlUnits: 2048,
  maxExecutableBytes: 256 * 1024 * 1024, approvalTtlMs: 30_000,
  pendingApprovals: 64, inspectionTimeoutMs: 10_000, authorityTimeoutMs: 5_000, launchTimeoutMs: 5_000,
});

export interface QuickLaunchSender {
  readonly role: 'control-center';
  readonly senderId: number;
  /** Main-owned document instance identity; must change on reload/navigation. */
  readonly documentId: string;
}
export interface QuickLaunchContext {
  readonly sender: QuickLaunchSender;
  /** Workspace revision for adding, saved action revision for running. */
  readonly expectedRevision: number;
}

export interface LocalFileIdentity {
  /** Canonical lower-case hex from a handle-scoped FILE_ID_INFO observation. */
  readonly volumeSerial: string;
  readonly fileId: string;
}
export interface LocalPathObservation {
  readonly canonicalPath: string;
  readonly identity: LocalFileIdentity;
  readonly kind: 'FILE' | 'DIRECTORY' | 'OTHER';
  readonly reparsePoint: boolean;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}
export interface ExecutableObservation extends LocalPathObservation {
  readonly kind: 'FILE';
  readonly sha256: string;
  /** Native adapter must establish a supported PE executable, not merely an extension. */
  readonly format: 'PE_EXE' | 'UNKNOWN';
  /** Fail closed if native PE/metadata checks cannot establish this narrower slice.
   * Classification is not a proof of arbitrary EXE behavior or safety. */
  readonly classification: 'USER_APPLICATION' | 'PROHIBITED' | 'UNKNOWN';
  readonly originalFilename: string | null;
}
export type LocalDriveType = 'FIXED' | 'REMOTE' | 'REMOVABLE' | 'CDROM' | 'RAMDISK' | 'UNKNOWN';

export interface QuickLaunchFsPort {
  /** DRIVE_FIXED alone is insufficient if drive is an alias/substitution.
   * Adapter must reject ambiguous/mapped drives rather than reporting FIXED. */
  driveType(root: string, signal: AbortSignal): Promise<LocalDriveType>;
  /** Handle identity+real canonical path and attributes without silently
   * traversing an unverified reparse point. Called for each path component. */
  inspect(path: string, signal: AbortSignal): Promise<LocalPathObservation | null>;
  /** Hash the complete file by bounded streaming from the same verified
   * handle, audit identity/size/mtime before and after hashing, return null if
   * any change or uncertain classification. Never read arbitrary other files. */
  hashExecutable(path: string, maxBytes: number, signal: AbortSignal): Promise<ExecutableObservation | null>;
}

export type QuickLaunchFingerprint =
  | { readonly kind: 'EXECUTABLE'; readonly identity: LocalFileIdentity; readonly sizeBytes: number; readonly modifiedAtMs: number; readonly sha256: string }
  | { readonly kind: 'DIRECTORY'; readonly identity: LocalFileIdentity }
  | { readonly kind: 'HTTPS'; readonly canonicalUrl: string };
export type ApprovedQuickTarget =
  | { readonly kind: 'WIN32_EXE'; readonly locator: string; readonly fingerprint: Extract<QuickLaunchFingerprint, { kind: 'EXECUTABLE' }> }
  | { readonly kind: 'FOLDER'; readonly locator: string; readonly fingerprint: Extract<QuickLaunchFingerprint, { kind: 'DIRECTORY' }> }
  | { readonly kind: 'HTTPS'; readonly locator: string; readonly fingerprint: Extract<QuickLaunchFingerprint, { kind: 'HTTPS' }> };
export type SavedQuickAction = ApprovedQuickTarget & {
  readonly id: string; readonly label: string; readonly revision: number; readonly approvedAt: number; readonly enabled: boolean;
};
export interface QuickTargetPreview { readonly kind: QuickLaunchKind; readonly locator: string; readonly suggestedLabel: string }

export interface QuickLaunchDialogPort {
  /** Separate native file/directory selection (or trusted manual HTTPS input).
   * Never supply an untrusted renderer/AI path as the picker result. */
  selectTarget(kind: QuickLaunchKind, sender: QuickLaunchSender): Promise<string | null>;
  confirmAdd(preview: QuickTargetPreview, sender: QuickLaunchSender): Promise<boolean>;
  /** Consume a real, Main-verified one-shot manual click on an existing saved
   * action. If integration cannot establish that gesture, require native user
   * confirmation instead. This must NOT read a renderer 'confirmed' boolean. */
  consumeSavedUserClick(actionId: string, revision: number, sender: QuickLaunchSender): boolean | Promise<boolean>;
}
export interface QuickLaunchAuthorityPort {
  /** Current top-frame Main binding. Never treat an IPC sender DTO as trusted. */
  senderIsCurrent(sender: QuickLaunchSender): boolean | Promise<boolean>;
  workspaceRevision(signal: AbortSignal): Promise<number | null>;
  loadSavedAction(actionId: string, signal: AbortSignal): Promise<SavedQuickAction | null>;
}
export type AdapterLaunchOutcome = 'accepted' | 'failed' | 'unknown';
export interface QuickLaunchAdapterPort {
  /** Future Win32 implementation: explicit executable path, shell:false,
   * empty argv, no user-supplied cwd/environment, no elevation. */
  launchExecutable(absolutePath: string): Promise<AdapterLaunchOutcome>;
  openFolder(absolutePath: string): Promise<AdapterLaunchOutcome>;
  /** Only canonical user-approved HTTPS; no other protocol. No fetch here. */
  openHttps(canonicalUrl: string): Promise<AdapterLaunchOutcome>;
}
export interface QuickLaunchPorts {
  readonly fs: QuickLaunchFsPort;
  readonly dialog: QuickLaunchDialogPort;
  readonly authority: QuickLaunchAuthorityPort;
  readonly launcher: QuickLaunchAdapterPort;
  readonly now: () => number;
  /** Actual host should return 32 cryptographically random bytes as 64 hex. */
  readonly tokenEntropy: () => string;
}

export type QuickLaunchFailureCode = 'INVALID_REQUEST' | 'FORBIDDEN' | 'CANCELLED' | 'BUSY' | 'SERVICE_UNAVAILABLE'
  | 'REVISION_CONFLICT' | 'INVALID_TARGET' | 'UNSAFE_TARGET' | 'TARGET_CHANGED' | 'APPROVAL_INVALID' | 'APPROVAL_EXPIRED' | 'TIMEOUT';
export type QuickLaunchFailure = { readonly ok: false; readonly code: QuickLaunchFailureCode };
const fail = (code: QuickLaunchFailureCode): QuickLaunchFailure => ({ ok: false, code });
type TargetValidation = { readonly ok: true; readonly target: ApprovedQuickTarget } | QuickLaunchFailure;
export type QuickAddApproval = { readonly ok: true; readonly token: string; readonly expiresAt: number; readonly preview: QuickTargetPreview } | QuickLaunchFailure;
export type QuickAddResult = { readonly ok: true; readonly target: ApprovedQuickTarget; readonly expectedRevision: number } | QuickLaunchFailure;
export type QuickRunApproval = { readonly ok: true; readonly token: string; readonly expiresAt: number } | QuickLaunchFailure;
export type QuickRunResult = { readonly ok: true; readonly outcome: AdapterLaunchOutcome } | QuickLaunchFailure;

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const kindAllowed = (kind: unknown): kind is QuickLaunchKind => kind === 'WIN32_EXE' || kind === 'FOLDER' || kind === 'HTTPS';

const reservedName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|(?:COM|LPT)[0-9¹²³])$/iu;
function namePartAllowed(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && value.trim() === value
    && !value.endsWith('.') && !/[<>:"/\\|?*~\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value)
    && !reservedName.test(value.split('.')[0] ?? '');
}

/** Accept a narrow unambiguous native Win32 path spelling. No path-resolution
 * shortcuts (dot/dotdot, alternate separators, UNC/device namespace, ADS or
 * short-name aliases), or automatic NFKC/case folding of file components. */
export function normalizeLocalWin32Path(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > quickLaunchLimits.maxPathUnits) return null;
  const match = /^([A-Za-z]):\\(.*)$/su.exec(input);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const root = `${match[1].toUpperCase()}:\\`;
  if (match[2] === '') return root;
  const components = match[2].split('\\');
  if (components.length > quickLaunchLimits.maxPathComponents || !components.every(namePartAllowed)) return null;
  return root + components.join('\\');
}

const deniedExecutableNames = new Set([
  'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'runas', 'schtasks', 'wmic', 'wsl',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'python', 'pythonw', 'py', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby',
  'php', 'lua', 'java', 'javaw', 'dotnet', 'csi', 'csc', 'msbuild', 'installutil', 'conhost', 'wt', 'windowsterminal',
  'reg', 'regedit', 'certutil', 'bitsadmin', 'curl', 'ftp', 'sc', 'services', 'taskkill', 'explorer', 'mmc', 'control', 'diskpart',
]);
function exeNameAllowed(name: string): boolean {
  if (!namePartAllowed(name) || !/\.exe$/iu.test(name)) return false;
  const stem = name.slice(0, -4).toLowerCase();
  return stem.length > 0 && !deniedExecutableNames.has(stem)
    && !/^(?:python|ruby|perl|php|lua|node|java|pwsh)(?:\d+(?:\.\d+)*)?w?$/u.test(stem);
}

/** Canonical ASCII-host HTTPS only. No userinfo, local/file/custom protocol,
 * ambiguous authority, invalid percent escapes or credential-looking query
 * fields. This is not a guarantee that a selected website is safe. */
export function normalizeHttpsTarget(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > quickLaunchLimits.maxUrlUnits
    || /[\s\\\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value) || /%(?![\da-f]{2})/iu.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(value)) return null;
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::([1-9]\d{0,4}))?(?:[/?#]|$)/iu.exec(value);
  if (!match || !match[1] || (match[2] !== undefined && Number(match[2]) > 65535)) return null;
  const rawHost = match[1].toLowerCase();
  const labels = rawHost.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(label))) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname !== rawHost) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|session|signature|code)/iu.test(key)) return null;
    }
    // Fragments may carry authentication responses. V1 accepts plain anchors
    // but declines key/value-style fragments rather than storing secrets.
    if (url.hash && /[=&]/u.test(decodeURIComponent(url.hash))) return null;
    return url.href.length <= quickLaunchLimits.maxUrlUnits ? url.href : null;
  } catch { return null; }
}

function identity(value: unknown): value is LocalFileIdentity {
  return record(value) && exactKeys(value, ['volumeSerial', 'fileId'])
    && typeof value.volumeSerial === 'string' && /^[0-9a-f]{16}$/u.test(value.volumeSerial) && !/^0+$/u.test(value.volumeSerial)
    && typeof value.fileId === 'string' && /^[0-9a-f]{32}$/u.test(value.fileId) && !/^0+$/u.test(value.fileId);
}
const sameId = (a: LocalFileIdentity, b: LocalFileIdentity): boolean => a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
function validObservation(value: unknown, canonicalPath: string): value is LocalPathObservation {
  return record(value) && value.canonicalPath === canonicalPath && value.reparsePoint === false && identity(value.identity)
    && uint(value.sizeBytes) && uint(value.modifiedAtMs)
    && (value.kind === 'FILE' || value.kind === 'DIRECTORY');
}

type BoundedResult<T> = { readonly state: 'OK'; readonly value: T } | { readonly state: 'FAILED' | 'TIMEOUT' };
function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T> | T): Promise<BoundedResult<T>> {
  const abort = new AbortController();
  return new Promise(resolve => {
    let completed = false;
    const finish = (result: BoundedResult<T>) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { abort.abort(); finish({ state: 'TIMEOUT' }); }, ms);
    void Promise.resolve().then(() => work(abort.signal)).then(value => finish({ state: 'OK', value }), () => finish({ state: 'FAILED' }));
  });
}

async function inspectChain(fs: QuickLaunchFsPort, path: string, endKind: 'FILE' | 'DIRECTORY', signal: AbortSignal): Promise<LocalPathObservation | null> {
  const root = path.slice(0, 3);
  if (signal.aborted || await fs.driveType(root, signal) !== 'FIXED' || signal.aborted) return null;
  const segments = path.length === 3 ? [] : path.slice(3).split('\\');
  let current = root, volumeSerial: string | undefined, last: LocalPathObservation | null = null;
  for (let index = 0; index <= segments.length; index++) {
    if (signal.aborted) return null;
    if (index !== 0) current += (index === 1 ? '' : '\\') + segments[index - 1];
    const observed = await fs.inspect(current, signal);
    if (signal.aborted || !validObservation(observed, current) || observed.kind !== (index === segments.length ? endKind : 'DIRECTORY')) return null;
    if (volumeSerial !== undefined && volumeSerial !== observed.identity.volumeSerial) return null;
    volumeSerial = observed.identity.volumeSerial;
    last = { ...observed, identity: { ...observed.identity } };
  }
  return last;
}

async function validateTarget(fs: QuickLaunchFsPort, kind: QuickLaunchKind, locator: unknown): Promise<TargetValidation> {
  if (kind === 'HTTPS') {
    const canonicalUrl = normalizeHttpsTarget(locator);
    return canonicalUrl === null ? fail('INVALID_TARGET') : { ok: true, target: { kind, locator: canonicalUrl, fingerprint: { kind: 'HTTPS', canonicalUrl } } };
  }
  const path = normalizeLocalWin32Path(locator);
  if (path === null || (kind === 'WIN32_EXE' && !exeNameAllowed(path.split('\\').at(-1) ?? ''))) return fail('INVALID_TARGET');
  const checked = await bounded(quickLaunchLimits.inspectionTimeoutMs, async (signal): Promise<TargetValidation> => {
    const before = await inspectChain(fs, path, kind === 'WIN32_EXE' ? 'FILE' : 'DIRECTORY', signal);
    if (before === null || signal.aborted) return fail('UNSAFE_TARGET');
    if (kind === 'FOLDER') return { ok: true, target: { kind, locator: path, fingerprint: { kind: 'DIRECTORY', identity: { ...before.identity } } } };
    if (before.sizeBytes < 1 || before.sizeBytes > quickLaunchLimits.maxExecutableBytes) return fail('UNSAFE_TARGET');
    const hashed = await fs.hashExecutable(path, quickLaunchLimits.maxExecutableBytes, signal);
    if (signal.aborted || !validObservation(hashed, path) || !hashed || hashed.kind !== 'FILE'
      || !sameId(before.identity, hashed.identity) || hashed.sizeBytes !== before.sizeBytes || hashed.modifiedAtMs !== before.modifiedAtMs
      || !sha(hashed.sha256) || hashed.format !== 'PE_EXE' || hashed.classification !== 'USER_APPLICATION'
      || typeof hashed.originalFilename !== 'string' || !exeNameAllowed(hashed.originalFilename)) return fail('UNSAFE_TARGET');
    // Copy before another port call so a mutable observation cannot change
    // our comparison. Recheck each path component after hashing as well.
    const fingerprint = { kind: 'EXECUTABLE' as const, identity: { ...hashed.identity }, sizeBytes: hashed.sizeBytes,
      modifiedAtMs: hashed.modifiedAtMs, sha256: hashed.sha256 };
    const after = await inspectChain(fs, path, 'FILE', signal);
    if (after === null || signal.aborted || !sameId(fingerprint.identity, after.identity)
      || fingerprint.sizeBytes !== after.sizeBytes || fingerprint.modifiedAtMs !== after.modifiedAtMs) return fail('TARGET_CHANGED');
    return { ok: true, target: { kind, locator: path, fingerprint } };
  });
  return checked.state === 'OK' ? checked.value : fail(checked.state === 'TIMEOUT' ? 'TIMEOUT' : 'UNSAFE_TARGET');
}

function validTarget(value: unknown): value is ApprovedQuickTarget {
  if (!record(value) || !kindAllowed(value.kind) || typeof value.locator !== 'string' || !record(value.fingerprint)) return false;
  const f = value.fingerprint;
  if (value.kind === 'HTTPS') return normalizeHttpsTarget(value.locator) === value.locator && exactKeys(f, ['kind', 'canonicalUrl'])
    && f.kind === 'HTTPS' && f.canonicalUrl === value.locator;
  if (normalizeLocalWin32Path(value.locator) !== value.locator || !identity(f.identity)) return false;
  if (value.kind === 'FOLDER') return exactKeys(f, ['kind', 'identity']) && f.kind === 'DIRECTORY';
  return exeNameAllowed(value.locator.split('\\').at(-1) ?? '') && exactKeys(f, ['kind', 'identity', 'sizeBytes', 'modifiedAtMs', 'sha256'])
    && f.kind === 'EXECUTABLE' && uint(f.sizeBytes) && f.sizeBytes > 0 && f.sizeBytes <= quickLaunchLimits.maxExecutableBytes
    && uint(f.modifiedAtMs) && sha(f.sha256);
}

function copyTarget(target: ApprovedQuickTarget): ApprovedQuickTarget {
  if (target.kind === 'HTTPS') return { kind: target.kind, locator: target.locator, fingerprint: { ...target.fingerprint } };
  if (target.kind === 'FOLDER') return { kind: target.kind, locator: target.locator, fingerprint: { ...target.fingerprint, identity: { ...target.fingerprint.identity } } };
  return { kind: target.kind, locator: target.locator, fingerprint: { ...target.fingerprint, identity: { ...target.fingerprint.identity } } };
}
function sameTarget(a: ApprovedQuickTarget, b: ApprovedQuickTarget): boolean {
  if (a.kind !== b.kind || a.locator !== b.locator) return false;
  if (a.kind === 'HTTPS' && b.kind === 'HTTPS') return a.fingerprint.canonicalUrl === b.fingerprint.canonicalUrl;
  if (a.kind === 'FOLDER' && b.kind === 'FOLDER') return sameId(a.fingerprint.identity, b.fingerprint.identity);
  return a.kind === 'WIN32_EXE' && b.kind === 'WIN32_EXE' && sameId(a.fingerprint.identity, b.fingerprint.identity)
    && a.fingerprint.sizeBytes === b.fingerprint.sizeBytes && a.fingerprint.modifiedAtMs === b.fingerprint.modifiedAtMs && a.fingerprint.sha256 === b.fingerprint.sha256;
}

function validSender(value: unknown): value is QuickLaunchSender {
  return record(value) && exactKeys(value, ['role', 'senderId', 'documentId']) && value.role === 'control-center'
    && uint(value.senderId) && value.senderId > 0 && validId(value.documentId);
}
function validContext(value: unknown): value is QuickLaunchContext {
  return record(value) && exactKeys(value, ['sender', 'expectedRevision']) && validSender(value.sender) && uint(value.expectedRevision);
}
function copyContext(value: QuickLaunchContext): QuickLaunchContext {
  return Object.freeze({ sender: Object.freeze({ ...value.sender }), expectedRevision: value.expectedRevision });
}
function sameSender(a: QuickLaunchSender, b: QuickLaunchSender): boolean {
  return a.role === b.role && a.senderId === b.senderId && a.documentId === b.documentId;
}

interface ApprovalBase {
  readonly sender: QuickLaunchSender; readonly expectedRevision: number; readonly target: ApprovedQuickTarget;
  readonly issuedAt: number; readonly expiresAt: number;
  readonly epoch: number;
  cancelled: boolean;
}
type Approval = ApprovalBase & ({ readonly purpose: 'SAVE' } | { readonly purpose: 'RUN'; readonly actionId: string; readonly approvedAt: number });
type TakeResult = { readonly ok: true; readonly approval: Approval } | QuickLaunchFailure;

/** Retains only ephemeral, one-use Main approvals, never launched processes or
 * persisted data. Final handle/path checks reduce substitution accidents, but
 * Win32 check+launch is not atomic; same-user malicious software is outside
 * this launcher threat model. A fixed adapter only reports accepted/failed/
 * unknown, never that a program or external page is actually safe/ready. */
export class QuickLaunchPolicy {
  private readonly approvals = new Map<string, Approval>();
  private readonly consuming = new Set<Approval>();
  private tokenSequence = 0;
  private epoch = 0;
  private adding = false;

  constructor(private readonly ports: QuickLaunchPorts) {}

  private async authorize(context: QuickLaunchContext): Promise<QuickLaunchFailure | null> {
    if (!validContext(context)) return fail('INVALID_REQUEST');
    const checked = await bounded(quickLaunchLimits.authorityTimeoutMs, () => this.ports.authority.senderIsCurrent(context.sender));
    return checked.state !== 'OK' ? fail('SERVICE_UNAVAILABLE') : checked.value === true ? null : fail('FORBIDDEN');
  }

  private async checkWorkspaceRevision(expected: number): Promise<QuickLaunchFailure | null> {
    const current = await bounded(quickLaunchLimits.authorityTimeoutMs, signal => this.ports.authority.workspaceRevision(signal));
    if (current.state !== 'OK' || !uint(current.value)) return fail('SERVICE_UNAVAILABLE');
    return current.value !== expected ? fail('REVISION_CONFLICT') : null;
  }

  private async loadAction(actionId: string, expected: number): Promise<{ ok: true; action: SavedQuickAction } | QuickLaunchFailure> {
    const result = await bounded(quickLaunchLimits.authorityTimeoutMs, signal => this.ports.authority.loadSavedAction(actionId, signal));
    if (result.state !== 'OK') return fail('SERVICE_UNAVAILABLE');
    const action = result.value;
    const now = this.ports.now();
    if (!record(action) || !exactKeys(action, ['kind', 'locator', 'fingerprint', 'id', 'label', 'revision', 'approvedAt', 'enabled'])
      || !validTarget(action) || !validId(action.id) || action.id !== actionId || !uint(now) || !uint(action.approvedAt)
      || action.approvedAt > now || typeof action.label !== 'string' || action.label.trim().length === 0 || action.label.length > 128
      || !uint(action.revision) || typeof action.enabled !== 'boolean') return fail('UNSAFE_TARGET');
    if (action.enabled !== true) return fail('FORBIDDEN');
    if (action.revision !== expected) return fail('REVISION_CONFLICT');
    return { ok: true, action: { ...copyTarget(action), id: action.id, label: action.label, revision: action.revision, approvedAt: action.approvedAt, enabled: true } };
  }

  private current(approval: Approval): boolean {
    try {
      const now = this.ports.now();
      return !approval.cancelled && approval.epoch === this.epoch && uint(now) && now >= approval.issuedAt && now < approval.expiresAt;
    } catch { return false; }
  }

  private issue(base: Omit<ApprovalBase, 'issuedAt' | 'expiresAt' | 'epoch' | 'cancelled'>, purpose: { purpose: 'SAVE' } | { purpose: 'RUN'; actionId: string; approvedAt: number }): QuickRunApproval {
    const now = this.ports.now();
    if (!uint(now) || now > Number.MAX_SAFE_INTEGER - quickLaunchLimits.approvalTtlMs || this.tokenSequence === Number.MAX_SAFE_INTEGER) return fail('SERVICE_UNAVAILABLE');
    for (const [token, item] of this.approvals) if (!this.current(item)) this.approvals.delete(token);
    if (this.approvals.size + this.consuming.size >= quickLaunchLimits.pendingApprovals) return fail('BUSY');
    let entropy: unknown;
    try { entropy = this.ports.tokenEntropy(); } catch { return fail('SERVICE_UNAVAILABLE'); }
    if (!sha(entropy) || /^0+$/u.test(entropy)) return fail('SERVICE_UNAVAILABLE');
    const token = `quick-${++this.tokenSequence}-${entropy}`, expiresAt = now + quickLaunchLimits.approvalTtlMs;
    this.approvals.set(token, { ...base, sender: Object.freeze({ ...base.sender }), target: copyTarget(base.target), ...purpose, issuedAt: now, expiresAt, epoch: this.epoch, cancelled: false });
    return { ok: true, token, expiresAt };
  }

  private take(token: unknown, purpose: Approval['purpose'], context: QuickLaunchContext): TakeResult {
    if (!validContext(context) || typeof token !== 'string' || !/^quick-[1-9]\d{0,15}-[a-f0-9]{64}$/u.test(token)) return fail('APPROVAL_INVALID');
    const approval = this.approvals.get(token);
    if (approval === undefined || approval.purpose !== purpose || !sameSender(approval.sender, context.sender)) return fail('APPROVAL_INVALID');
    // A correct sender consumes its token synchronously, before any await;
    // stale revision/failure/timeout cannot retry or resurrect the approval.
    this.approvals.delete(token);
    if (!this.current(approval)) return fail('APPROVAL_EXPIRED');
    if (approval.expectedRevision !== context.expectedRevision) return fail('REVISION_CONFLICT');
    this.consuming.add(approval);
    return { ok: true, approval };
  }

  /** The caller can request only a kind. The locator comes exclusively from a
   * trusted native user selection and confirmation displaying the actual path. */
  async prepareAdd(kind: QuickLaunchKind, context: QuickLaunchContext): Promise<QuickAddApproval> {
    if (!kindAllowed(kind) || !validContext(context)) return fail('INVALID_REQUEST');
    context = copyContext(context);
    const epoch = this.epoch;
    const authorized = await this.authorize(context);
    if (authorized) return authorized;
    if (this.epoch !== epoch) return fail('FORBIDDEN');
    if (this.adding) return fail('BUSY');
    this.adding = true;
    try {
      const rev = await this.checkWorkspaceRevision(context.expectedRevision);
      if (rev) return rev;
      const selected = await this.ports.dialog.selectTarget(kind, context.sender);
      if (selected === null) return fail('CANCELLED');
      const validated = await validateTarget(this.ports.fs, kind, selected);
      if (!validated.ok) return validated;
      const { target } = validated;
      const suggestedLabel = target.kind === 'HTTPS' ? new URL(target.locator).hostname : target.locator.split('\\').filter(Boolean).at(-1) ?? target.locator;
      const preview = { kind: target.kind, locator: target.locator, suggestedLabel: suggestedLabel.slice(0, 128) };
      if (await this.ports.dialog.confirmAdd({ ...preview }, context.sender) !== true) return fail('CANCELLED');
      const stillAuthorized = await this.authorize(context);
      if (stillAuthorized) return stillAuthorized;
      const stillRevision = await this.checkWorkspaceRevision(context.expectedRevision);
      if (stillRevision) return stillRevision;
      if (this.epoch !== epoch) return fail('FORBIDDEN');
      const issued = this.issue({ sender: context.sender, expectedRevision: context.expectedRevision, target }, { purpose: 'SAVE' });
      return issued.ok ? { ...issued, preview } : issued;
    } catch { return fail('SERVICE_UNAVAILABLE'); }
    finally { this.adding = false; }
  }

  /** Consumes add-only authorization to produce a descriptor for the sole
   * app-service writer. This method cannot launch and performs no writes. */
  async consumeAdd(token: string, context: QuickLaunchContext): Promise<QuickAddResult> {
    const taken = this.take(token, 'SAVE', context);
    if (!taken.ok) return taken;
    const { approval } = taken;
    context = copyContext({ sender: approval.sender, expectedRevision: approval.expectedRevision });
    try {
      const sender = await this.authorize(context);
      if (sender) return sender;
      const rev = await this.checkWorkspaceRevision(approval.expectedRevision);
      if (rev) return rev;
      const fresh = await validateTarget(this.ports.fs, approval.target.kind, approval.target.locator);
      if (!fresh.ok) return fresh;
      if (!sameTarget(approval.target, fresh.target)) return fail('TARGET_CHANGED');
      const finalSender = await this.authorize(context);
      if (finalSender) return finalSender;
      const finalRevision = await this.checkWorkspaceRevision(approval.expectedRevision);
      if (finalRevision) return finalRevision;
      if (!this.current(approval)) return fail('APPROVAL_EXPIRED');
      return { ok: true, target: copyTarget(fresh.target), expectedRevision: approval.expectedRevision };
    } catch { return fail('SERVICE_UNAVAILABLE'); }
    finally { this.consuming.delete(approval); }
  }

  /** Manual saved action only; no trigger/source argument a renderer or AI can
   * claim. The trusted user-click capability is consumed before any target lookup. */
  async prepareSavedRun(actionId: string, context: QuickLaunchContext): Promise<QuickRunApproval> {
    if (!validId(actionId) || !validContext(context)) return fail('INVALID_REQUEST');
    context = copyContext(context);
    const epoch = this.epoch;
    try {
      const denied = await this.authorize(context);
      if (denied) return denied;
      if (await this.ports.dialog.consumeSavedUserClick(actionId, context.expectedRevision, context.sender) !== true) return fail('FORBIDDEN');
      const loaded = await this.loadAction(actionId, context.expectedRevision);
      if (!loaded.ok) return loaded;
      const finalSender = await this.authorize(context);
      if (finalSender) return finalSender;
      if (this.epoch !== epoch) return fail('FORBIDDEN');
      return this.issue({ sender: context.sender, expectedRevision: context.expectedRevision, target: loaded.action },
        { purpose: 'RUN', actionId, approvedAt: loaded.action.approvedAt });
    } catch { return fail('SERVICE_UNAVAILABLE'); }
  }

  /** With a fresh authority lookup and target fingerprint revalidation, pass
   * precisely one locator to the fixed adapter. No arbitrary shell or args. */
  async executeSavedRun(token: string, context: QuickLaunchContext): Promise<QuickRunResult> {
    const taken = this.take(token, 'RUN', context);
    if (!taken.ok) return taken;
    const { approval } = taken;
    if (approval.purpose !== 'RUN') { this.consuming.delete(approval); return fail('APPROVAL_INVALID'); }
    context = copyContext({ sender: approval.sender, expectedRevision: approval.expectedRevision });
    try {
      const denied = await this.authorize(context);
      if (denied) return denied;
      const loaded = await this.loadAction(approval.actionId, approval.expectedRevision);
      if (!loaded.ok) return loaded;
      if (loaded.action.approvedAt !== approval.approvedAt || !sameTarget(approval.target, loaded.action)) return fail('TARGET_CHANGED');
      const fresh = await validateTarget(this.ports.fs, loaded.action.kind, loaded.action.locator);
      if (!fresh.ok) return fresh;
      if (!sameTarget(approval.target, fresh.target)) return fail('TARGET_CHANGED');
      const finalAction = await this.loadAction(approval.actionId, approval.expectedRevision);
      if (!finalAction.ok) return finalAction;
      if (finalAction.action.approvedAt !== approval.approvedAt || !sameTarget(fresh.target, finalAction.action)) return fail('TARGET_CHANGED');
      const finalSender = await this.authorize(context);
      if (finalSender) return finalSender;
      if (!this.current(approval)) return fail('APPROVAL_EXPIRED');
      const target = fresh.target;
      // Never automatically retry or terminate the user's program on timeout;
      // this race is for reporting ambiguous acceptance only.
      const result = await bounded<AdapterLaunchOutcome | 'cancelled'>(quickLaunchLimits.launchTimeoutMs, () => {
        // A queued document revocation/shutdown may have run between the
        // previous await and this adapter invocation's microtask.
        if (!this.current(approval)) return 'cancelled';
        return target.kind === 'WIN32_EXE' ? this.ports.launcher.launchExecutable(target.locator)
          : target.kind === 'FOLDER' ? this.ports.launcher.openFolder(target.locator) : this.ports.launcher.openHttps(target.locator);
      });
      if (result.state !== 'OK') return { ok: true, outcome: result.state === 'FAILED' ? 'failed' : 'unknown' };
      if (result.value === 'cancelled') return fail('APPROVAL_EXPIRED');
      if (result.value !== 'accepted' && result.value !== 'failed' && result.value !== 'unknown') return { ok: true, outcome: 'unknown' };
      return { ok: true, outcome: result.value };
    } catch { return fail('SERVICE_UNAVAILABLE'); }
    finally { this.consuming.delete(approval); }
  }

  /** One-click convenience for a saved action; token stays in Main. */
  async launchSavedAction(actionId: string, context: QuickLaunchContext): Promise<QuickRunResult> {
    if (!validContext(context)) return fail('INVALID_REQUEST');
    context = copyContext(context);
    const prepared = await this.prepareSavedRun(actionId, context);
    return prepared.ok ? this.executeSavedRun(prepared.token, context) : prepared;
  }

  /** Host calls on document destruction/reload, or service shutdown. */
  revokeSender(senderId: number, documentId?: string): void {
    for (const [token, approval] of this.approvals) if (approval.sender.senderId === senderId
      && (documentId === undefined || approval.sender.documentId === documentId)) this.approvals.delete(token);
    for (const approval of this.consuming) if (approval.sender.senderId === senderId
      && (documentId === undefined || approval.sender.documentId === documentId)) approval.cancelled = true;
  }
  clear(): void { this.approvals.clear(); this.epoch += 1; }
}
