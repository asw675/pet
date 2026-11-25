import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { normalizeLocalWin32Path } from './quick-launch-policy';

function sameHostPath(left: string, right: string): boolean {
  const drive = (value: string) => value.replace(/^[a-z]:\\/u, part => part.toUpperCase());
  return drive(left) === drive(right);
}

function exactFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Main supplies the fixed packaged path and the digest compiled into its bundle. */
export async function verifyPackagedWindowsHelper(options: {
  root: string; parts: readonly string[]; digest: string | null; maxBytes: number; platform: NodeJS.Platform; signal: AbortSignal;
}): Promise<string | null> {
  const { root, parts, digest, maxBytes, platform, signal } = options;
  if (platform !== 'win32' || signal.aborted || digest === null || !/^[a-f0-9]{64}$/u.test(digest) || /^0+$/u.test(digest)
    || !isAbsolute(root) || normalize(root) !== root) return null;
  try {
    if (process.platform === 'win32' && normalizeLocalWin32Path(root) === null) return null;
    let current = root;
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (signal.aborted) return null;
      if (part !== '') current = join(current, part);
      const dir = await lstat(current, { bigint: true });
      if (!dir.isDirectory() || dir.isSymbolicLink() || !sameHostPath(await realpath(current), current)) return null;
    }
    const helper = join(root, ...parts);
    const before = await lstat(helper, { bigint: true });
    if (signal.aborted || !before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maxBytes)
      || !sameHostPath(await realpath(helper), helper)) return null;
    const handle = await open(helper, 'r');
    try {
      const initial = await handle.stat({ bigint: true });
      if (!exactFile(initial, before)) return null;
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const size = Number(initial.size);
      let offset = 0;
      while (offset < size) {
        if (signal.aborted) return null;
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (bytesRead === 0) return null;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const observed = await lstat(helper, { bigint: true });
      if (signal.aborted || !exactFile(initial, after) || !exactFile(initial, observed) || observed.isSymbolicLink()
        || !sameHostPath(await realpath(helper), helper) || hash.digest('hex') !== digest) return null;
      return helper;
    } finally { await handle.close(); }
  } catch { return null; }
}

export function windowsHelperEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  return systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {};
}
