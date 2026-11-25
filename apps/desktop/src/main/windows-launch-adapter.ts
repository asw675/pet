import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, normalize, win32 } from 'node:path';
import type { BrowserWindow, OpenDialogOptions, MessageBoxOptions } from 'electron';
import { z } from 'zod';
import { launchAuthorityActionSchema } from '@pet-desktop/contracts/workspace';
import { normalizeHttpsTarget, normalizeLocalWin32Path, quickLaunchLimits } from './quick-launch-policy';
import type {
  AdapterLaunchOutcome, ExecutableObservation, LocalDriveType, LocalPathObservation, QuickLaunchAdapterPort,
  QuickLaunchDialogPort, QuickLaunchFsPort, QuickLaunchKind, QuickLaunchSender, QuickTargetPreview, SavedQuickAction,
} from './quick-launch-policy';

/** Trusted packaged helper only. A Windows release must embed the actual
 * built binary SHA-256 in its Main code/config; never read a mutable adjacent
 * checksum or try a PATH, shell, PowerShell or script fallback. */
export const windowsLaunchAdapterLimits = Object.freeze({
  helperRelativePath: Object.freeze(['native', 'launch-inspect', 'launch-inspect.exe'] as const),
  helperBytes: 16 * 1024 * 1024, helperReplyBytes: 16 * 1024, helperRequestBytes: 4096,
  helperTimeoutMs: 8000,
});

interface NativeOpenResult { readonly canceled: boolean; readonly filePaths: readonly string[] }
interface NativeMessageResult { readonly response: number }
export interface WindowsLaunchNativeDialog {
  showOpenDialog(parent: BrowserWindow, options: OpenDialogOptions): Promise<NativeOpenResult>;
  showMessageBox(parent: BrowserWindow, options: MessageBoxOptions): Promise<NativeMessageResult>;
}
export interface WindowsLaunchNativeShell {
  openPath(absolutePath: string): Promise<string>;
  openExternal(canonicalUrl: string): Promise<void>;
}
export interface WindowsLaunchNativeHost {
  /** Trusted Main owns the sender/document binding and native parent. */
  senderIsCurrent(sender: QuickLaunchSender): boolean | Promise<boolean>;
  parentFor(sender: QuickLaunchSender): BrowserWindow | null;
  loadSavedAction(actionId: string, signal: AbortSignal): Promise<SavedQuickAction | null>;
  /** Electron's native open dialog has no text-input mode. This optional
   * Main-owned one-shot user input must never come from an AI suggestion.
   * The subsequent native confirmation displays the exact canonical HTTPS. */
  takeManualHttpsInput?(sender: QuickLaunchSender): Promise<string | null>;
}
/** Injection seam for tests; Main's actual production default is node spawn. */
export type WindowsLaunchSpawnPort = (absolutePath: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export interface WindowsLaunchAdaptersOptions {
  readonly resourcesDirectory: string;
  readonly expectedInspectorSha256: string | null;
  readonly nativeDialog: WindowsLaunchNativeDialog;
  readonly nativeShell: WindowsLaunchNativeShell;
  readonly host: WindowsLaunchNativeHost;
  readonly spawnProcess?: WindowsLaunchSpawnPort;
  readonly platform?: NodeJS.Platform;
}
export interface WindowsLaunchAdapters {
  readonly fs: QuickLaunchFsPort;
  readonly dialog: QuickLaunchDialogPort;
  readonly launcher: QuickLaunchAdapterPort;
  /** A checked missing/unbuilt binary is unavailable, not a pretend success. */
  helperAvailable(signal?: AbortSignal): Promise<boolean>;
}

const defaultSpawn: WindowsLaunchSpawnPort = (path, args, options) => spawn(path, [...args], options);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const localIdentity = z.strictObject({ volumeSerial: z.string().regex(/^[a-f0-9]{16}$/u).refine(value => !/^0+$/u.test(value)),
  fileId: z.string().regex(/^[a-f0-9]{32}$/u).refine(value => !/^0+$/u.test(value)) });
const localFields = { canonicalPath: z.string().min(1).max(quickLaunchLimits.maxPathUnits), identity: localIdentity,
  kind: z.enum(['FILE', 'DIRECTORY', 'OTHER']), reparsePoint: z.boolean(), sizeBytes: uint, modifiedAtMs: uint };
const driveSchema = z.enum(['FIXED', 'REMOTE', 'REMOVABLE', 'CDROM', 'RAMDISK', 'UNKNOWN']);
const helperReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ version: z.literal(1), operation: z.literal('DRIVE'), result: driveSchema }),
  z.strictObject({ version: z.literal(1), operation: z.literal('INSPECT'), result: z.strictObject(localFields) }),
  z.strictObject({ version: z.literal(1), operation: z.literal('HASH_EXE'), result: z.strictObject({ ...localFields, kind: z.literal('FILE'),
    sha256: z.string().regex(digestPattern), format: z.enum(['PE_EXE', 'UNKNOWN']), classification: z.enum(['USER_APPLICATION', 'PROHIBITED', 'UNKNOWN']),
    originalFilename: z.string().min(1).max(255).nullable() }) }),
]);
type HelperReply = z.infer<typeof helperReplySchema>;
type HelperOperation = HelperReply['operation'];

function exactLocal(path: unknown): path is string { return typeof path === 'string' && normalizeLocalWin32Path(path) === path; }
const deniedExecutables = new Set(['cmd','powershell','pwsh','wscript','cscript','mshta','rundll32','regsvr32','msiexec','runas','schtasks','wmic','wsl',
  'bash','sh','zsh','dash','ksh','fish','busybox','python','pythonw','py','node','nodejs','deno','bun','perl','ruby','php','lua','java','javaw',
  'dotnet','csi','csc','msbuild','installutil','conhost','wt','windowsterminal','reg','regedit','certutil','bitsadmin','curl','ftp','sc','services',
  'taskkill','explorer','mmc','control','diskpart']);
function allowedExe(path: unknown): path is string {
  if (!exactLocal(path)) return false;
  const file = path.split('\\').at(-1) ?? '';
  if (!/\.exe$/iu.test(file)) return false;
  const name = file.slice(0, -4).toLowerCase();
  return name.length > 0 && !deniedExecutables.has(name) && !/^(?:python|ruby|perl|php|lua|node|java|pwsh)(?:\d+(?:\.\d+)*)?w?$/u.test(name);
}
function exactHttps(value: unknown): value is string { return typeof value === 'string' && normalizeHttpsTarget(value) === value; }
function sameHostPath(left: string, right: string): boolean {
  // Only canonicalize the drive letter, not case-sensitive directory/file
  // components. This also permits the real local test host's absolute paths.
  const drive = (p: string) => p.replace(/^[a-z]:\\/u, part => part.toUpperCase());
  return drive(left) === drive(right);
}
function exactFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Hash the fixed binary, not a user-selected target path. The helper itself
 * subsequently performs Windows handle/reparse/full-content checks for user
 * targets. Packaged installation paths are the trusted application boundary. */
async function verifiedHelper(options: WindowsLaunchAdaptersOptions, platform: NodeJS.Platform, signal: AbortSignal): Promise<string | null> {
  const expected = options.expectedInspectorSha256;
  const root = options.resourcesDirectory;
  if (platform !== 'win32' || signal.aborted || typeof expected !== 'string' || !digestPattern.test(expected) || /^0+$/u.test(expected)
    || !isAbsolute(root) || normalize(root) !== root) return null;
  try {
    if (process.platform === 'win32' && normalizeLocalWin32Path(root) === null) return null;
    let current = root;
    for (const part of ['', ...windowsLaunchAdapterLimits.helperRelativePath.slice(0, -1)]) {
      if (signal.aborted) return null;
      if (part !== '') current = join(current, part);
      const inspected = await lstat(current, { bigint: true });
      if (!inspected.isDirectory() || inspected.isSymbolicLink() || !sameHostPath(await realpath(current), current)) return null;
    }
    const helper = join(root, ...windowsLaunchAdapterLimits.helperRelativePath);
    const before = await lstat(helper, { bigint: true });
    if (signal.aborted || !before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(windowsLaunchAdapterLimits.helperBytes)
      || !sameHostPath(await realpath(helper), helper)) return null;
    const handle = await open(helper, 'r');
    try {
      const initial = await handle.stat({ bigint: true });
      if (!exactFile(initial, before)) return null;
      const hash = createHash('sha256'), block = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      const size = Number(initial.size);
      while (offset < size) {
        if (signal.aborted) return null;
        const { bytesRead } = await handle.read(block, 0, Math.min(block.length, size - offset), offset);
        if (bytesRead < 1) return null;
        hash.update(block.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const currentPath = await lstat(helper, { bigint: true });
      if (signal.aborted || !exactFile(initial, after) || !exactFile(initial, currentPath) || currentPath.isSymbolicLink()
        || !sameHostPath(await realpath(helper), helper) || hash.digest('hex') !== expected) return null;
      return helper;
    } finally { await handle.close(); }
  } catch { return null; }
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  if (systemRoot) { env.SystemRoot = systemRoot; env.WINDIR = systemRoot; }
  // No inherited PATH loader variables, credentials or proxy configuration.
  return env;
}
function launchEnvironment(): NodeJS.ProcessEnv {
  // Fixed normal Windows app variables only; no model API credentials or
  // caller-supplied environment/working directory. Absolute executable path
  // does not rely on PATH. Some apps needing other custom env may fail closed.
  const allowed = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PUBLIC'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const key = Object.keys(process.env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined && process.env[key] !== undefined) env[name] = process.env[key];
  }
  return env;
}

/** Closed stdin wire format, no target metadata parsed from a command line. */
function requestBytes(operation: HelperOperation, path: string, maxBytes: number): Uint8Array {
  return Buffer.from(`PET-DESKTOP-LAUNCH-INSPECT-V1\n${operation}\n${path}\n${maxBytes}\n`, 'utf8');
}

function nativeResponse(bytes: readonly Buffer[], operation: HelperOperation): HelperReply | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes));
    const result = helperReplySchema.safeParse(JSON.parse(text));
    return result.success && result.data.operation === operation ? result.data : null;
  } catch { return null; }
}

class Inspector {
  private busy = false;
  private readonly dispatchProofs = new Map<string, { kind: 'FILE' | 'DIRECTORY'; expires: number }>();
  constructor(private readonly options: WindowsLaunchAdaptersOptions, private readonly platform: NodeJS.Platform,
    private readonly spawnProcess: WindowsLaunchSpawnPort) {}

  async available(signal = new AbortController().signal): Promise<boolean> {
    return !this.busy && await verifiedHelper(this.options, this.platform, signal) !== null;
  }

  /** This is an adapter capability, not user authorization. QuickLaunchPolicy
   * independently verifies the saved authority, consent and exact current
   * fingerprint on every run. Consume synchronously so no helper rehash or
   * queue can defer OS dispatch beyond policy's final authorization check. */
  consumeDispatchProof(path: string, kind: 'FILE' | 'DIRECTORY'): boolean {
    const proof = this.dispatchProofs.get(path);
    this.dispatchProofs.delete(path);
    return proof !== undefined && proof.kind === kind && performance.now() < proof.expires;
  }
  attest(path: string, kind: 'FILE' | 'DIRECTORY'): void {
    const now = performance.now();
    for (const [key, value] of this.dispatchProofs) if (value.expires <= now) this.dispatchProofs.delete(key);
    if (this.dispatchProofs.size >= 128) {
      const oldest = this.dispatchProofs.keys().next().value;
      if (oldest !== undefined) this.dispatchProofs.delete(oldest);
    }
    this.dispatchProofs.set(path, { kind, expires: now + quickLaunchLimits.approvalTtlMs });
  }

  async inspect(operation: HelperOperation, path: string, maxBytes: number, signal: AbortSignal): Promise<HelperReply | null> {
    this.dispatchProofs.delete(path);
    if (this.busy || signal.aborted || !exactLocal(path)) return null;
    if (operation === 'DRIVE' && !/^[A-Z]:\\$/u.test(path)) return null;
    if (operation === 'HASH_EXE' ? !allowedExe(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > quickLaunchLimits.maxExecutableBytes
      : maxBytes !== 0) return null;
    const bytes = requestBytes(operation, path, maxBytes);
    if (bytes.byteLength > windowsLaunchAdapterLimits.helperRequestBytes) return null;
    const helper = await verifiedHelper(this.options, this.platform, signal);
    if (helper === null || signal.aborted || this.busy) return null;
    this.busy = true;
    return new Promise(resolve => {
      let child: ChildProcess;
      try { child = this.spawnProcess(helper, [], { shell: false, windowsHide: true, cwd: dirname(helper), env: helperEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { this.busy = false; resolve(null); return; }
      let settled = false, received = 0, stopped = false;
      const chunks: Buffer[] = [];
      const finish = (reply: HelperReply | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop); chunks.length = 0; resolve(reply);
      };
      const stop = () => {
        if (!stopped) { stopped = true; try { child.kill(); } catch { /* no exit claim */ } }
        finish(null);
      };
      const timer = setTimeout(stop, windowsLaunchAdapterLimits.helperTimeoutMs);
      // Do not start a second helper if termination is not confirmed.
      child.once('close', (code) => {
        this.busy = false;
        if (settled) return;
        finish(code === 0 && !signal.aborted && !stopped ? nativeResponse(chunks, operation) : null);
      });
      child.on('error', stop);
      if (child.stdout === null || child.stdin === null) { stop(); return; }
      child.stdin.on('error', stop);
      child.stdout.on('error', stop);
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > windowsLaunchAdapterLimits.helperReplyBytes - received) { stop(); return; }
        received += chunk.length; chunks.push(Buffer.from(chunk));
      });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) { stop(); return; }
      try { child.stdin.end(bytes); } catch { stop(); }
    });
  }
}

function makeFs(inspector: Inspector): QuickLaunchFsPort {
  return {
    async driveType(root, signal): Promise<LocalDriveType> {
      const reply = await inspector.inspect('DRIVE', root, 0, signal);
      return reply?.operation === 'DRIVE' ? reply.result : 'UNKNOWN';
    },
    async inspect(path, signal): Promise<LocalPathObservation | null> {
      const reply = await inspector.inspect('INSPECT', path, 0, signal);
      if (reply?.operation !== 'INSPECT' || reply.result.canonicalPath !== path) return null;
      if (reply.result.kind === 'DIRECTORY' && !reply.result.reparsePoint) inspector.attest(path, 'DIRECTORY');
      return reply.result;
    },
    async hashExecutable(path, maxBytes, signal): Promise<ExecutableObservation | null> {
      const reply = await inspector.inspect('HASH_EXE', path, maxBytes, signal);
      if (reply?.operation !== 'HASH_EXE' || reply.result.canonicalPath !== path || reply.result.sizeBytes > maxBytes) return null;
      const result = reply.result;
      if (!result.reparsePoint && result.sizeBytes > 0 && result.format === 'PE_EXE' && result.classification === 'USER_APPLICATION'
        && result.originalFilename !== null && !/[/\\]/u.test(result.originalFilename) && allowedExe('C:\\' + result.originalFilename)) inspector.attest(path, 'FILE');
      return result;
    },
  };
}

function makeLauncher(platform: NodeJS.Platform, shell: WindowsLaunchNativeShell, inspector: Inspector, spawnProcess: WindowsLaunchSpawnPort): QuickLaunchAdapterPort {
  return {
    async launchExecutable(path): Promise<AdapterLaunchOutcome> {
      if (platform !== 'win32' || !allowedExe(path) || !inspector.consumeDispatchProof(path, 'FILE')) return 'failed';
      return new Promise(resolve => {
        let child: ChildProcess;
        try {
          // Only QuickLaunchPolicy can supply its already-approved canonical
          // locator. Never use shell associations, arbitrary arguments,
          // command-line strings, alternate cwd, elevation or PATH lookup.
          child = spawnProcess(path, [], { shell: false, windowsHide: false, detached: true, stdio: 'ignore', cwd: win32.dirname(path), env: launchEnvironment() });
        } catch { resolve('failed'); return; }
        let settled = false;
        const finish = (outcome: AdapterLaunchOutcome) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { child.unref(); } catch { /* never terminate the user program */ }
          resolve(outcome);
        };
        const timer = setTimeout(() => finish('unknown'), quickLaunchLimits.launchTimeoutMs);
        child.once('spawn', () => finish('accepted'));
        child.on('error', () => finish('failed'));
      });
    },
    async openFolder(path): Promise<AdapterLaunchOutcome> {
      if (platform !== 'win32' || !exactLocal(path) || !inspector.consumeDispatchProof(path, 'DIRECTORY')) return 'failed';
      try { return await shell.openPath(path) === '' ? 'accepted' : 'failed'; } catch { return 'failed'; }
    },
    async openHttps(url): Promise<AdapterLaunchOutcome> {
      // A canonical user-approved HTTPS URL does not need a filesystem
      // inspector. No network fetch/probe/redirect handling here.
      if (platform !== 'win32' || !exactHttps(url)) return 'failed';
      try { await shell.openExternal(url); return 'accepted'; } catch { return 'failed'; }
    },
  };
}

function validSender(sender: QuickLaunchSender): boolean {
  return sender.role === 'control-center' && Number.isSafeInteger(sender.senderId) && sender.senderId > 0 && identifier.test(sender.documentId);
}
function validPreview(preview: QuickTargetPreview): boolean {
  return (preview.kind === 'WIN32_EXE' ? allowedExe(preview.locator) : preview.kind === 'FOLDER' ? exactLocal(preview.locator)
    : preview.kind === 'HTTPS' ? exactHttps(preview.locator) : false)
    && typeof preview.suggestedLabel === 'string' && preview.suggestedLabel.trim().length > 0 && preview.suggestedLabel.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(preview.suggestedLabel);
}

async function currentParent(host: WindowsLaunchNativeHost, sender: QuickLaunchSender): Promise<BrowserWindow | null> {
  if (!validSender(sender) || await host.senderIsCurrent(sender) !== true) return null;
  const parent = host.parentFor(sender);
  return parent !== null && !parent.isDestroyed() && parent.webContents.id === sender.senderId ? parent : null;
}

async function loadForConfirmation(host: WindowsLaunchNativeHost, actionId: string, revision: number): Promise<SavedQuickAction | null> {
  const abort = new AbortController();
  return new Promise(resolve => {
    let done = false;
    const finish = (action: SavedQuickAction | null) => { if (done) return; done = true; clearTimeout(timer); resolve(action); };
    const timer = setTimeout(() => { abort.abort(); finish(null); }, quickLaunchLimits.authorityTimeoutMs);
    void Promise.resolve().then(() => host.loadSavedAction(actionId, abort.signal)).then(raw => {
      const parsed = launchAuthorityActionSchema.safeParse(raw);
      finish(parsed.success && parsed.data.id === actionId && parsed.data.revision === revision && parsed.data.enabled ? parsed.data : null);
    }, () => finish(null)).catch(() => finish(null));
  });
}

function makeDialog(platform: NodeJS.Platform, native: WindowsLaunchNativeDialog, host: WindowsLaunchNativeHost): QuickLaunchDialogPort {
  async function stillSame(sender: QuickLaunchSender, parent: BrowserWindow): Promise<boolean> { return await currentParent(host, sender) === parent; }
  async function confirm(parent: BrowserWindow, sender: QuickLaunchSender, message: string, detail: string, verb: string): Promise<boolean> {
    const result = await native.showMessageBox(parent, { type: 'question', title: '桌宠快捷工作台', message, detail,
      buttons: ['取消', verb], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1 && await stillSame(sender, parent);
  }
  return {
    async selectTarget(kind: QuickLaunchKind, sender: QuickLaunchSender): Promise<string | null> {
      if (platform !== 'win32') return null;
      try {
        const parent = await currentParent(host, sender);
        if (!parent) return null;
        if (kind === 'HTTPS') {
          const value = await host.takeManualHttpsInput?.(sender);
          return typeof value === 'string' && normalizeHttpsTarget(value) !== null && await stillSame(sender, parent) ? value : null;
        }
        if (kind !== 'WIN32_EXE' && kind !== 'FOLDER') return null;
        const options: OpenDialogOptions = kind === 'WIN32_EXE'
          ? { title: '选择已安装的本地应用', properties: ['openFile', 'dontAddToRecent'], filters: [{ name: '应用程序', extensions: ['exe'] }] }
          : { title: '选择本地目录', properties: ['openDirectory', 'dontAddToRecent'] };
        const picked = await native.showOpenDialog(parent, options);
        return picked.canceled === false && picked.filePaths.length === 1 && typeof picked.filePaths[0] === 'string'
          && await stillSame(sender, parent) ? picked.filePaths[0] : null;
      } catch { return null; }
    },
    async confirmAdd(preview, sender): Promise<boolean> {
      if (platform !== 'win32' || !validPreview(preview)) return false;
      try {
        const parent = await currentParent(host, sender);
        if (!parent) return false;
        return await confirm(parent, sender, '保存这个快捷入口？', `${preview.locator}\n\n只会保存此确切目标，文件变化需要重新确认。不要保存含凭据的网址。`, '保存');
      } catch { return false; }
    },
    async consumeSavedUserClick(actionId, revision, sender): Promise<boolean> {
      if (platform !== 'win32' || !identifier.test(actionId) || !Number.isSafeInteger(revision) || revision < 0) return false;
      try {
        const parent = await currentParent(host, sender);
        if (!parent) return false;
        const shown = await loadForConfirmation(host, actionId, revision);
        if (!shown || !await stillSame(sender, parent) || !validPreview({ kind: shown.kind, locator: shown.locator, suggestedLabel: shown.label })) return false;
        // Electron IPC does not authenticate a renderer's physical click.
        // Until a trusted native gesture route exists, always use this explicit
        // Main dialog even for saved shortcuts: never trust a boolean claim.
        const accepted = await confirm(parent, sender, `运行已保存的「${shown.label}」？`, `${shown.locator}\n\n系统可能打开新窗口；接收请求不表示已经就绪。`, '运行');
        if (!accepted) return false;
        const latest = await loadForConfirmation(host, actionId, revision);
        return latest !== null && JSON.stringify(latest) === JSON.stringify(shown) && await stillSame(sender, parent);
      } catch { return false; }
    },
  };
}

/** Compose ONLY into QuickLaunchPolicy, not as a renderer binding/API. Actual
 * Windows adapter availability/ABI and bundled helper digest still require a
 * Windows package build. No launch is attempted at factory construction. */
export function createWindowsLaunchAdapters(options: WindowsLaunchAdaptersOptions): WindowsLaunchAdapters {
  const platform = options.platform ?? process.platform, spawnProcess = options.spawnProcess ?? defaultSpawn;
  const inspector = new Inspector(options, platform, spawnProcess);
  return { fs: makeFs(inspector), dialog: makeDialog(platform, options.nativeDialog, options.host),
    launcher: makeLauncher(platform, options.nativeShell, inspector, spawnProcess), helperAvailable: signal => inspector.available(signal) };
}
