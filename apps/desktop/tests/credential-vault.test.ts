import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialVault } from '../src/main/credential-vault';
import type { CredentialEncryptionPort } from '../src/main/credential-vault';

const temp: string[] = [];
afterEach(async () => { for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true }); });
// Real authenticated encryption for temporary fixtures, NOT the production
// key vault; no user keys or OS secret store are touched.
function encryption(available = true): CredentialEncryptionPort {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => available,
    async encryptStringAsync(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    async decryptStringAsync(blob) { const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); cipher.setAuthTag(blob.subarray(-16));
      return { result: Buffer.concat([cipher.update(blob.subarray(12, -16)), cipher.final()]).toString('utf8'), shouldReEncrypt: false }; },
  };
}
async function setup(port = encryption(), platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'pet-credential-test-')); temp.push(root);
  return { root, vault: new CredentialVault(root, port, platform), port };
}
const fake = 'synthetic-test-key-not-real';
describe('Main-only encrypted provider credential vault', () => {
  it('persists encrypted bytes only and resolves exact provider-bound reference after recreating vault', async () => {
    const { root, vault, port } = await setup();
    expect(await vault.save('provider-a', 'credential:a', fake)).toBe(true);
    const files = await readdir(root); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[0-9a-f]{64}\.enc$/u);
    expect((await readFile(join(root, files[0]!))).includes(Buffer.from(fake))).toBe(false);
    expect(await new CredentialVault(root, port, 'darwin').resolve('provider-a', 'credential:a')).toBe(fake);
    expect(await vault.resolve('provider-b', 'credential:a')).toBeNull();
    expect(await vault.resolve('provider-a', 'credential:b')).toBeNull();
  });
  it('never falls back to plaintext for unavailable or basic_text secret storage', async () => {
    const inaccessible = await setup(encryption(false));
    expect(await inaccessible.vault.save('provider-a', 'credential:a', fake)).toBe(false);
    expect(await readdir(inaccessible.root)).toEqual([]);
    const weak = await setup({ ...encryption(), getSelectedStorageBackend: () => 'basic_text' }, 'linux');
    expect(await weak.vault.save('provider-a', 'credential:a', fake)).toBe(false);
    expect(await readdir(weak.root)).toEqual([]);
  });
  it('rejects malformed refs, traversal, controls, and oversized key material', async () => {
    const { vault, root } = await setup();
    for (const [provider, ref, secret] of [['../abc', 'credential:a', fake], ['a', 'credential:../file', fake], ['a', 'credential:a', 'bad\nvalue'], ['a', 'credential:a', 'a'.repeat(8193)]]) {
      expect(await vault.save(provider!, ref!, secret)).toBe(false);
    }
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects corrupt encrypted bytes and encrypted envelope copied to a different provider identity', async () => {
    const { vault, root } = await setup();
    await vault.save('provider-a', 'credential:a', fake);
    const first = (await readdir(root))[0]!; const payload = await readFile(join(root, first));
    await vault.save('provider-b', 'credential:a', 'different-fake');
    const second = (await readdir(root)).find(name => name !== first)!;
    await writeFile(join(root, second), payload);
    expect(await vault.resolve('provider-b', 'credential:a')).toBeNull();
    await writeFile(join(root, first), Buffer.from('not ciphertext'));
    expect(await vault.resolve('provider-a', 'credential:a')).toBeNull();
  });
  it('atomically replaces encrypted secret and serializes explicit revoke against a concurrent save', async () => {
    const { vault, root } = await setup();
    expect(await vault.save('a', 'credential:a', fake)).toBe(true);
    expect(await vault.save('a', 'credential:a', 'new-synthetic-key')).toBe(true);
    expect(await readdir(root)).toHaveLength(1);
    expect(await vault.resolve('a', 'credential:a')).toBe('new-synthetic-key');
    const operations = [vault.save('a', 'credential:a', fake), vault.revoke('a', 'credential:a')];
    expect(await Promise.all(operations)).toEqual([true, true]);
    expect(await vault.resolve('a', 'credential:a')).toBeNull();
    expect(await vault.revoke('a', 'credential:a')).toBe(true);
  });
});
