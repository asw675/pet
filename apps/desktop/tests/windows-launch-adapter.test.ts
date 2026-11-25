import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsLaunchAdapters, windowsLaunchAdapterLimits } from '../src/main/windows-launch-adapter.js';
import type { WindowsLaunchAdaptersOptions, WindowsLaunchNativeHost, WindowsLaunchNativeDialog, WindowsLaunchNativeShell, WindowsLaunchSpawnPort } from '../src/main/windows-launch-adapter.js';
import type { QuickLaunchSender, SavedQuickAction } from '../src/main/quick-launch-policy.js';
import { quickLaunchLimits } from '../src/main/quick-launch-policy.js';

const exe = 'C:\\Program Files\\Editor\\Editor.exe';
const folder = 'C:\\Users\\Test\\Projects';
const url = 'https://example.com/docs';
const identity = { volumeSerial: '1234567890abcdef', fileId: '1234567890abcdef1234567890abcdef' };
const hash = 'a'.repeat(64);
const observed = { canonicalPath: exe, identity, kind: 'FILE', reparsePoint: false, sizeBytes: 2048, modifiedAtMs: 1234 };
const executable = { ...observed, sha256: hash, format: 'PE_EXE', classification: 'USER_APPLICATION', originalFilename: 'Editor.exe' };
const saved: SavedQuickAction = { id: 'saved-1', revision: 7, approvedAt: 100, enabled: true, label: '文字编辑器', kind: 'WIN32_EXE',
  locator: exe, fingerprint: { kind: 'EXECUTABLE', identity, sizeBytes: 2048, modifiedAtMs: 1234, sha256: hash } };
const sender: QuickLaunchSender = { role: 'control-center', senderId: 11, documentId: 'doc-1' };
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Synthetic bytes and mock children only. No real PE or process execution. */
function syntheticHelper() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pet-launch-test-')));
  roots.push(root);
  const dir = join(root, 'native', 'launch-inspect');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'launch-inspect.exe');
  const bytes = Buffer.from('synthetic inspector bytes; never executed');
  writeFileSync(path, bytes);
  return { root, path, dir, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

function fakeChild(reply?: string | Buffer | object, closeCode = 0) {
  const events = new EventEmitter();
  const stdin = new PassThrough(), stdout = new PassThrough();
  const kill = vi.fn(() => true), unref = vi.fn();
  const input: Buffer[] = [];
  stdin.on('data', chunk => input.push(Buffer.from(chunk)));
  if (reply !== undefined) stdin.on('end', () => {
    stdout.write(typeof reply === 'string' || Buffer.isBuffer(reply) ? reply : JSON.stringify(reply)); stdout.end();
    queueMicrotask(() => events.emit('close', closeCode));
  });
  const child = Object.assign(events, { stdin, stdout, stderr: null, kill, unref }) as unknown as ChildProcess;
  return { child, stdin, stdout, kill, unref, events, input: () => Buffer.concat(input).toString('utf8') };
}

function setup(overrides: Partial<WindowsLaunchAdaptersOptions> = {}) {
  const fixture = syntheticHelper();
  const parent = { isDestroyed: vi.fn(() => false), webContents: { id: 11 } } as unknown as BrowserWindow;
  const host = {
    senderIsCurrent: vi.fn<WindowsLaunchNativeHost['senderIsCurrent']>().mockReturnValue(true),
    parentFor: vi.fn<WindowsLaunchNativeHost['parentFor']>().mockReturnValue(parent),
    loadSavedAction: vi.fn<WindowsLaunchNativeHost['loadSavedAction']>().mockResolvedValue(saved),
  };
  const nativeDialog = {
    showOpenDialog: vi.fn<WindowsLaunchNativeDialog['showOpenDialog']>().mockResolvedValue({ canceled: false, filePaths: [exe] }),
    showMessageBox: vi.fn<WindowsLaunchNativeDialog['showMessageBox']>().mockResolvedValue({ response: 1 }),
  };
  const nativeShell = {
    openPath: vi.fn<WindowsLaunchNativeShell['openPath']>().mockResolvedValue(''),
    openExternal: vi.fn<WindowsLaunchNativeShell['openExternal']>().mockResolvedValue(undefined),
  };
  const spawnProcess = vi.fn<WindowsLaunchSpawnPort>();
  const options: WindowsLaunchAdaptersOptions = { resourcesDirectory: fixture.root, expectedInspectorSha256: fixture.digest, platform: 'win32',
    host, nativeDialog, nativeShell, spawnProcess, ...overrides };
  const adapters = createWindowsLaunchAdapters(options);
  return { fixture, host, nativeDialog, nativeShell, spawnProcess, options, adapters, parent };
}
const reply = (operation: string, result: unknown) => ({ version: 1, operation, result });

describe('Windows adapter helper pinning and closed IO', () => {
  it('requires an absolute canonical packaged path, real file and expected digest; never executes on availability checks', async () => {
    const h = setup();
    expect(await h.adapters.helperAvailable()).toBe(true);
    expect(h.spawnProcess).not.toHaveBeenCalled();
    for (const options of [{ expectedInspectorSha256: null }, { expectedInspectorSha256: '0'.repeat(64) },
      { expectedInspectorSha256: 'a'.repeat(64) }, { resourcesDirectory: 'relative' }, { platform: 'darwin' as const }]) {
      expect(await createWindowsLaunchAdapters({ ...h.options, ...options }).helperAvailable()).toBe(false);
    }
    writeFileSync(h.fixture.path, 'different bytes');
    expect(await h.adapters.helperAvailable()).toBe(false);
    rmSync(h.fixture.path);
    expect(await h.adapters.helperAvailable()).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('rejects a symlink to matching inspector bytes', async () => {
    const h = setup();
    const outside = join(h.fixture.root, 'same-content');
    writeFileSync(outside, h.fixture.bytes);
    rmSync(h.fixture.path);
    symlinkSync(outside, h.fixture.path);
    expect(await h.adapters.helperAvailable()).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });
  it('accepts the exact closed drive request via stdin only', async () => {
    const h = setup(), c = fakeChild(reply('DRIVE', 'FIXED'));
    h.spawnProcess.mockReturnValue(c.child);
    expect(await h.adapters.fs.driveType('C:\\', signal())).toBe('FIXED');
    expect(c.input()).toBe('PET-DESKTOP-LAUNCH-INSPECT-V1\nDRIVE\nC:\\\n0\n');
    expect(h.spawnProcess).toHaveBeenCalledOnce();
    expect(h.spawnProcess).toHaveBeenCalledWith(h.fixture.path, [], expect.objectContaining({ shell: false, windowsHide: true,
      cwd: h.fixture.dir, stdio: ['pipe', 'pipe', 'ignore'] }));
    expect(Object.keys(h.spawnProcess.mock.calls[0]![2].env ?? {}).every(key => ['SystemRoot', 'WINDIR'].includes(key))).toBe(true);
  });
  it('accepts only exact path observations and hashes within requested size', async () => {
    const h = setup(), c1 = fakeChild(reply('INSPECT', observed)), c2 = fakeChild(reply('HASH_EXE', executable));
    h.spawnProcess.mockReturnValueOnce(c1.child).mockReturnValueOnce(c2.child);
    expect(await h.adapters.fs.inspect(exe, signal())).toEqual(observed);
    expect(await h.adapters.fs.hashExecutable(exe, 4096, signal())).toEqual(executable);
    expect(c1.input()).toBe('PET-DESKTOP-LAUNCH-INSPECT-V1\nINSPECT\n' + exe + '\n0\n');
    expect(c2.input()).toContain('\nHASH_EXE\n' + exe + '\n4096\n');
  });
  it.each([
    ['unclosed json', '{'],
    ['another method', reply('DRIVE', 'FIXED')],
    ['another version', { version: 2, operation: 'INSPECT', result: observed }],
    ['wrong canonical path', reply('INSPECT', { ...observed, canonicalPath: folder })],
    ['raw extra field', reply('INSPECT', { ...observed, content: 'must not return' })],
    ['invalid identity', reply('INSPECT', { ...observed, identity: { ...identity, fileId: '0'.repeat(32) } })],
    ['negative size', reply('INSPECT', { ...observed, sizeBytes: -1 })],
    ['malformed bytes', Buffer.from([0xc0, 0xff])],
    ['oversized reply', 'X'.repeat(windowsLaunchAdapterLimits.helperReplyBytes + 1)],
  ])('rejects %s', async (_name, payload) => {
    const h = setup(), c = fakeChild(payload);
    h.spawnProcess.mockReturnValue(c.child);
    expect(await h.adapters.fs.inspect(exe, signal())).toBeNull();
  });
  it('rejects hash output larger than requested bound and nonzero helper exits', async () => {
    const h = setup();
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable)).child)
      .mockReturnValueOnce(fakeChild(reply('INSPECT', observed), 2).child);
    expect(await h.adapters.fs.hashExecutable(exe, 1024, signal())).toBeNull();
    expect(await h.adapters.fs.inspect(exe, signal())).toBeNull();
  });
  it('does not give a helper noncanonical, remote, ambiguous or interpreter targets', async () => {
    const h = setup();
    for (const p of ['\\\\server\\share\\App.exe', 'C:\\a\\..\\Editor.exe', 'C:\\a.txt:stream', 'C:\\A\n.exe', 'c:\\App.exe', 'C:/App.exe']) {
      expect(await h.adapters.fs.inspect(p, signal())).toBeNull();
    }
    for (const p of ['C:\\cmd.exe', 'C:\\Python3.exe', 'C:\\foo.bat', 'C:\\wscript.exe']) {
      expect(await h.adapters.fs.hashExecutable(p, 4096, signal())).toBeNull();
    }
    expect(await h.adapters.fs.driveType(folder, signal())).toBe('UNKNOWN');
    expect(await h.adapters.fs.hashExecutable(exe, quickLaunchLimits.maxExecutableBytes + 1, signal())).toBeNull();
    expect(await h.adapters.fs.hashExecutable(exe, 0, signal())).toBeNull();
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });
  it('aborts its own helper and refuses a second helper until close', async () => {
    const h = setup(), c = fakeChild(), abort = new AbortController();
    h.spawnProcess.mockReturnValue(c.child);
    const pending = h.adapters.fs.inspect(exe, abort.signal);
    await vi.waitFor(() => expect(h.spawnProcess).toHaveBeenCalledOnce());
    abort.abort();
    expect(await pending).toBeNull();
    expect(c.kill).toHaveBeenCalledOnce();
    expect(await h.adapters.helperAvailable()).toBe(false);
    expect(await h.adapters.fs.driveType('C:\\', signal())).toBe('UNKNOWN');
    expect(h.spawnProcess).toHaveBeenCalledOnce();
    c.events.emit('close', 2);
    expect(await h.adapters.helperAvailable()).toBe(true);
    expect(await h.adapters.fs.inspect(exe, abort.signal)).toBeNull();
    expect(h.spawnProcess).toHaveBeenCalledOnce();
  });
});

describe('Windows adapter native intent boundary', () => {
  it('selects file and folder separately with a current native parent', async () => {
    const h = setup();
    expect(await h.adapters.dialog.selectTarget('WIN32_EXE', sender)).toBe(exe);
    expect(h.nativeDialog.showOpenDialog).toHaveBeenCalledWith(h.parent, { title: '选择已安装的本地应用',
      properties: ['openFile', 'dontAddToRecent'], filters: [{ name: '应用程序', extensions: ['exe'] }] });
    h.nativeDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [folder] });
    expect(await h.adapters.dialog.selectTarget('FOLDER', sender)).toBe(folder);
    expect(h.nativeDialog.showOpenDialog).toHaveBeenLastCalledWith(h.parent, expect.objectContaining({ properties: ['openDirectory', 'dontAddToRecent'] }));
  });
  it('does not accept multiple paths, cancellations, or a stale sender', async () => {
    const h = setup();
    h.nativeDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [exe, folder] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [exe] });
    expect(await h.adapters.dialog.selectTarget('WIN32_EXE', sender)).toBeNull();
    expect(await h.adapters.dialog.selectTarget('WIN32_EXE', sender)).toBeNull();
    h.host.senderIsCurrent.mockReturnValue(false);
    expect(await h.adapters.dialog.selectTarget('WIN32_EXE', sender)).toBeNull();
    expect(h.nativeDialog.showOpenDialog).toHaveBeenCalledTimes(2);
  });
  it('requires Main-owned manual HTTPS input; no implicit URL source', async () => {
    const h = setup();
    expect(await h.adapters.dialog.selectTarget('HTTPS', sender)).toBeNull();
    expect(h.nativeDialog.showOpenDialog).not.toHaveBeenCalled();
    const input = vi.fn().mockResolvedValueOnce('http://example.com').mockResolvedValueOnce(url);
    const manual = createWindowsLaunchAdapters({ ...h.options, host: { ...h.host, takeManualHttpsInput: input } });
    expect(await manual.dialog.selectTarget('HTTPS', sender)).toBeNull();
    expect(await manual.dialog.selectTarget('HTTPS', sender)).toBe(url);
    expect(input).toHaveBeenCalledWith(sender);
    expect(h.nativeShell.openExternal).not.toHaveBeenCalled();
  });
  it('native save confirmation defaults to cancel and displays exact target', async () => {
    const h = setup(), preview = { kind: 'HTTPS' as const, locator: url, suggestedLabel: '文档' };
    h.nativeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await h.adapters.dialog.confirmAdd(preview, sender)).toBe(false);
    expect(await h.adapters.dialog.confirmAdd(preview, sender)).toBe(true);
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledWith(h.parent, expect.objectContaining({
      defaultId: 0, cancelId: 0, detail: expect.stringContaining(url), buttons: ['取消', '保存'] }));
    expect(await h.adapters.dialog.confirmAdd({ ...preview, locator: 'http://example.com/' }, sender)).toBe(false);
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledTimes(2);
  });
  it('does not authorize stale parent, document or invalid selected label after native dialog', async () => {
    const h = setup();
    h.host.senderIsCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await h.adapters.dialog.confirmAdd({ kind: 'HTTPS', locator: url, suggestedLabel: '文档' }, sender)).toBe(false);
    expect(await h.adapters.dialog.confirmAdd({ kind: 'HTTPS', locator: url, suggestedLabel: 'bad\nlabel' }, sender)).toBe(false);
    expect(await h.adapters.dialog.confirmAdd({ kind: 'HTTPS', locator: url, suggestedLabel: '文档' }, { ...sender, senderId: 12 })).toBe(false);
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledOnce();
  });
  it('requires explicit native run confirmation of fresh authority state, not renderer click claims', async () => {
    const h = setup();
    expect(await h.adapters.dialog.consumeSavedUserClick(saved.id, saved.revision, sender)).toBe(true);
    expect(h.host.loadSavedAction).toHaveBeenCalledTimes(2);
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledWith(h.parent, expect.objectContaining({
      detail: expect.stringContaining(exe), defaultId: 0, buttons: ['取消', '运行'] }));
    expect(h.spawnProcess).not.toHaveBeenCalled();
    h.nativeDialog.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await h.adapters.dialog.consumeSavedUserClick(saved.id, saved.revision, sender)).toBe(false);
  });
  it('rejects disabled, stale, or changed saved targets even if native dialog was accepted', async () => {
    const h = setup();
    h.host.loadSavedAction.mockResolvedValueOnce({ ...saved, enabled: false }).mockResolvedValueOnce({ ...saved, revision: 8 });
    expect(await h.adapters.dialog.consumeSavedUserClick(saved.id, saved.revision, sender)).toBe(false);
    expect(await h.adapters.dialog.consumeSavedUserClick(saved.id, saved.revision, sender)).toBe(false);
    expect(h.nativeDialog.showMessageBox).not.toHaveBeenCalled();
    h.host.loadSavedAction.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, label: 'Changed' });
    expect(await h.adapters.dialog.consumeSavedUserClick(saved.id, saved.revision, sender)).toBe(false);
    expect(h.nativeDialog.showMessageBox).toHaveBeenCalledOnce();
  });
});

describe('Windows adapter restricted launch outcomes using mocked ports', () => {
  it('calls fixed absolute path with no argument/shell/custom cwd and never kills the user app', async () => {
    const h = setup(), c = fakeChild();
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable)).child);
    expect(await h.adapters.fs.hashExecutable(exe, 4096, signal())).toEqual(executable);
    h.spawnProcess.mockImplementation(() => { queueMicrotask(() => c.events.emit('spawn')); return c.child; });
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('accepted');
    expect(h.spawnProcess).toHaveBeenLastCalledWith(exe, [], expect.objectContaining({ shell: false, cwd: 'C:\\Program Files\\Editor',
      stdio: 'ignore', detached: true, windowsHide: false }));
    expect(h.spawnProcess.mock.calls[1]![2].env).not.toHaveProperty('PATH');
    expect(c.unref).toHaveBeenCalledOnce();
    expect(c.kill).not.toHaveBeenCalled();
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
  });
  it('maps spawn errors to failure without a fallback', async () => {
    const h = setup(), c = fakeChild();
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable)).child);
    await h.adapters.fs.hashExecutable(exe, 4096, signal());
    h.spawnProcess.mockImplementation(() => { queueMicrotask(() => c.events.emit('error', new Error('private'))); return c.child; });
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
    expect(h.nativeShell.openPath).not.toHaveBeenCalled();
    expect(c.kill).not.toHaveBeenCalled();
  });
  it('denies executable/folder launch when inspector unavailable or locator invalid', async () => {
    const h = setup();
    expect(await h.adapters.launcher.launchExecutable('C:\\cmd.exe')).toBe('failed');
    expect(await h.adapters.launcher.launchExecutable('C:\\app.ps1')).toBe('failed');
    expect(await h.adapters.launcher.openFolder('\\\\server\\share')).toBe('failed');
    rmSync(h.fixture.path);
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(await h.adapters.launcher.openFolder(folder)).toBe('failed');
    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(h.nativeShell.openPath).not.toHaveBeenCalled();
  });
  it('opens only the canonical folder via the fixed shell port and maps nonempty errors', async () => {
    const h = setup();
    const directory = { ...observed, canonicalPath: folder, kind: 'DIRECTORY', sizeBytes: 0 };
    h.spawnProcess.mockImplementation(() => fakeChild(reply('INSPECT', directory)).child);
    expect(await h.adapters.fs.inspect(folder, signal())).toEqual(directory);
    expect(await h.adapters.launcher.openFolder(folder)).toBe('accepted');
    h.nativeShell.openPath.mockResolvedValue('private path error');
    expect(await h.adapters.launcher.openFolder(folder)).toBe('failed');
    expect(await h.adapters.fs.inspect(folder, signal())).toEqual(directory);
    expect(await h.adapters.launcher.openFolder(folder)).toBe('failed');
    expect(h.nativeShell.openPath).toHaveBeenCalledTimes(2);
    expect(h.nativeShell.openPath).toHaveBeenCalledWith(folder);
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
  });
  it('does not treat helper availability or an ordinary file observation as dispatch permission', async () => {
    const h = setup();
    expect(await h.adapters.helperAvailable()).toBe(true);
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(await h.adapters.launcher.openFolder(folder)).toBe('failed');
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('INSPECT', observed)).child);
    expect(await h.adapters.fs.inspect(exe, signal())).toEqual(observed);
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(h.spawnProcess).toHaveBeenCalledOnce();
  });
  it('rejects stale attestation after a failed fresh observation and rejects prohibited metadata', async () => {
    const h = setup();
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable)).child)
      .mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable), 2).child)
      .mockReturnValueOnce(fakeChild(reply('HASH_EXE', { ...executable, originalFilename: 'cmd.exe' })).child);
    expect(await h.adapters.fs.hashExecutable(exe, 4096, signal())).toEqual(executable);
    expect(await h.adapters.fs.hashExecutable(exe, 4096, signal())).toBeNull();
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    await h.adapters.fs.hashExecutable(exe, 4096, signal());
    expect(await h.adapters.launcher.launchExecutable(exe)).toBe('failed');
    expect(h.spawnProcess).toHaveBeenCalledTimes(3);
  });
  it('dispatches a previously freshly inspected exact target synchronously even during another read-only probe', async () => {
    const h = setup(), blocked = fakeChild(), app = fakeChild();
    h.spawnProcess.mockReturnValueOnce(fakeChild(reply('HASH_EXE', executable)).child)
      .mockReturnValueOnce(blocked.child)
      .mockImplementation(() => { queueMicrotask(() => app.events.emit('spawn')); return app.child; });
    await h.adapters.fs.hashExecutable(exe, 4096, signal());
    const abort = new AbortController(), pending = h.adapters.fs.inspect(folder, abort.signal);
    await vi.waitFor(() => expect(h.spawnProcess).toHaveBeenCalledTimes(2));
    const dispatch = h.adapters.launcher.launchExecutable(exe);
    expect(h.spawnProcess).toHaveBeenCalledTimes(3); // no async helper verification before spawn
    expect(await dispatch).toBe('accepted');
    abort.abort(); expect(await pending).toBeNull(); blocked.events.emit('close', 2);
  });
  it('only passes canonical HTTPS to the external browser port, without helper or shell fallback', async () => {
    const h = setup({ expectedInspectorSha256: null });
    for (const bad of ['http://example.com', 'file:///C:/a', 'https://user:pass@example.com/', 'https://example.com', 'HTTPS://example.com/docs']) {
      expect(await h.adapters.launcher.openHttps(bad)).toBe('failed');
    }
    expect(await h.adapters.launcher.openHttps(url)).toBe('accepted');
    h.nativeShell.openExternal.mockRejectedValue(new Error('private url error'));
    expect(await h.adapters.launcher.openHttps(url)).toBe('failed');
    expect(h.nativeShell.openExternal).toHaveBeenCalledTimes(2);
    expect(h.nativeShell.openExternal).toHaveBeenCalledWith(url);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });
});
