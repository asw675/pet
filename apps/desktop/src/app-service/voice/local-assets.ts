import { createHash } from 'node:crypto';
import { open, lstat, realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkVoiceAbort, LocalVoiceProviderError, voiceAbortError } from './local-process';

const MIB = 1024 * 1024;
export const WHISPER_CPP_RELEASE = 'v1.9.2'; // chosen release; binary packaging remains pending
export const WHISPER_MODEL_SOURCE_COMMIT = 'fb5ed9369c26eaf08392504d8446da431e0fffb9';

/** SHA-256 verified against the upstream ggerganov/whisper.cpp model repo's
 * pinned immutable pointers (both ggml-base.bin and ggml-small.bin):
 * https://huggingface.co/ggerganov/whisper.cpp/tree/fb5ed9369c26eaf08392504d8446da431e0fffb9
 * No network/download logic in a voice request. */
export const LOCAL_WHISPER_MODELS = Object.freeze({
  MULTILINGUAL_BASE: Object.freeze({ file: 'ggml-base.bin', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', maxBytes: 160 * MIB }),
  MULTILINGUAL_SMALL: Object.freeze({ file: 'ggml-small.bin', sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', maxBytes: 512 * MIB }),
});
export type LocalWhisperModelId = keyof typeof LOCAL_WHISPER_MODELS;
export const WHISPER_EXECUTABLE = 'win-x64/whisper-cli.exe';
export const SAPI_EXECUTABLE = 'win-x64/pet-desktop-sapi.exe';
export const RECORDING_FILENAME = 'input.wav';
export const TRANSCRIPT_BASENAME = 'transcription';
export const TRANSCRIPT_FILENAME = `${TRANSCRIPT_BASENAME}.txt`;
export const MAX_WHISPER_EXECUTABLE_BYTES = 128 * MIB;
export const MAX_SAPI_EXECUTABLE_BYTES = 192 * MIB;
export const validVoiceDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export interface VoiceWorkspace {
  /** Absolute trusted directory created exclusively for this invocation. */
  readonly directory: string;
  writeRecording(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Poll only the fixed result filename while the trusted CLI runs; a
   * missing not-yet-created result is allowed, oversized output is not. */
  checkTranscriptBudget(maxBytes: number, signal: AbortSignal): Promise<void>;
  readTranscript(maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  dispose(): Promise<void>;
}
export interface VoiceFilePort {
  verify(root: string, relativeName: string, expectedSha256: string, maxBytes: number, signal: AbortSignal): Promise<string>;
  createWorkspace(root: string, signal: AbortSignal): Promise<VoiceWorkspace>;
}

function unavailable(): never { throw new LocalVoiceProviderError('unavailable'); }
function samePath(left: string, right: string): boolean {
  const a = resolve(left), b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function safeRelative(name: string): boolean {
  return typeof name === 'string' && !isAbsolute(name) && name.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)
    && segment !== '.' && segment !== '..' && !segment.endsWith('.'));
}
async function canonicalRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) return unavailable();
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
  const canonical = await realpath(root);
  if (!samePath(canonical, root)) return unavailable();
  return canonical;
}

async function verify(root: string, relativeName: string, digest: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  checkVoiceAbort(signal);
  if (!safeRelative(relativeName) || !validVoiceDigest(digest) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return unavailable();
  try {
    const canonical = await canonicalRoot(root);
    const file = join(canonical, ...relativeName.split('/'));
    if (!samePath(await realpath(file), file)) return unavailable();
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) return unavailable();
    checkVoiceAbort(signal);
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ino !== before.ino) return unavailable();
      const hash = createHash('sha256');
      let count = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, signal, highWaterMark: MIB })) {
        checkVoiceAbort(signal);
        count += chunk.byteLength;
        if (count > maxBytes || count > before.size) return unavailable();
        hash.update(chunk);
      }
      const after = await handle.stat(), named = await lstat(file);
      if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || named.isSymbolicLink() || named.ino !== before.ino || named.size !== before.size || named.mtimeMs !== before.mtimeMs
        || !samePath(await realpath(file), file) || hash.digest('hex') !== digest) return unavailable();
      checkVoiceAbort(signal);
      return file;
    } finally { await handle.close(); }
  } catch (error) {
    if (signal.aborted) throw voiceAbortError(signal);
    if (error instanceof LocalVoiceProviderError) throw error;
    return unavailable();
  }
}

async function readBounded(file: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  checkVoiceAbort(signal);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || !samePath(await realpath(file), file)) return unavailable();
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) return unavailable();
    // Read at most the allowed limit plus one byte even if an unexpected
    // process/file mutation grows the result after the metadata check.
    const buffer = new Uint8Array(maxBytes + 1);
    let read = 0;
    while (read < buffer.length) {
      checkVoiceAbort(signal);
      const part = await handle.read(buffer, read, buffer.length - read, read);
      if (part.bytesRead === 0) break;
      read += part.bytesRead;
    }
    if (read > maxBytes || read !== before.size) return unavailable();
    return buffer.slice(0, read);
  } finally { await handle.close(); }
}

/** Each directory is created with mkdtemp under the trusted app-only root.
 * Cleanup is restricted to that exact child directory, never a caller path,
 * broad root, arbitrary transcript name or symlink. */
async function createWorkspace(root: string, signal: AbortSignal): Promise<VoiceWorkspace> {
  checkVoiceAbort(signal);
  if (!isAbsolute(root)) return unavailable();
  // The host supplies a single app-owned root (its parent already exists).
  // Do not recursively create directories through unvalidated ancestors.
  try { await lstat(root); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    await canonicalRoot(dirname(root));
    try { await mkdir(root, { mode: 0o700 }); }
    catch (mkdirError) {
      if (!(mkdirError && typeof mkdirError === 'object' && 'code' in mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError;
    }
  }
  const canonical = await canonicalRoot(root);
  checkVoiceAbort(signal);
  const directory = await mkdtemp(join(canonical, 'job-'));
  const rel = relative(canonical, directory);
  if (dirname(directory) !== canonical || !/^job-[A-Za-z0-9]+$/u.test(basename(directory)) || rel.includes(sep)) {
    // An unexpected mkdtemp result is never a permissible cleanup target.
    return unavailable();
  }
  let disposed = false;
  const workspace: VoiceWorkspace = {
    directory,
    async writeRecording(bytes, requestSignal) {
      checkVoiceAbort(requestSignal);
      if (disposed || !samePath(await realpath(directory), directory)) return unavailable();
      await writeFile(join(directory, RECORDING_FILENAME), bytes, { mode: 0o600, flag: 'wx', signal: requestSignal });
      checkVoiceAbort(requestSignal);
    },
    async readTranscript(maxBytes, requestSignal) {
      if (disposed || !samePath(await realpath(directory), directory)) return unavailable();
      return readBounded(join(directory, TRANSCRIPT_FILENAME), maxBytes, requestSignal);
    },
    async checkTranscriptBudget(maxBytes, requestSignal) {
      checkVoiceAbort(requestSignal);
      if (disposed || !samePath(await realpath(directory), directory)) return unavailable();
      const file = join(directory, TRANSCRIPT_FILENAME);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(file), file)) return unavailable();
        if (stat.size > maxBytes) throw new LocalVoiceProviderError('invalid_text');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    },
    async dispose() {
      if (disposed) return;
      const stillRoot = await canonicalRoot(root);
      if (!samePath(stillRoot, canonical)) return unavailable();
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) return unavailable();
        await rm(directory, { recursive: true, force: false });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      disposed = true;
    },
  };
  if (signal.aborted) { await workspace.dispose(); throw voiceAbortError(signal); }
  return workspace;
}

export const nodeVoiceFilePort: VoiceFilePort = { verify, createWorkspace };
