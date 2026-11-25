import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { dirname } from 'node:path';
import type { FullscreenSample } from './fullscreen-policy';
import { verifyPackagedWindowsHelper, windowsHelperEnvironment } from './trusted-windows-helper';

const unavailable: FullscreenSample = Object.freeze({ kind: 'unavailable' });
const probeLocation = ['native', 'fullscreen', 'fullscreen-probe.exe'] as const;
const maxLineBytes = 64;
const maxProbeBytes = 2 * 1024 * 1024;
const responseTimeoutMs = 600;
const failureBackoffMs = 5_000;

export function parseFullscreenProbeLine(line: string): FullscreenSample | null {
  switch (line) {
    case '1 CLEAR': return { kind: 'clear' };
    case '1 UNKNOWN': return { kind: 'unknown' };
    case '1 GLOBAL': return { kind: 'global' };
    default: {
      const match = /^1 DISPLAY (-?(?:0|[1-9][0-9]{0,6})) (-?(?:0|[1-9][0-9]{0,6}))$/u.exec(line);
      if (!match || match[0] !== line) return null;
      const x = Number(match[1]), y = Number(match[2]);
      return Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000 ? { kind: 'display', x, y } : null;
    }
  }
}

interface ProbeOptions {
  resourcesDirectory: string;
  expectedSha256: string | null;
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

interface Request {
  line: string;
  settle(value: FullscreenSample): void;
}

/** One pinned read-only companion. Replies contain a scope and optionally a
 * monitor point. The renderer cannot send requests or choose executables. */
export class WindowsFullscreenProbe {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private inFlight = false;
  private retiring = false;
  private restartAfter = 0;
  private pending: Request | undefined;

  constructor(private readonly options: ProbeOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => performance.now());
  }

  get available(): boolean { return this.platform === 'win32' && Boolean(this.options.expectedSha256); }

  async sample(signal: AbortSignal): Promise<FullscreenSample> {
    if (!this.available || signal.aborted || this.inFlight || this.retiring || this.restartAfter > this.now()) return unavailable;
    this.inFlight = true;
    try {
      const child = this.child ?? await this.start(signal);
      if (!child || signal.aborted) return unavailable;
      return await this.request(child, signal);
    } finally { this.inFlight = false; }
  }

  stop(): void {
    if (this.child) this.terminate(this.child, false);
  }

  private async start(signal: AbortSignal): Promise<ChildProcessWithoutNullStreams | undefined> {
    const path = await verifyPackagedWindowsHelper({ root: this.options.resourcesDirectory, parts: probeLocation,
      digest: this.options.expectedSha256, maxBytes: maxProbeBytes, platform: this.platform, signal });
    if (signal.aborted) return undefined;
    if (!path) {
      this.restartAfter = this.now() + failureBackoffMs;
      return undefined;
    }
    try {
      // stderr stays a drained pipe, with no inherited environment or log data.
      const options = { cwd: dirname(path), shell: false, windowsHide: true, env: windowsHelperEnvironment() };
      const child = this.options.spawnProcess ? this.options.spawnProcess(path, [], options) : spawn(path, [], options);
      this.child = child;
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => this.receive(child, chunk));
      child.stdin.on('error', () => this.terminate(child, true));
      child.stdout.on('error', () => this.terminate(child, true));
      child.on('error', () => this.terminate(child, true));
      child.once('close', () => {
        if (this.child !== child) return;
        if (!this.retiring) this.restartAfter = this.now() + failureBackoffMs;
        this.pending?.settle(unavailable);
        this.child = undefined;
        this.retiring = false;
      });
      return child;
    } catch {
      this.restartAfter = this.now() + failureBackoffMs;
      return undefined;
    }
  }

  private request(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<FullscreenSample> {
    return new Promise(resolve => {
      const abort = () => this.terminate(child, false);
      const timer = setTimeout(() => this.terminate(child, true), responseTimeoutMs);
      timer.unref();
      this.pending = { line: '', settle: value => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending = undefined;
        resolve(value);
      } };
      signal.addEventListener('abort', abort, { once: true });
      try { child.stdin.write('?'); }
      catch { this.terminate(child, true); }
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child || this.retiring) return;
    const request = this.pending;
    if (!request || chunk.length > maxLineBytes - request.line.length) { this.terminate(child, true); return; }
    request.line += chunk.toString('latin1');
    if (!request.line.includes('\n')) return;
    if (!request.line.endsWith('\n')) { this.terminate(child, true); return; }
    const value = parseFullscreenProbeLine(request.line.replace(/\r?\n$/u, ''));
    if (!value) { this.terminate(child, true); return; }
    request.settle(value);
  }

  private terminate(child: ChildProcessWithoutNullStreams, failure: boolean): void {
    if (this.child !== child || this.retiring) return;
    this.retiring = true;
    this.pending?.settle(unavailable);
    if (failure) this.restartAfter = this.now() + failureBackoffMs;
    try { child.kill(); } catch { /* Replacement waits for the close event. */ }
  }
}
