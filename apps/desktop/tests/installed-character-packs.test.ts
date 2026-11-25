import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { InstalledCharacterPacks } from '../src/main/installed-character-packs';
import { createControlCenterBridge, createPetBridge } from '../src/preload/bridge';
import type { DesktopIpcPort } from '../src/preload/bridge';
import { characterPackResultSchema } from '../src/shared/character-pack-ipc';
import { DESKTOP_IPC } from '../src/shared/protocol';
import { loadInstalledPack } from '../src/renderer/asset-packs/installed-pack';

const fixture = fileURLToPath(new URL('../src/renderer/asset-packs/builtin/star-singer/', import.meta.url));
let scratch: string;
let userData: string;
let source: string;
let store: InstalledCharacterPacks;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'pet-pack-test-'));
  source = join(scratch, 'source');
  userData = join(scratch, 'user-data');
  await Promise.all([cp(fixture, source, { recursive: true }), mkdir(userData)]);
  store = new InstalledCharacterPacks(userData, '0.0.0');
  await rewriteManifest(manifest => { manifest.packVersion = '1.1.0'; });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function rewriteManifest(update: (manifest: {
  packVersion: string;
  displayName: Record<string, string>;
  variants: { renderer: string; entry: string }[];
  license: { owner: string };
  files: { path: string; bytes: number; sha256: string }[];
}) => void): Promise<void> {
  const path = join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  update(manifest);
  await writeFile(path, JSON.stringify(manifest));
}

describe('installed character pack storage', () => {
  test('installs a validated immutable version, reloads it by character and switches to prior versions', async () => {
    expect((await store.list())[0]).toMatchObject({ characterId: 'star-singer', activeVersion: '1.0.1', installedVersions: [] });
    expect(await store.readActive('star-singer')).toBeNull();
    const first = await store.prepare(source);
    await store.install(first);
    await store.install(first); // A retry with identical resources is safe.
    await rewriteManifest(manifest => { manifest.packVersion = '1.2.0'; });
    await store.install(await store.prepare(source));

    const restarted = new InstalledCharacterPacks(userData, '0.0.0');
    expect((await restarted.list())[0]).toMatchObject({ activeVersion: '1.2.0', installedVersions: ['1.2.0', '1.1.0'] });
    await restarted.activate({ characterId: 'star-singer', packVersion: '1.1.0' });
    const asset = await restarted.readActive('star-singer');
    expect(asset?.manifest.packVersion).toBe('1.1.0');
    expect(asset?.assets).toHaveLength(first.manifest.files.length);
    expect(characterPackResultSchema.safeParse({ ok: true, kind: 'read', pack: asset }).success).toBe(true);
    await restarted.activate({ characterId: 'star-singer', packVersion: '1.0.1' });
    expect(await restarted.readActive('star-singer')).toBeNull();
    expect((await restarted.list())[0]?.installedVersions).toEqual(['1.2.0', '1.1.0']);
    expect(await restarted.readActive('nova')).toBeNull();
  });

  test('never overwrites a version or switches to an invalid candidate', async () => {
    await store.install(await store.prepare(source));
    await rewriteManifest(manifest => { manifest.license.owner = 'Different author'; });
    await expect(store.install(await store.prepare(source))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(store.activate({ characterId: 'star-singer', packVersion: '2.0.0' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.readActive('star-singer'))?.manifest.license.owner).not.toBe('Different author');
    await writeFile(join(userData, 'character-packs', 'star-singer', '1.1.0', 'assets', 'idle.png'), 'invalid');
    expect(await store.readActive('star-singer')).toBeNull();
    await expect(store.activate({ characterId: 'star-singer', packVersion: '1.1.0' })).rejects.toMatchObject({ code: 'INVALID_PACK' });
  });

  test('rejects extra files and out of directory assets', async () => {
    const extra = join(source, 'assets', 'ignored.txt');
    await writeFile(extra, 'extra asset');
    await expect(store.prepare(source)).rejects.toMatchObject({ code: 'INVALID_PACK' });
    await rm(extra);
    await rewriteManifest(manifest => { manifest.files[0]!.path = 'assets/../../other.png'; });
    await expect(store.prepare(source)).rejects.toMatchObject({ code: 'INVALID_PACK' });
  });

  test('rejects a directory junction or symlink even when its contents match expected hashes', async ({ skip }) => {
    const assets = join(source, 'assets');
    const other = join(scratch, 'outside');
    await cp(assets, other, { recursive: true });
    await rm(assets, { recursive: true });
    try { await symlink(other, assets, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('This Windows environment does not permit creating a test junction');
        return;
      }
      throw error;
    }
    await expect(store.prepare(source)).rejects.toMatchObject({ code: 'INVALID_PACK' });
  });

  test('rejects mismatched bytes with the same declared length', async () => {
    const file = join(source, 'assets', 'thumbnail.png');
    const original = await readFile(file);
    const after = Buffer.from(original);
    after[after.length - 1] = after[after.length - 1]! ^ 1;
    expect(createHash('sha256').update(after).digest('hex')).not.toBe(createHash('sha256').update(original).digest('hex'));
    await writeFile(file, after);
    await expect(store.prepare(source)).rejects.toMatchObject({ code: 'INVALID_PACK' });
  });
});

test('preload exposes separate pathless capabilities and the renderer reads typed data for its own character', async () => {
  await store.install(await store.prepare(source));
  const calls: unknown[][] = [];
  const port: DesktopIpcPort = {
    async invoke(channel, request) {
      calls.push([channel, request]);
      return { ok: true, kind: 'read', pack: await store.readActive('star-singer') };
    },
    on() {},
    removeListener() {},
  };
  const pet = createPetBridge(port);
  const center = createControlCenterBridge(port);
  expect(pet).not.toHaveProperty('importCharacterPack');
  expect(center).not.toHaveProperty('readCharacterPack');
  expect(await pet.readCharacterPack('assets/../../outside')).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  expect(calls).toEqual([]);
  const resolved = await loadInstalledPack(pet, 'star-singer', new AbortController().signal);
  expect(resolved?.manifest.packVersion).toBe('1.1.0');
  expect(calls).toEqual([[DESKTOP_IPC.characterPackRequest, { kind: 'read', characterId: 'star-singer' }]]);
  expect(await pet.readCharacterPack('nova')).toEqual({ ok: false, code: 'STORAGE_ERROR' });
});

test('loads the new Star Singer portrait including its original provenance chunk', async () => {
  const preview = fileURLToPath(new URL('../content-packs/star-singer-1.1.0/', import.meta.url));
  const prepared = await store.prepare(preview);
  expect(prepared.manifest).toMatchObject({ characterId: 'star-singer', packVersion: '1.1.0' });
  expect(prepared.variants[0]).toMatchObject({ renderer: 'static', imageSize: { w: 1024, h: 1536 } });
  await store.install(prepared);
  expect((await store.readActive('star-singer'))?.assets[0]?.data.byteLength).toBe(prepared.manifest.files[0]?.bytes);
});

test('installs a normalized Cubism Editor export and sends verified model data to the sandbox', async () => {
  const exportDir = join(scratch, 'Editor Export');
  const textures = join(exportDir, 'Star.2048');
  const modelPath = join(exportDir, 'Star.model3.json');
  const output = join(scratch, 'star-singer-1.2.0');
  await mkdir(textures, { recursive: true });
  const moc = Buffer.alloc(64); // This is a pack-transfer fixture, not an SDK-loadable model.
  moc.write('MOC3');
  await Promise.all([
    writeFile(join(exportDir, 'Star.moc3'), moc),
    cp(join(source, 'assets', 'thumbnail.png'), join(textures, 'Texture.00.png')),
    writeFile(modelPath, JSON.stringify({ Version: 3, FileReferences: { Moc: 'Star.moc3', Textures: ['Star.2048/Texture.00.png'] } })),
  ]);
  const helper = fileURLToPath(new URL('../scripts/prepare-cubism-pack.mjs', import.meta.url));
  execFileSync(process.execPath, [helper, modelPath, output, '1.2.0']);
  await store.install(await store.prepare(output));
  const pet = createPetBridge({
    async invoke() { return { ok: true, kind: 'read', pack: await store.readActive('star-singer') }; },
    on() {}, removeListener() {},
  });
  const model = await loadInstalledPack(pet, 'star-singer', new AbortController().signal);
  expect(model?.manifest.packVersion).toBe('1.2.0');
  expect(model?.variants.map(item => item.renderer)).toEqual(['cubism', 'static']);
  expect(model?.variants[0]).toMatchObject({ model: { textures: ['assets/live2d/textures/texture-1.png'] } });
  expect(model?.readAsset('assets/live2d/star-singer.moc3')).toEqual(new Uint8Array(moc));
});

test('offers the bundled preview without switching the saved appearance or requiring an import', async () => {
  const catalog = fileURLToPath(new URL('../content-packs/', import.meta.url));
  const withPreview = new InstalledCharacterPacks(userData, '0.0.0', catalog);
  expect((await withPreview.list())[0]).toMatchObject({ activeVersion: '1.0.1', installedVersions: ['1.1.0'] });
  expect(await withPreview.readActive('star-singer')).toBeNull();
  await withPreview.activate({ characterId: 'star-singer', packVersion: '1.1.0' });
  expect((await withPreview.readActive('star-singer'))?.manifest.packVersion).toBe('1.1.0');
  await withPreview.activate({ characterId: 'star-singer', packVersion: '1.0.1' });
  expect(await withPreview.readActive('star-singer')).toBeNull();
});
