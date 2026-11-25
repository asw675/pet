import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { characterPackManifestSchema, packVersionSchema } from '@pet-desktop/contracts';
import {
  builtinCharacterIds, builtinCharacterIdSchema, builtinPackVersion, characterPackChangedSchema, comparePackVersions, maxInstalledPackVersions,
  type BuiltinCharacterId, type CharacterPackChanged, type CharacterPackFailure, type CharacterPackRow, type CharacterPackTransfer,
} from '../shared/character-pack-ipc';
import { PackResolveError, resolvePack, type ResolvedPack } from '../shared/resolve-character-pack';

const manifestName = 'manifest.json';
const selectionName = 'active.json';
const manifestLimit = 256 * 1024;
const starSingerPreview = Object.freeze({ characterId: 'star-singer', packVersion: '1.1.0' } satisfies CharacterPackChanged);

export class CharacterPackStoreError extends Error {
  constructor(readonly code: CharacterPackFailure) {
    super(code);
    this.name = 'CharacterPackStoreError';
  }
}

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function verifiedDirectory(path: string): Promise<string> {
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new CharacterPackStoreError('INVALID_PACK');
  return realpath(path);
}

async function boundedFile(path: string, limit: number, exact?: number): Promise<Uint8Array<ArrayBuffer>> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > limit
    || (exact !== undefined && entry.size !== exact)) throw new CharacterPackStoreError('INVALID_PACK');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino || current.size !== entry.size) {
      throw new CharacterPackStoreError('INVALID_PACK');
    }
    const data = new Uint8Array(current.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesRead } = await file.read(data, offset, data.byteLength - offset, offset);
      if (bytesRead === 0) throw new CharacterPackStoreError('INVALID_PACK');
      offset += bytesRead;
    }
    if ((await file.stat()).size !== data.byteLength) throw new CharacterPackStoreError('INVALID_PACK');
    return data;
  } finally { await file.close(); }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function checkDirectoryContents(root: string, files: readonly string[]): Promise<void> {
  const directories = new Map<string, Map<string, 'directory' | 'file'>>([['', new Map([[manifestName, 'file']])]]);
  for (const path of files) {
    const names = path.split('/');
    let parent = '';
    for (const [index, name] of names.entries()) {
      const children = directories.get(parent)!;
      const child = parent ? parent + '/' + name : name;
      const type = index === names.length - 1 ? 'file' : 'directory';
      const seen = children.get(name);
      if (seen && seen !== type) throw new CharacterPackStoreError('INVALID_PACK');
      children.set(name, type);
      if (type === 'directory' && !directories.has(child)) directories.set(child, new Map());
      parent = child;
    }
  }
  for (const [folder, expected] of directories) {
    const path = join(root, folder);
    if (await verifiedDirectory(path) !== path) throw new CharacterPackStoreError('INVALID_PACK');
    const directory = await opendir(path);
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > expected.size) throw new CharacterPackStoreError('INVALID_PACK');
      const type = expected.get(entry.name);
      if (entry.isSymbolicLink() || (type === 'file' ? !entry.isFile() : type !== 'directory' || !entry.isDirectory())) {
        throw new CharacterPackStoreError('INVALID_PACK');
      }
    }
    if (entries !== expected.size) throw new CharacterPackStoreError('INVALID_PACK');
  }
}

async function verifyPack(directory: string, appVersion: string, expected?: CharacterPackChanged): Promise<ResolvedPack> {
  try {
    const root = await verifiedDirectory(directory);
    const manifest = characterPackManifestSchema.parse(parseJson(await boundedFile(join(root, manifestName), manifestLimit)));
    const id = builtinCharacterIdSchema.safeParse(manifest.characterId);
    if (!id.success || manifest.cgIds.length > 0) throw new CharacterPackStoreError('UNSUPPORTED_PACK');
    if (expected && (manifest.characterId !== expected.characterId || manifest.packVersion !== expected.packVersion)) {
      throw new CharacterPackStoreError('INVALID_PACK');
    }
    const sizes = new Map(manifest.files.map(file => [file.path, file.bytes]));
    const paths = [...sizes.keys()];
    await checkDirectoryContents(root, paths);
    return await resolvePack(manifest, {
      paths: () => paths,
      read: async (path, signal) => {
        signal.throwIfAborted();
        const size = sizes.get(path);
        if (size === undefined) throw new CharacterPackStoreError('INVALID_PACK');
        return boundedFile(join(root, path), size, size);
      },
    }, { characterId: id.data, packVersion: manifest.packVersion, appVersion });
  } catch (error) {
    if (error instanceof CharacterPackStoreError) throw error;
    if (error instanceof PackResolveError && (error.code === 'UNSUPPORTED_FORMAT' || error.code === 'INCOMPATIBLE_APP')) {
      throw new CharacterPackStoreError('UNSUPPORTED_PACK');
    }
    throw new CharacterPackStoreError('INVALID_PACK');
  }
}

async function writeNewFile(path: string, data: Uint8Array | string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally { await file.close(); }
}

export class InstalledCharacterPacks {
  constructor(private readonly userData: string, private readonly appVersion: string, private readonly bundledPacks?: string) {}

  private async characterDirectory(characterId: BuiltinCharacterId, create = false): Promise<string | undefined> {
    const parent = await realpath(this.userData);
    const store = join(parent, 'character-packs');
    if (create) await mkdir(store, { recursive: true });
    if (!await statIfPresent(store)) return undefined;
    await verifiedDirectory(store);
    const directory = join(store, characterId);
    if (create) await mkdir(directory, { recursive: true });
    return await statIfPresent(directory) ? verifiedDirectory(directory) : undefined;
  }

  private async storedSelection(directory: string, characterId: BuiltinCharacterId): Promise<string | undefined> {
    const path = join(directory, selectionName);
    try {
      if (!await statIfPresent(path)) return undefined;
      const selection = characterPackChangedSchema.parse(parseJson(await boundedFile(path, 1024)));
      return selection.characterId === characterId ? selection.packVersion : undefined;
    } catch { return undefined; }
  }

  private async versions(directory: string | undefined, characterId: BuiltinCharacterId): Promise<string[]> {
    const builtIn = builtinPackVersion(characterId)!;
    const entries = directory ? await readdir(directory, { withFileTypes: true }) : [];
    const versions = new Set(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
      && packVersionSchema.safeParse(entry.name).success && comparePackVersions(entry.name, builtIn) > 0)
      .map(entry => entry.name));
    if (characterId === starSingerPreview.characterId && await this.bundledPath(starSingerPreview)) versions.add(starSingerPreview.packVersion);
    return [...versions].sort((a, b) => comparePackVersions(b, a));
  }

  private async bundledPath(change: CharacterPackChanged): Promise<string | undefined> {
    if (!this.bundledPacks || change.characterId !== starSingerPreview.characterId || change.packVersion !== starSingerPreview.packVersion) {
      return undefined;
    }
    const path = join(this.bundledPacks, `${change.characterId}-${change.packVersion}`);
    const stat = await statIfPresent(path);
    return stat?.isDirectory() && !stat.isSymbolicLink() ? path : undefined;
  }

  async list(): Promise<CharacterPackRow[]> {
    return Promise.all(builtinCharacterIds.map(async characterId => {
      const builtinVersion = builtinPackVersion(characterId)!;
      const directory = await this.characterDirectory(characterId);
      const installedVersions = (await this.versions(directory, characterId)).slice(0, maxInstalledPackVersions);
      const saved = directory ? await this.storedSelection(directory, characterId) : undefined;
      const activeVersion = saved && installedVersions.includes(saved) ? saved : builtinVersion;
      return { characterId, builtinVersion, activeVersion, installedVersions };
    }));
  }

  async prepare(directory: string): Promise<ResolvedPack> {
    return verifyPack(directory, this.appVersion);
  }

  async install(pack: ResolvedPack): Promise<CharacterPackChanged> {
    const characterId = builtinCharacterIdSchema.parse(pack.manifest.characterId);
    const packVersion = pack.manifest.packVersion;
    const builtinVersion = builtinPackVersion(characterId)!;
    if (comparePackVersions(packVersion, builtinVersion) <= 0) throw new CharacterPackStoreError('VERSION_CONFLICT');
    const change = { characterId, packVersion };
    const directory = (await this.characterDirectory(characterId, true))!;
    const destination = join(directory, packVersion);
    const existingPath = await this.bundledPath(change) ?? (await statIfPresent(destination) ? destination : undefined);
    if (existingPath) {
      const existing = await verifyPack(existingPath, this.appVersion, change);
      if (JSON.stringify(existing.manifest) !== JSON.stringify(pack.manifest)) throw new CharacterPackStoreError('VERSION_CONFLICT');
      return this.select(directory, change);
    }
    if ((await this.versions(directory, characterId)).length >= maxInstalledPackVersions) {
      throw new CharacterPackStoreError('LIMIT_REACHED');
    }

    const stage = await mkdtemp(join(directory, '.install-'));
    try {
      const folders = new Set<string>();
      for (const file of pack.manifest.files) {
        const bytes = pack.readAsset(file.path);
        if (!bytes) throw new CharacterPackStoreError('INVALID_PACK');
        const folder = file.path.slice(0, file.path.lastIndexOf('/'));
        if (!folders.has(folder)) {
          await mkdir(join(stage, folder), { recursive: true });
          folders.add(folder);
        }
        await writeNewFile(join(stage, file.path), bytes);
      }
      await writeNewFile(join(stage, manifestName), JSON.stringify(pack.manifest));
      // One host owns this directory. The complete immutable version becomes visible together.
      await rename(stage, destination);
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    return this.select(directory, change);
  }

  async activate(input: CharacterPackChanged): Promise<CharacterPackChanged> {
    const change = characterPackChangedSchema.parse(input);
    const builtIn = builtinPackVersion(change.characterId);
    const bundled = await this.bundledPath(change);
    const directory = await this.characterDirectory(change.characterId, change.packVersion === builtIn || bundled !== undefined);
    if (!directory) throw new CharacterPackStoreError('NOT_FOUND');
    if (change.packVersion !== builtIn) {
      const candidate = bundled ?? join(directory, change.packVersion);
      if (!await statIfPresent(candidate)) throw new CharacterPackStoreError('NOT_FOUND');
      await verifyPack(candidate, this.appVersion, change);
    }
    return this.select(directory, change);
  }

  async readActive(characterId: BuiltinCharacterId): Promise<CharacterPackTransfer | null> {
    const directory = await this.characterDirectory(characterId);
    if (!directory) return null;
    const packVersion = await this.storedSelection(directory, characterId);
    if (!packVersion || comparePackVersions(packVersion, builtinPackVersion(characterId)!) <= 0) return null;
    try {
      const change = { characterId, packVersion };
      const candidate = await this.bundledPath(change) ?? join(directory, packVersion);
      const pack = await verifyPack(candidate, this.appVersion, change);
      return {
        manifest: pack.manifest,
        assets: pack.manifest.files.map(file => ({ path: file.path, data: pack.readAsset(file.path)!.buffer })),
      };
    } catch (error) {
      if (error instanceof CharacterPackStoreError && ['INVALID_PACK', 'UNSUPPORTED_PACK'].includes(error.code)) return null;
      throw error;
    }
  }

  private async select(directory: string, change: CharacterPackChanged): Promise<CharacterPackChanged> {
    const temporary = join(directory, '.active-' + randomUUID());
    try {
      await writeNewFile(temporary, JSON.stringify(change));
      await rename(temporary, join(directory, selectionName));
    } finally { await unlink(temporary).catch(() => {}); }
    return change;
  }
}
