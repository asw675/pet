import type { CgMarkViewedPayload, GalleryPage, GalleryQuery, GalleryRow, UnlockedGalleryRow } from '@pet-desktop/contracts';
import { cgAcquisitionKey } from './registry';
import type { CgAssetResult } from './registry';

export interface StampedGalleryPage {
  readonly generation: number;
  readonly queryKey: string;
  readonly gallery: GalleryPage;
}

export function usableGalleryPage(
  page: StampedGalleryPage | null, generation: number | null, queryKey: string, revision: number | null,
): GalleryPage | null {
  return page && page.generation === generation && page.queryKey === queryKey && page.gallery.revision === revision ? page.gallery : null;
}

function rowMatches(row: GalleryRow, query: GalleryQuery): boolean {
  return (query.petId === undefined || query.petId === row.petId)
    && (query.characterId === undefined || query.characterId === row.characterId)
    && (query.routeId === undefined || query.routeId === row.routeId)
    && (query.eventDefId === undefined || query.eventDefId === row.eventDefId)
    && (query.rarity === undefined || query.rarity === row.rarity)
    && (query.filter === 'ALL'
      || (query.filter === 'LOCKED' && row.unlockStatus === 'LOCKED')
      || (query.filter === 'UNLOCKED' && row.unlockStatus === 'UNLOCKED')
      || (query.filter === 'FAVORITES' && row.unlockStatus === 'UNLOCKED' && row.favorite));
}

/** A valid-shaped response must also match the actual query and observed
 * revision before the page can be stamped for renderer use. */
export function returnedGalleryMatchesQuery(page: GalleryPage, query: GalleryQuery, startingRevision: number, liveRevision: number | null): boolean {
  return page.offset === query.offset && page.limit === query.limit && page.revision >= startingRevision
    && liveRevision !== null && page.revision >= liveRevision && page.rows.every((row) => rowMatches(row, query));
}

export function exactGalleryRow(page: GalleryPage | null, candidate: UnlockedGalleryRow): UnlockedGalleryRow | undefined {
  return page?.rows.find((row): row is UnlockedGalleryRow => row.unlockStatus === 'UNLOCKED'
    && cgAcquisitionKey(row) === cgAcquisitionKey(candidate));
}

type SceneAsset = Extract<CgAssetResult, { ok: true }>['asset'];

/** Only an actually loaded verified high-resolution image for the current
 * exact acquisition and service generation may request a view marker. */
export function confirmedViewPayload(input: {
  readonly selected: UnlockedGalleryRow | null;
  readonly current: UnlockedGalleryRow | null;
  readonly selectedGeneration: number | null;
  readonly currentGeneration: number | null;
  readonly image: SceneAsset | null;
  readonly imageLoaded: boolean;
  readonly allowCommands: boolean;
}): CgMarkViewedPayload | undefined {
  const { selected, current, selectedGeneration, currentGeneration, image, imageLoaded, allowCommands } = input;
  if (!selected || !current || selectedGeneration === null || selectedGeneration !== currentGeneration
    || !allowCommands || !imageLoaded || !image || image.kind !== 'image' || current.viewedAt !== null
    || cgAcquisitionKey(selected) !== cgAcquisitionKey(current) || current.assetRef.state !== 'PINNED') return undefined;
  const { assetRef: ref } = current;
  const entry = image.entry;
  if (entry.characterId !== ref.characterId || entry.cgId !== current.cgId || entry.variant !== current.variant
    || entry.routeId !== current.routeId || entry.eventDefId !== ref.eventDefId
    || entry.assetVersion !== ref.assetVersion || entry.assetHash !== ref.assetHash) return undefined;
  return {
    petId: current.petId, cgId: current.cgId, variant: current.variant, characterId: ref.characterId,
    eventDefId: ref.eventDefId, assetVersion: ref.assetVersion, assetHash: ref.assetHash,
  };
}
