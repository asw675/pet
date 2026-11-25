import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { VoiceErrorCode } from '../../../../../packages/contracts/src/voice.js';

export class LocalVoiceProviderError extends Error {
  constructor(readonly code: VoiceErrorCode) { super(code); this.name = 'LocalVoiceProviderError'; }
}

/** A child that did not confirm exit may still own its input/output files.
 * The caller must quarantine this single-flight channel and defer deletion
 * until the actual close; kill() merely requests termination. */
export class UnconfirmedVoiceExit extends LocalVoiceProviderError {
  constructor(code: VoiceErrorCode, readonly closed: Promise<void>) { super(code); }
}

export function voiceAbortError(signal: AbortSignal): LocalVoiceProviderError {
  const reason: unknown = signal.reason;
  return reason instanceof LocalVoiceProviderError ? reason : new LocalVoiceProviderError('canceled');
}
export function checkVoiceAbort(signal: AbortSignal): void {
  if (signal.aborted) throw voiceAbortError(signal);
}

/** Internal trusted-port spec, never a renderer/public command DTO. Only
 * fixed provider code constructs it after allowlisted binary verification. */
export interface VoiceProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: Uint8Array;
  readonly shell: false;
  readonly windowsHide: true;
}
export interface VoiceProcessObserver {
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  error(): void;
  close(code: number | null): void;
}
export interface VoiceProcessHandle { terminate(): void }
export interface VoiceProcessPort {
  /** If start throws, no child was started. Otherwise close must signify real
   * process termination and closed stdio, never a successful kill request. */
  start(spec: VoiceProcessSpec, observer: VoiceProcessObserver): VoiceProcessHandle;
}

function isolatedEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TEMP: cwd, TMP: cwd, DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(cwd, '.dotnet'), DOTNET_EnableDiagnostics: '0',
  };
  // No inherited PATH, arbitrary loader/whisper variables, credential or
  // proxy configuration. Windows system runtime variables only.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  if (systemRoot) { env.SystemRoot = systemRoot; env.WINDIR = systemRoot; }
  return env;
}

/** Real Node adapter. No search through PATH, shell strings, process tree
 * scanning or user-selected binaries. Actual invocation remains POC-gated. */
export const nodeVoiceProcessPort: VoiceProcessPort = {
  start(spec, observer) {
    const child = spawn(spec.executable, [...spec.args], { cwd: spec.cwd, env: isolatedEnvironment(spec.cwd),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (bytes: Buffer) => observer.stdout(bytes));
    child.stderr.on('data', (bytes: Buffer) => observer.stderr(bytes));
    child.once('error', () => observer.error());
    // Node documents close after the process and stdio have actually ended.
    child.once('close', code => observer.close(code));
    child.stdin.on('error', () => observer.error());
    child.stdout.on('error', () => observer.error());
    child.stderr.on('error', () => observer.error());
    child.stdin.end(spec.stdin);
    return { terminate() { try { child.kill('SIGKILL'); } catch { /* close is still required */ } } };
  },
};

export interface VoiceProcessLimits {
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly retainStdout: boolean;
  readonly overflowCode: VoiceErrorCode;
  readonly killGraceMs: number;
}
export interface VoiceProcessResult { readonly code: number; readonly stdout: Uint8Array<ArrayBuffer> }

/** Bounded bytes and explicit cancellation. Never expose raw stderr or child
 * exceptions. A timeout/cancel kills exactly this child, then awaits real
 * close or returns a quarantined failure after the short grace period. */
export function runBoundedVoiceProcess(port: VoiceProcessPort, spec: VoiceProcessSpec, limits: VoiceProcessLimits,
  signal: AbortSignal): Promise<VoiceProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(voiceAbortError(signal)); return; }
    let handle: VoiceProcessHandle | undefined;
    let failure: LocalVoiceProviderError | null = null;
    let closed = false, settled = false, killRequested = false;
    let stdoutSize = 0, stderrSize = 0;
    const chunks: Uint8Array[] = [];
    let closeResolve!: () => void;
    const actualClose = new Promise<void>(resolveClose => { closeResolve = resolveClose; });
    let grace: ReturnType<typeof setTimeout> | undefined;

    const removeListeners = () => {
      signal.removeEventListener('abort', abort);
      if (grace !== undefined) clearTimeout(grace);
      grace = undefined;
    };
    const terminate = () => {
      if (closed || killRequested || !handle) return;
      killRequested = true;
      try { handle.terminate(); } catch { /* never assume exit */ }
      if (!closed) grace = setTimeout(() => {
        if (closed || settled) return;
        settled = true; removeListeners(); chunks.length = 0;
        reject(new UnconfirmedVoiceExit(failure?.code ?? 'unavailable', actualClose));
      }, limits.killGraceMs);
    };
    const fail = (error: LocalVoiceProviderError) => {
      if (closed || failure || settled) return;
      failure = error; chunks.length = 0;
      terminate();
    };
    const abort = () => fail(voiceAbortError(signal));
    const observer: VoiceProcessObserver = {
      stdout(bytes) {
        if (closed || failure || settled) return;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxStdoutBytes - stdoutSize) {
          fail(new LocalVoiceProviderError(limits.overflowCode)); return;
        }
        stdoutSize += bytes.byteLength;
        if (limits.retainStdout) chunks.push(Uint8Array.from(bytes));
      },
      stderr(bytes) {
        if (closed || failure || settled) return;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxStderrBytes - stderrSize) { fail(new LocalVoiceProviderError('unavailable')); return; }
        stderrSize += bytes.byteLength; // deliberately never retain diagnostic text
      },
      error() { fail(new LocalVoiceProviderError('unavailable')); },
      close(code) {
        if (closed) return;
        closed = true; closeResolve(); removeListeners();
        if (settled) return;
        settled = true;
        if (failure || signal.aborted || code === null || !Number.isSafeInteger(code)) {
          reject(failure ?? (signal.aborted ? voiceAbortError(signal) : new LocalVoiceProviderError('unavailable'))); return;
        }
        const stdout = new Uint8Array(limits.retainStdout ? stdoutSize : 0);
        let offset = 0;
        for (const part of chunks) { stdout.set(part, offset); offset += part.byteLength; }
        chunks.length = 0;
        resolve({ code, stdout });
      },
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      handle = port.start(spec, observer);
      // Fake/real ports may synchronously report an error before returning
      // their handle. Do not leave a failed child running in that case.
      if (failure) terminate();
      else if (signal.aborted) abort();
    } catch {
      if (settled) return;
      settled = true; closed = true; closeResolve(); removeListeners();
      reject(failure ?? (signal.aborted ? voiceAbortError(signal) : new LocalVoiceProviderError('unavailable')));
    }
  });
}
