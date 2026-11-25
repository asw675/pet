import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForegroundFullscreenMonitor, fullscreenHides, fullscreenQuiets } from '../src/main/fullscreen-policy';
import type { FullscreenSample } from '../src/main/fullscreen-policy';
import { parseFullscreenProbeLine, WindowsFullscreenProbe } from '../src/main/windows-fullscreen-probe';

afterEach(() => { vi.useRealTimers(); });

describe('fullscreen display state', () => {
  it('maps physical addresses, guards ambiguous states, and debounces transitions in both directions', async () => {
    vi.useFakeTimers();
    const sample = vi.fn<(_: AbortSignal) => Promise<FullscreenSample>>().mockResolvedValue({ kind: 'clear' });
    const onChange = vi.fn(), stopProbe = vi.fn();
    const monitor = new ForegroundFullscreenMonitor({ sample, onChange, stopProbe, displayForPoint: point => point.x < 0 ? 2 : undefined });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    sample.mockResolvedValue({ kind: 'display', x: -960, y: 500 });
    await vi.advanceTimersByTimeAsync(400);
    expect(monitor.state).toEqual({ kind: 'clear' });
    await vi.advanceTimersByTimeAsync(400);
    expect(monitor.state).toEqual({ kind: 'display', displayId: 2 });
    expect(fullscreenHides(monitor.state, 2)).toBe(true);
    expect(fullscreenQuiets(monitor.state, 2)).toBe(true);
    expect(fullscreenHides(monitor.state, 1)).toBe(false);
    expect(fullscreenQuiets(monitor.state, 1)).toBe(false);

    sample.mockResolvedValue({ kind: 'display', x: 100000, y: 100000 });
    await vi.advanceTimersByTimeAsync(400);
    expect(monitor.state).toEqual({ kind: 'display', displayId: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(monitor.state).toEqual({ kind: 'unknown' });
    expect(fullscreenHides(monitor.state, 2)).toBe(false);
    expect(fullscreenQuiets(monitor.state, 2)).toBe(true);

    sample.mockResolvedValue({ kind: 'unavailable' });
    await vi.advanceTimersByTimeAsync(800);
    expect(monitor.state).toEqual({ kind: 'clear' });
    expect(fullscreenQuiets(monitor.state, 2)).toBe(false);
    monitor.stop();
    expect(stopProbe).toHaveBeenCalledOnce();
    expect(onChange.mock.calls).toEqual([[{ kind: 'display', displayId: 2 }], [{ kind: 'unknown' }], [{ kind: 'clear' }]]);
  });

  it('honors global presentation, cancels an outstanding poll and ignores a late sample', async () => {
    vi.useFakeTimers();
    const sample = vi.fn<(_: AbortSignal) => Promise<FullscreenSample>>().mockResolvedValue({ kind: 'global' });
    const monitor = new ForegroundFullscreenMonitor({ sample, onChange: vi.fn(), stopProbe: vi.fn(), displayForPoint: () => 1 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(fullscreenHides(monitor.state, 100)).toBe(true);
    let reply!: (result: FullscreenSample) => void;
    sample.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    await vi.advanceTimersByTimeAsync(400);
    const signal = sample.mock.lastCall?.[0];
    monitor.stop();
    expect(signal?.aborted).toBe(true);
    reply({ kind: 'global' });
    await vi.advanceTimersByTimeAsync(800);
    expect(monitor.state).toEqual({ kind: 'clear' });
    expect(sample).toHaveBeenCalledTimes(3);
  });
});

describe('fixed fullscreen helper protocol', () => {
  it('accepts a bounded monitor point and no other text or extra fields', () => {
    expect(parseFullscreenProbeLine('1 DISPLAY -960 540')).toEqual({ kind: 'display', x: -960, y: 540 });
    expect(parseFullscreenProbeLine('1 CLEAR')).toEqual({ kind: 'clear' });
    expect(parseFullscreenProbeLine('1 UNKNOWN')).toEqual({ kind: 'unknown' });
    expect(parseFullscreenProbeLine('1 GLOBAL')).toEqual({ kind: 'global' });
    for (const message of ['1 CLEAR arbitrary-title', '1 DISPLAY 1000001 0', '1 DISPLAY 0 1.5', '1 DISPLAY 0 0\n', '2 GLOBAL', '1 GLOBAL\n1 CLEAR']) {
      expect(parseFullscreenProbeLine(message)).toBeNull();
    }
  });

  it('executes only the fixed digest-matching helper and reuses one child for subsequent polls', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pet-fullscreen-probe-')));
    try {
      const directory = join(root, 'native', 'fullscreen');
      await mkdir(directory, { recursive: true });
      const executable = join(directory, 'fullscreen-probe.exe');
      const bytes = 'synthetic helper';
      await writeFile(executable, bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const emitter = new EventEmitter();
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const kill = vi.fn(() => { queueMicrotask(() => emitter.emit('close')); return true; });
      const child = Object.assign(emitter, { stdin, stdout, stderr, kill }) as unknown as ChildProcessWithoutNullStreams;
      const spawnProcess = vi.fn(() => child);
      const wrong = new WindowsFullscreenProbe({ resourcesDirectory: root, expectedSha256: 'a'.repeat(64), platform: 'win32', spawnProcess });
      const noProbe = new WindowsFullscreenProbe({ resourcesDirectory: root, expectedSha256: null, platform: 'win32', spawnProcess });
      const signal = new AbortController().signal;
      expect(await wrong.sample(signal)).toEqual({ kind: 'unavailable' });
      expect(await noProbe.sample(signal)).toEqual({ kind: 'unavailable' });
      expect(spawnProcess).not.toHaveBeenCalled();

      const requests: string[] = [];
      stdin.on('data', (chunk: Buffer) => {
        requests.push(chunk.toString('ascii'));
        if (requests.length === 1) {
          stdout.write('1 DISPLAY -900');
          stdout.write(' 300\r\n');
        } else stdout.write('1 CLEAR\n');
      });
      const probe = new WindowsFullscreenProbe({ resourcesDirectory: root, expectedSha256: digest, platform: 'win32', spawnProcess });
      expect(await probe.sample(signal)).toEqual({ kind: 'display', x: -900, y: 300 });
      expect(await probe.sample(signal)).toEqual({ kind: 'clear' });
      expect(requests).toEqual(['?', '?']);
      expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(executable, [], expect.objectContaining({ cwd: directory, shell: false, windowsHide: true }));
      probe.stop();
      expect(kill).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
