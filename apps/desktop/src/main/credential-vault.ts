import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { idSchema } from '@pet-desktop/contracts';
import { credentialRefSchema } from '@pet-desktop/contracts/ai';
import { z } from 'zod';

const maximumCipherBytes = 64 * 1024;
const secretSchema = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u);
const envelopeSchema = z.strictObject({ version: z.literal(1), providerId: idSchema, credentialRef: credentialRefSchema, secret: secretSchema });
type CredentialEnvelope = z.infer<typeof envelopeSchema>;

/** Main's real port is Electron safeStorage asynchronous API, after ready.
 * Test injection never processes real credentials. No plaintext fallback. */
export interface CredentialEncryptionPort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

/** Main-only encrypted vault. No renderer read/list-secret method; callers
 * must already bind provider identity and explicit user-approved config. */
export class CredentialVault {
  private operation: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly encryption: CredentialEncryptionPort, private readonly platform: NodeJS.Platform = process.platform) {
    if (!isAbsolute(root)) throw new Error('Credential root must be app-owned absolute directory');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operation.then(fn, fn);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async available(): Promise<boolean> {
    try {
      if (this.platform !== 'win32' && this.platform !== 'darwin' && this.platform !== 'linux') return false;
      // Electron's Linux basic_text fallback is not suitable for secrets.
      if (this.platform === 'linux') {
        const backend = this.encryption.getSelectedStorageBackend?.();
        if (!backend || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) return false;
      }
      return await this.encryption.isAsyncEncryptionAvailable() === true;
    } catch { return false; }
  }

  private filename(providerId: string, credentialRef: string): string | null {
    if (!idSchema.safeParse(providerId).success || !credentialRefSchema.safeParse(credentialRef).success) return null;
    const digest = createHash('sha256').update(JSON.stringify([providerId, credentialRef])).digest('hex');
    return join(this.root, `${digest}.enc`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid vault directory');
  }

  private async writeCipher(path: string, encrypted: Buffer): Promise<void> {
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > maximumCipherBytes) throw new Error('Invalid encrypted credential');
    await this.ensureDirectory();
    const temporary = join(this.root, `${randomUUID()}.pending`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, path);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async readCipher(path: string): Promise<Buffer> {
    await this.ensureDirectory();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximumCipherBytes) throw new Error('Invalid vault file');
    const handle = await open(path, 'r');
    try {
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new Error('Credential file changed');
      const buffer = Buffer.alloc(after.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const read = await handle.read(buffer, total, buffer.length - total, total);
        if (read.bytesRead === 0) break;
        total += read.bytesRead;
      }
      if (total !== after.size) throw new Error('Credential size changed');
      return buffer.subarray(0, total);
    } finally { await handle.close(); }
  }

  /** Called only after explicit user credential save; returns status only. */
  save(providerId: string, credentialRef: string, secret: unknown): Promise<boolean> {
    return this.serial(async () => {
      const filename = this.filename(providerId, credentialRef);
      const parsed = envelopeSchema.safeParse({ version: 1, providerId, credentialRef, secret });
      if (!filename || !parsed.success || !await this.available()) return false;
      try {
        const encrypted = await this.encryption.encryptStringAsync(JSON.stringify(parsed.data));
        await this.writeCipher(filename, encrypted); return true;
      } catch { return false; }
    });
  }

  /** Trusted provider broker only. Never expose returned value as IPC result
   * to a renderer or include it in a log, prompt, configuration or memory. */
  resolve(providerId: string, credentialRef: string): Promise<string | null> {
    return this.serial(async () => {
      const filename = this.filename(providerId, credentialRef);
      if (!filename || !await this.available()) return null;
      try {
        const encrypted = await this.readCipher(filename);
        let decrypted = await this.encryption.decryptStringAsync(encrypted);
        const needsRotation = decrypted.shouldReEncrypt;
        if (needsRotation) decrypted = await this.encryption.decryptStringAsync(encrypted);
        if (typeof decrypted.result !== 'string' || decrypted.result.length > 12_000) return null;
        const parsed = envelopeSchema.safeParse(JSON.parse(decrypted.result));
        if (!parsed.success || parsed.data.providerId !== providerId || parsed.data.credentialRef !== credentialRef) return null;
        const record: CredentialEnvelope = parsed.data;
        // Rewrite with the current OS key only when decryption explicitly
        // indicated rotation. Failure is conservative: do not send the key.
        if (needsRotation || decrypted.shouldReEncrypt) await this.writeCipher(filename, await this.encryption.encryptStringAsync(JSON.stringify(record)));
        return record.secret;
      } catch { return null; }
    });
  }

  /** Explicit revoke, no other files touched. Missing is already revoked. */
  revoke(providerId: string, credentialRef: string): Promise<boolean> {
    return this.serial(async () => {
      const filename = this.filename(providerId, credentialRef);
      if (!filename) return false;
      try { await this.ensureDirectory(); await unlink(filename); return true; }
      catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
    });
  }
}
