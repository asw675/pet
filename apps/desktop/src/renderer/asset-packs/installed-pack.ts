import { version as appVersion } from '../../../package.json';
import type { PetDesktopBridge } from '../../shared/protocol';
import { resolvePack, type ResolvedPack } from '../../shared/resolve-character-pack';

export async function loadInstalledPack(bridge: PetDesktopBridge | undefined, characterId: string,
  signal: AbortSignal): Promise<ResolvedPack | null> {
  if (!bridge) return null;
  const result = await bridge.readCharacterPack(characterId);
  signal.throwIfAborted();
  if (!result.ok || result.kind !== 'read' || !result.pack) return null;
  const { manifest, assets } = result.pack;
  const byPath = new Map(assets.map(asset => [asset.path, asset.data]));
  return resolvePack(manifest, {
    paths: () => [...byPath.keys()],
    async read(path) {
      const data = byPath.get(path);
      if (data === undefined) throw new Error('Missing asset');
      return new Uint8Array(data);
    },
  }, { characterId, packVersion: manifest.packVersion, appVersion, signal });
}
