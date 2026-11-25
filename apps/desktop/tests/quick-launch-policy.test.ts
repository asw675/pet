import { describe, expect, it, vi } from 'vitest';
import { normalizeHttpsTarget, normalizeLocalWin32Path, QuickLaunchPolicy, quickLaunchLimits } from '../src/main/quick-launch-policy.js';
import type {
  AdapterLaunchOutcome, ApprovedQuickTarget, ExecutableObservation, LocalPathObservation, QuickLaunchAuthorityPort,
  QuickLaunchContext, QuickLaunchDialogPort, QuickLaunchFsPort, SavedQuickAction,
} from '../src/main/quick-launch-policy.js';

const exe = 'C:\\Program Files\\测试应用\\Editor.exe';
const exeParent = 'C:\\Program Files\\测试应用';
const folder = 'C:\\Users\\测试\\Project';
const web = 'https://example.com/docs?q=tea#chapter';
const volumeSerial = '1234567890abcdef';
const digest = 'a'.repeat(64);
const context: QuickLaunchContext = { sender: { role: 'control-center', senderId: 11, documentId: 'doc-1' }, expectedRevision: 7 };
const otherContext: QuickLaunchContext = { ...context, sender: { ...context.sender, senderId: 12 } };
const newDocument: QuickLaunchContext = { ...context, sender: { ...context.sender, documentId: 'doc-2' } };

function observation(canonicalPath: string, kind: 'FILE' | 'DIRECTORY', n: number): LocalPathObservation {
  return { canonicalPath, kind, reparsePoint: false, identity: { volumeSerial, fileId: n.toString(16).padStart(32, '0') },
    sizeBytes: kind === 'FILE' ? 2048 : 0, modifiedAtMs: 1234 };
}
const exeObservation = observation(exe, 'FILE', 4);
const hashObservation: ExecutableObservation = {
  ...exeObservation, kind: 'FILE', sha256: digest, format: 'PE_EXE', classification: 'USER_APPLICATION', originalFilename: 'Editor.exe',
};
const approvedExe: ApprovedQuickTarget = {
  kind: 'WIN32_EXE', locator: exe, fingerprint: { kind: 'EXECUTABLE', identity: exeObservation.identity,
    sizeBytes: exeObservation.sizeBytes, modifiedAtMs: exeObservation.modifiedAtMs, sha256: digest },
};
const folderObservation = observation(folder, 'DIRECTORY', 7);
const approvedFolder: ApprovedQuickTarget = {
  kind: 'FOLDER', locator: folder, fingerprint: { kind: 'DIRECTORY', identity: folderObservation.identity },
};
const approvedWeb: ApprovedQuickTarget = { kind: 'HTTPS', locator: web, fingerprint: { kind: 'HTTPS', canonicalUrl: web } };

function saved(target: ApprovedQuickTarget = approvedExe): SavedQuickAction {
  return { ...target, id: 'saved-1', label: '我的工作台', revision: 7, approvedAt: 5000, enabled: true };
}

function setup(action: SavedQuickAction | null = saved()) {
  const state = { time: 10_000, revision: 7 as number | null, senderCurrent: true, selected: exe as string | null,
    confirm: true, action, clicks: 1 };
  const paths = new Map<string, LocalPathObservation>([
    ['C:\\', observation('C:\\', 'DIRECTORY', 1)],
    ['C:\\Program Files', observation('C:\\Program Files', 'DIRECTORY', 2)],
    [exeParent, observation(exeParent, 'DIRECTORY', 3)],
    [exe, exeObservation],
    ['C:\\Users', observation('C:\\Users', 'DIRECTORY', 5)],
    ['C:\\Users\\测试', observation('C:\\Users\\测试', 'DIRECTORY', 6)],
    [folder, folderObservation],
  ]);
  const fs = {
    driveType: vi.fn<QuickLaunchFsPort['driveType']>().mockResolvedValue('FIXED'),
    inspect: vi.fn<QuickLaunchFsPort['inspect']>().mockImplementation(async path => paths.get(path) ?? null),
    hashExecutable: vi.fn<QuickLaunchFsPort['hashExecutable']>().mockResolvedValue(hashObservation),
  };
  const dialog = {
    selectTarget: vi.fn<QuickLaunchDialogPort['selectTarget']>().mockImplementation(async () => state.selected),
    confirmAdd: vi.fn<QuickLaunchDialogPort['confirmAdd']>().mockImplementation(async () => state.confirm),
    consumeSavedUserClick: vi.fn<QuickLaunchDialogPort['consumeSavedUserClick']>().mockImplementation(() => {
      if (state.clicks < 1) return false;
      state.clicks--;
      return true;
    }),
  };
  const authority = {
    senderIsCurrent: vi.fn<QuickLaunchAuthorityPort['senderIsCurrent']>().mockImplementation(() => state.senderCurrent),
    workspaceRevision: vi.fn<QuickLaunchAuthorityPort['workspaceRevision']>().mockImplementation(async () => state.revision),
    loadSavedAction: vi.fn<QuickLaunchAuthorityPort['loadSavedAction']>().mockImplementation(async () => state.action),
  };
  const launcher = {
    launchExecutable: vi.fn<(path: string) => Promise<AdapterLaunchOutcome>>().mockResolvedValue('accepted'),
    openFolder: vi.fn<(path: string) => Promise<AdapterLaunchOutcome>>().mockResolvedValue('accepted'),
    openHttps: vi.fn<(url: string) => Promise<AdapterLaunchOutcome>>().mockResolvedValue('accepted'),
  };
  const tokenEntropy = vi.fn(() => 'c'.repeat(64));
  const policy = new QuickLaunchPolicy({ fs, dialog, authority, launcher, now: () => state.time, tokenEntropy });
  return { policy, state, paths, fs, dialog, authority, launcher, tokenEntropy };
}

function noLaunch(harness: ReturnType<typeof setup>): void {
  expect(harness.launcher.launchExecutable).not.toHaveBeenCalled();
  expect(harness.launcher.openFolder).not.toHaveBeenCalled();
  expect(harness.launcher.openHttps).not.toHaveBeenCalled();
}

async function prepareRun(harness: ReturnType<typeof setup>): Promise<string> {
  const result = await harness.policy.prepareSavedRun('saved-1', context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected mock approval');
  return result.token;
}
async function prepareAdd(harness: ReturnType<typeof setup>): Promise<string> {
  const result = await harness.policy.prepareAdd('WIN32_EXE', context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected mock approval');
  return result.token;
}

describe('narrow native Win32 and HTTPS locator parsing', () => {
  it('accepts absolute local spelling with spaces/Unicode and canonicalizes only the drive letter', () => {
    expect(normalizeLocalWin32Path(exe)).toBe(exe);
    expect(normalizeLocalWin32Path('c:\\Program Files\\测试应用\\Editor.exe')).toBe(exe);
    expect(normalizeLocalWin32Path(folder)).toBe(folder);
    expect(normalizeLocalWin32Path('D:\\')).toBe('D:\\');
  });

  it.each([
    null, '', 'Editor.exe', 'C:Editor.exe', '\\Editor.exe', 'C:/Editor.exe',
    '\\\\host\\share\\Editor.exe', '\\\\?\\C:\\Editor.exe', '\\\\.\\C:\\Editor.exe', '\\??\\C:\\Editor.exe',
    'C:\\Users\\..\\Editor.exe', 'C:\\.\\Editor.exe', 'C:\\Users\\\\Editor.exe',
    'C:\\Users\\Editor.exe:stream', 'C:\\Users\\Editor.exe.', 'C:\\Users\\Editor.exe ',
    'C:\\Users\\NUL.exe', 'C:\\COM1\\App.exe', 'C:\\LPT¹.txt\\App.exe', 'C:\\Users\\CONIN$',
    'C:\\PROGRA~1\\App.exe', 'C:\\Users\\bad?file.exe', 'C:\\Users\\a\u0000.exe', 'C:\\Users\\a\u200b.exe',
    'C:\\Users\\', 'C:\\' + 'a'.repeat(260), 'C:\\' + Array.from({ length: 65 }, () => 'a').join('\\'),
  ])('rejects ambiguous, network, device, aliased or malformed Win32 locator: %#', path => {
    expect(normalizeLocalWin32Path(path)).toBeNull();
  });

  it('canonicalizes safe full HTTPS URLs for the exact confirmation display', () => {
    expect(normalizeHttpsTarget('HTTPS://Example.COM:443/docs?q=tea#chapter')).toBe(web);
    expect(normalizeHttpsTarget('https://example.com')).toBe('https://example.com/');
    expect(normalizeHttpsTarget('https://example.com:8443/中文')).toBe('https://example.com:8443/%E4%B8%AD%E6%96%87');
  });

  it.each([
    '', '/relative', 'http://example.com/', 'file:///C:/Users', 'javascript:plain', 'ms-settings:display',
    'https://user@example.com', 'https://user:password@example.com', 'https://example.com@elsewhere.invalid',
    'https://example.com:65536/', 'https://example.com./', 'https://exa%mple.com/', 'https://127.1/',
    'https://0x7f.0.0.1/', 'https://localhost/', 'https://例子.测试/', 'https://example.com\\another',
    'https://example.com/white space', 'https://example.com/%0Aextra', 'https://example.com/%5Cextra', 'https://example.com/%',
    'https://example.com/?token=fake', 'https://example.com/?api_key=fake', 'https://example.com/?t%6fken=fake',
    'https://example.com/#access_token=fake', 'https://example.com/' + 'a'.repeat(2050),
  ])('rejects unsafe or ambiguous external URL: %#', url => expect(normalizeHttpsTarget(url)).toBeNull());
});

describe('native-selected add approval; no execution capability', () => {
  it('checks all local components and full bounded executable content, displays canonical target, then revalidates before saving', async () => {
    const h = setup();
    const approval = await h.policy.prepareAdd('WIN32_EXE', context);
    expect(approval).toMatchObject({ ok: true, expiresAt: h.state.time + quickLaunchLimits.approvalTtlMs,
      preview: { kind: 'WIN32_EXE', locator: exe, suggestedLabel: 'Editor.exe' } });
    if (!approval.ok) throw new Error('expected add approval');
    expect(h.dialog.selectTarget).toHaveBeenCalledWith('WIN32_EXE', context.sender);
    expect(h.dialog.confirmAdd).toHaveBeenCalledWith(approval.preview, context.sender);
    expect(h.fs.inspect.mock.calls.map(call => call[0])).toEqual([
      'C:\\', 'C:\\Program Files', exeParent, exe, 'C:\\', 'C:\\Program Files', exeParent, exe,
    ]);
    expect(h.fs.hashExecutable).toHaveBeenCalledWith(exe, quickLaunchLimits.maxExecutableBytes, expect.any(AbortSignal));
    expect(h.fs.driveType.mock.calls.map(call => call[0])).toEqual(['C:\\', 'C:\\']);
    expect(await h.policy.consumeAdd(approval.token, context)).toEqual({ ok: true, target: approvedExe, expectedRevision: 7 });
    expect(h.fs.hashExecutable).toHaveBeenCalledTimes(2);
    expect(await h.policy.consumeAdd(approval.token, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });

  it('saves only a folder canonical path and identity, without reading its contents', async () => {
    const h = setup();
    h.state.selected = folder;
    const approval = await h.policy.prepareAdd('FOLDER', context);
    expect(approval).toMatchObject({ ok: true, preview: { locator: folder, suggestedLabel: 'Project' } });
    if (!approval.ok) throw new Error('expected add approval');
    expect(await h.policy.consumeAdd(approval.token, context)).toEqual({ ok: true, target: approvedFolder, expectedRevision: 7 });
    expect(h.fs.hashExecutable).not.toHaveBeenCalled();
    noLaunch(h);
  });

  it('saves manually selected canonical HTTPS without touching filesystem or fetching the webpage', async () => {
    const h = setup();
    h.state.selected = 'HTTPS://Example.COM:443/docs?q=tea#chapter';
    const approval = await h.policy.prepareAdd('HTTPS', context);
    expect(approval).toMatchObject({ ok: true, preview: { locator: web, suggestedLabel: 'example.com' } });
    if (!approval.ok) throw new Error('expected add approval');
    expect(await h.policy.consumeAdd(approval.token, context)).toEqual({ ok: true, target: approvedWeb, expectedRevision: 7 });
    expect(h.fs.inspect).not.toHaveBeenCalled();
    expect(h.fs.driveType).not.toHaveBeenCalled();
    noLaunch(h);
  });

  it.each(['C:\\Apps\\task.bat', 'C:\\Apps\\script.cmd', 'C:\\Apps\\shortcut.lnk', 'C:\\Apps\\cmd.exe', 'C:\\Apps\\PowerShell.EXE',
    'C:\\Apps\\wscript.exe', 'C:\\Apps\\python3.12.exe', 'C:\\Apps\\node.exe', 'C:\\Apps\\mshta.exe',
    'C:\\Apps\\rundll32.exe', 'C:\\Apps\\runas.exe', 'C:\\Apps\\Editor.exe --flag'])('refuses scripts, executors or shell/interpreter targets before filesystem access: %#', selected => {
    const h = setup();
    h.state.selected = selected;
    return h.policy.prepareAdd('WIN32_EXE', context).then(result => {
      expect(result).toEqual({ ok: false, code: 'INVALID_TARGET' });
      expect(h.fs.driveType).not.toHaveBeenCalled();
      expect(h.dialog.confirmAdd).not.toHaveBeenCalled();
      noLaunch(h);
    });
  });

  it.each([
    ['mapped or remote drive', (h: ReturnType<typeof setup>) => h.fs.driveType.mockResolvedValue('REMOTE')],
    ['ambiguous drive', (h: ReturnType<typeof setup>) => h.fs.driveType.mockResolvedValue('UNKNOWN')],
    ['parent reparse point', (h: ReturnType<typeof setup>) => h.paths.set(exeParent, { ...h.paths.get(exeParent)!, reparsePoint: true })],
    ['final reparse point', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, reparsePoint: true })],
    ['different canonical path', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, canonicalPath: 'C:\\Elsewhere\\Editor.exe' })],
    ['canonical case ambiguity', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, canonicalPath: exe.toLowerCase() })],
    ['different volume mounted under parent', (h: ReturnType<typeof setup>) => h.paths.set(exeParent, { ...h.paths.get(exeParent)!, identity: { ...exeObservation.identity, volumeSerial: '2'.repeat(16) } })],
    ['unknown file identity', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, identity: { ...exeObservation.identity, fileId: '0'.repeat(32) } })],
    ['directory posing as exe', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, kind: 'DIRECTORY' })],
    ['missing target', (h: ReturnType<typeof setup>) => h.paths.delete(exe)],
    ['empty file', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, sizeBytes: 0 })],
    ['unbounded executable', (h: ReturnType<typeof setup>) => h.paths.set(exe, { ...exeObservation, sizeBytes: quickLaunchLimits.maxExecutableBytes + 1 })],
  ] as const)('cannot approve a %s', async (_label, tamper) => {
    const h = setup();
    tamper(h);
    expect(await h.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'UNSAFE_TARGET' });
    expect(h.fs.hashExecutable).not.toHaveBeenCalled();
    expect(h.dialog.confirmAdd).not.toHaveBeenCalled();
    noLaunch(h);
  });

  it.each([
    { ...hashObservation, classification: 'UNKNOWN' }, { ...hashObservation, classification: 'PROHIBITED' },
    { ...hashObservation, format: 'UNKNOWN' }, { ...hashObservation, originalFilename: 'powershell.exe' },
    { ...hashObservation, originalFilename: null }, { ...hashObservation, sha256: 'bad' },
    { ...hashObservation, sizeBytes: exeObservation.sizeBytes + 1 }, { ...hashObservation, modifiedAtMs: exeObservation.modifiedAtMs + 1 },
    { ...hashObservation, identity: { ...exeObservation.identity, fileId: 'e'.repeat(32) } }, null,
  ])('fails closed on unsupported PE metadata, renamed interpreter or nonmatching handle fingerprint: %#', async observed => {
    const h = setup();
    h.fs.hashExecutable.mockResolvedValue(observed as ExecutableObservation | null);
    expect(await h.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'UNSAFE_TARGET' });
    expect(h.dialog.confirmAdd).not.toHaveBeenCalled();
    noLaunch(h);
  });

  it('rejects target replacement between hashing and the final path observation', async () => {
    const h = setup();
    h.fs.hashExecutable.mockImplementation(async () => {
      h.paths.set(exe, { ...exeObservation, identity: { ...exeObservation.identity, fileId: 'b'.repeat(32) } });
      return hashObservation;
    });
    expect(await h.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'TARGET_CHANGED' });
    expect(h.dialog.confirmAdd).not.toHaveBeenCalled();
    noLaunch(h);
  });

  it('does not save after click cancellation, refusal, stale workspace or unauthorized sender', async () => {
    const cancelled = setup();
    cancelled.state.selected = null;
    expect(await cancelled.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'CANCELLED' });
    expect(cancelled.fs.inspect).not.toHaveBeenCalled();
    const refused = setup();
    refused.state.confirm = false;
    expect(await refused.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'CANCELLED' });
    expect(refused.tokenEntropy).not.toHaveBeenCalled();
    const stale = setup();
    stale.state.revision = 8;
    expect(await stale.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(stale.dialog.selectTarget).not.toHaveBeenCalled();
    const invalid = setup();
    invalid.state.senderCurrent = false;
    expect(await invalid.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(invalid.dialog.selectTarget).not.toHaveBeenCalled();
  });

  it('cannot issue an approval when the sender or workspace changes while the confirmation is displayed', async () => {
    const revision = setup();
    revision.dialog.confirmAdd.mockImplementation(async () => { revision.state.revision = 8; return true; });
    expect(await revision.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    const closed = setup();
    closed.dialog.confirmAdd.mockImplementation(async () => { closed.state.senderCurrent = false; return true; });
    expect(await closed.policy.prepareAdd('WIN32_EXE', context)).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('one-use sender/document/revision and purpose binding', () => {
  it('a save token cannot launch; a run token cannot save; a different sender or even a new document cannot consume it', async () => {
    const h = setup();
    const saveToken = await prepareAdd(h);
    expect(await h.policy.executeSavedRun(saveToken, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect(await h.policy.consumeAdd(saveToken, otherContext)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect(await h.policy.consumeAdd(saveToken, newDocument)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect((await h.policy.consumeAdd(saveToken, context)).ok).toBe(true);
    const runToken = await prepareRun(h);
    expect(await h.policy.consumeAdd(runToken, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect(await h.policy.executeSavedRun(runToken, otherContext)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });

  it('consumes a valid-sender token even when a revision expectation is wrong, preventing silent retries', async () => {
    const h = setup();
    const token = await prepareRun(h);
    expect(await h.policy.executeSavedRun(token, { ...context, expectedRevision: 8 })).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(await h.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });

  it.each([quickLaunchLimits.approvalTtlMs, -1])('rejects an expired token or an authority clock rollback: %#', async delta => {
    const h = setup();
    const token = await prepareRun(h);
    h.state.time += delta;
    expect(await h.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
    noLaunch(h);
  });

  it('binds a confirmation to the selected exact fingerprint; changed contents consume the save approval without persisting', async () => {
    const h = setup();
    const token = await prepareAdd(h);
    h.fs.hashExecutable.mockResolvedValue({ ...hashObservation, sha256: 'd'.repeat(64) });
    expect(await h.policy.consumeAdd(token, context)).toEqual({ ok: false, code: 'TARGET_CHANGED' });
    expect(await h.policy.consumeAdd(token, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });

  it('never reissues the same approval token even with identical injected entropy', async () => {
    const h = setup();
    const first = await prepareRun(h);
    h.state.clicks++;
    const second = await prepareRun(h);
    expect(first).not.toBe(second);
    expect((await h.policy.executeSavedRun(first, context)).ok).toBe(true);
    expect(await h.policy.executeSavedRun(first, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect((await h.policy.executeSavedRun(second, context)).ok).toBe(true);
    expect(h.launcher.launchExecutable).toHaveBeenCalledTimes(2);
  });

  it('bounds pending approvals, and clear/revoke invalidates outstanding tokens without launch', async () => {
    const h = setup();
    h.state.clicks = quickLaunchLimits.pendingApprovals + 1;
    const tokens: string[] = [];
    for (let i = 0; i < quickLaunchLimits.pendingApprovals; i++) tokens.push(await prepareRun(h));
    expect(await h.policy.prepareSavedRun('saved-1', context)).toEqual({ ok: false, code: 'BUSY' });
    h.policy.revokeSender(context.sender.senderId, context.sender.documentId);
    expect(await h.policy.executeSavedRun(tokens[0]!, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    h.state.clicks++;
    const after = await prepareRun(h);
    h.policy.clear();
    expect(await h.policy.executeSavedRun(after, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });
});

describe('fixed launcher gets exactly one current approved target after explicit manual saved intent', () => {
  it('no verified user click, no saved-target lookup or launch; neither AI/path nor pet roles are capabilities', async () => {
    const h = setup();
    h.state.clicks = 0;
    expect(await h.policy.launchSavedAction('saved-1', context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(h.authority.loadSavedAction).not.toHaveBeenCalled();
    expect(h.fs.inspect).not.toHaveBeenCalled();
    const petContext = { ...context, sender: { ...context.sender, role: 'pet' } } as unknown as QuickLaunchContext;
    expect(await h.policy.prepareSavedRun('saved-1', petContext)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await h.policy.prepareSavedRun(exe, context)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await h.policy.prepareSavedRun('saved-1', { ...context, confirmed: true } as unknown as QuickLaunchContext)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    noLaunch(h);
  });

  it.each([
    [approvedExe, 'launchExecutable'], [approvedFolder, 'openFolder'], [approvedWeb, 'openHttps'],
  ] as const)('manual saved action uses only its exact one-argument fixed adapter', async (target, method) => {
    const h = setup(saved(target));
    const result = await h.policy.launchSavedAction('saved-1', context);
    expect(result).toEqual({ ok: true, outcome: 'accepted' });
    expect(h.launcher[method].mock.calls).toEqual([[target.locator]]);
    for (const other of ['launchExecutable', 'openFolder', 'openHttps'] as const) if (other !== method) expect(h.launcher[other]).not.toHaveBeenCalled();
    expect(h.authority.loadSavedAction.mock.calls.map(call => call[0])).toEqual(['saved-1', 'saved-1', 'saved-1']);
    expect(h.dialog.consumeSavedUserClick).toHaveBeenCalledOnce();
    expect(await h.policy.launchSavedAction('saved-1', context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(h.launcher[method]).toHaveBeenCalledOnce();
    if (target.kind === 'HTTPS') expect(h.fs.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { ...saved(), enabled: false }, { ...saved(), revision: 8 }, { ...saved(), approvedAt: 5001 },
    { ...saved(approvedWeb) }, null, { ...saved(), args: ['unexpected'] }, { ...saved(), enabled: 'yes' }, { ...saved(), approvedAt: 20_000 },
  ])('does not execute a disabled, stale, altered or malformed authority target: %#', async altered => {
    const h = setup();
    const token = await prepareRun(h);
    h.state.action = altered as SavedQuickAction | null;
    const result = await h.policy.executeSavedRun(token, context);
    expect(result.ok).toBe(false);
    expect(await h.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'APPROVAL_INVALID' });
    noLaunch(h);
  });

  it('fresh executable full fingerprint and directory identity need to match the saved approval', async () => {
    const h = setup();
    const token = await prepareRun(h);
    h.fs.hashExecutable.mockResolvedValue({ ...hashObservation, sha256: 'f'.repeat(64) });
    expect(await h.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'TARGET_CHANGED' });
    noLaunch(h);
    const dir = setup(saved(approvedFolder));
    const dirToken = await prepareRun(dir);
    dir.paths.set(folder, { ...folderObservation, identity: { ...folderObservation.identity, fileId: 'f'.repeat(32) } });
    expect(await dir.policy.executeSavedRun(dirToken, context)).toEqual({ ok: false, code: 'TARGET_CHANGED' });
    noLaunch(dir);
  });

  it('rechecks authority after inspection so a newly disabled/replaced target cannot launch', async () => {
    const h = setup();
    const token = await prepareRun(h);
    h.fs.hashExecutable.mockImplementation(async () => {
      h.state.action = { ...saved(), enabled: false };
      return hashObservation;
    });
    expect(await h.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    noLaunch(h);
  });

  it('a token cannot be double-executed concurrently before asynchronous revalidation finishes', async () => {
    const h = setup();
    const token = await prepareRun(h);
    const both = await Promise.all([h.policy.executeSavedRun(token, context), h.policy.executeSavedRun(token, context)]);
    expect(both).toContainEqual({ ok: true, outcome: 'accepted' });
    expect(both).toContainEqual({ ok: false, code: 'APPROVAL_INVALID' });
    expect(h.launcher.launchExecutable).toHaveBeenCalledOnce();
  });

  it('revoke while an approved fingerprint check is in flight prevents a late launch', async () => {
    const h = setup();
    const token = await prepareRun(h);
    let finishHash!: (value: ExecutableObservation) => void;
    h.fs.hashExecutable.mockImplementation(() => new Promise(resolve => { finishHash = resolve; }));
    const run = h.policy.executeSavedRun(token, context);
    await vi.waitFor(() => expect(h.fs.hashExecutable).toHaveBeenCalledOnce());
    h.policy.revokeSender(context.sender.senderId, context.sender.documentId);
    finishHash(hashObservation);
    expect(await run).toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
    noLaunch(h);
  });

  it('expires while inspecting or loses current sender and never launches despite a once-valid token', async () => {
    const expired = setup();
    const token = await prepareRun(expired);
    expired.fs.hashExecutable.mockImplementation(async () => {
      expired.state.time += quickLaunchLimits.approvalTtlMs;
      return hashObservation;
    });
    expect(await expired.policy.executeSavedRun(token, context)).toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
    noLaunch(expired);
    const closed = setup();
    const second = await prepareRun(closed);
    closed.fs.hashExecutable.mockImplementation(async () => { closed.state.senderCurrent = false; return hashObservation; });
    expect(await closed.policy.executeSavedRun(second, context)).toEqual({ ok: false, code: 'FORBIDDEN' });
    noLaunch(closed);
  });

  it('reports sanitized fixed adapter outcome/exception and never retries', async () => {
    for (const outcome of ['failed', 'unknown'] as const) {
      const h = setup();
      h.launcher.launchExecutable.mockResolvedValue(outcome);
      expect(await h.policy.launchSavedAction('saved-1', context)).toEqual({ ok: true, outcome });
      expect(h.launcher.launchExecutable).toHaveBeenCalledOnce();
    }
    const h = setup();
    h.launcher.launchExecutable.mockRejectedValue(new Error('private host path or process details'));
    expect(await h.policy.launchSavedAction('saved-1', context)).toEqual({ ok: true, outcome: 'failed' });
    expect(h.launcher.launchExecutable).toHaveBeenCalledOnce();
  });

  it('returns unknown on launch timeout without automatic replay, and ignores later completion', async () => {
    vi.useFakeTimers();
    try {
      const h = setup(saved(approvedWeb));
      let later!: (value: AdapterLaunchOutcome) => void;
      h.launcher.openHttps.mockImplementation(() => new Promise(resolve => { later = resolve; }));
      const run = h.policy.launchSavedAction('saved-1', context);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launcher.openHttps).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(quickLaunchLimits.launchTimeoutMs);
      expect(await run).toEqual({ ok: true, outcome: 'unknown' });
      later('accepted');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launcher.openHttps).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('bounds filesystem inspection time and signals abort, never launching if a validation port hangs', async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      let observedSignal: AbortSignal | undefined;
      h.fs.driveType.mockImplementation((_root, signal) => {
        observedSignal = signal;
        return new Promise(() => undefined);
      });
      const run = h.policy.launchSavedAction('saved-1', context);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fs.driveType).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(quickLaunchLimits.inspectionTimeoutMs);
      expect(await run).toEqual({ ok: false, code: 'TIMEOUT' });
      expect(observedSignal?.aborted).toBe(true);
      noLaunch(h);
    } finally { vi.useRealTimers(); }
  });
});
