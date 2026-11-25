import { cgAssetRefSchema, galleryPageSchema } from '@pet-desktop/contracts';
import type { GalleryPage, GalleryQuery, GalleryRow, LockedGalleryRow, PinnedCgAssetRef, UnlockedGalleryRow } from '@pet-desktop/contracts';
import type { TripSnapshot } from '@pet-desktop/domain';
import { BUILTIN_CG_CATALOG, EVENT_CG_CATALOG, findBuiltinCg, findBuiltinEventCg } from '@pet-desktop/domain/cg-catalog';
import type { CgCatalogEntry } from '@pet-desktop/domain/cg-catalog';
import type { AppTransaction, CgUnlock, EventCgUnlock, PetRecord, TripCgAssetPin } from './ports.js';

export const TRIP_CG_VARIANT = 'default';

function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function pinnedRef(entry: CgCatalogEntry): PinnedCgAssetRef | undefined {
  const parsed = cgAssetRefSchema.safeParse({
    state: 'PINNED', characterId: entry.characterId, eventDefId: entry.eventDefId,
    assetVersion: entry.assetVersion, assetHash: entry.assetHash,
  });
  return parsed.success && parsed.data.state === 'PINNED' ? parsed.data : undefined;
}

/**
 * A trip records the content identities it can possibly unlock before it starts.
 * The replay/reward ledger continues to use only the stable CG ID + variant;
 * changing an art catalog cannot change a deterministic trip outcome.
 */
export function freezeTripCgAssets(pet: PetRecord, snapshot: TripSnapshot): TripCgAssetPin[] {
  if (snapshot.petId !== pet.petId) throw new Error('Trip CG identity does not match pet');
  const pins = new Map<string, TripCgAssetPin>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'EVENT') continue;
    const previous = pins.get(node.cgId);
    if (previous) {
      // The V1 ledger can represent each CG/variant once per trip; it must not
      // ambiguously bind the same reward to two different event definitions.
      if (previous.eventDefId !== node.eventDefId) throw new Error('Ambiguous trip CG identity');
      continue;
    }
    const entry = findBuiltinCg(pet.characterId, node.cgId, TRIP_CG_VARIANT);
    const ref = entry && entry.routeId === snapshot.routeId && entry.eventDefId === node.eventDefId
      ? pinnedRef(entry) : undefined;
    pins.set(node.cgId, {
      tripId: snapshot.tripId, petId: pet.petId, characterId: pet.characterId,
      cgId: node.cgId, variant: TRIP_CG_VARIANT, eventDefId: node.eventDefId,
      assetRef: ref ?? { state: 'UNAVAILABLE_AT_DEPARTURE' },
    });
  }
  return [...pins.values()].sort((a, b) => compareIds(a.cgId, b.cgId));
}

/** Closed public summary. A locked CG cannot receive an asset identity. */
function lockedRow(pet: PetRecord, entry: CgCatalogEntry): LockedGalleryRow {
  return {
    petId: pet.petId, characterId: pet.characterId, cgId: entry.cgId, variant: entry.variant,
    title: entry.title, hint: entry.hint, routeId: entry.routeId, eventDefId: entry.eventDefId,
    rarity: entry.rarity, unlockStatus: 'LOCKED',
  };
}

function unlockedRow(tx: AppTransaction, pet: PetRecord, unlock: CgUnlock): UnlockedGalleryRow {
  const trip = tx.getTrip(unlock.sourceTripId);
  if (unlock.petId !== pet.petId || !trip || trip.snapshot.petId !== pet.petId || trip.status !== 'SETTLED') {
    throw new Error('Invalid CG acquisition source');
  }
  const ref = unlock.assetRef;
  const characterId = unlock.historicalCharacterId ?? pet.characterId;
  const eventDefId = unlock.historicalEventDefId;
  const routeId = trip.snapshot.routeId;

  // Resolve only the acquisition's exact version and manifest digest. Missing
  // history must never silently borrow the newest version, title or artwork.
  let entry: CgCatalogEntry | undefined;
  if (ref.state === 'PINNED') {
    if (ref.characterId !== characterId || ref.eventDefId !== eventDefId) throw new Error('CG acquisition identity mismatch');
    const historical = findBuiltinCg(ref.characterId, unlock.cgId, unlock.variant, ref.assetVersion);
    if (historical && historical.assetHash === ref.assetHash && historical.eventDefId === ref.eventDefId
      && historical.routeId === routeId) entry = historical;
  }

  const hint = ref.state === 'LEGACY_UNVERSIONED' ? '历史记录未绑定资源版本，无法安全恢复原始画面。'
    : ref.state === 'UNAVAILABLE_AT_DEPARTURE' ? '出发时尚无此纪念画面的固定资源。'
      : '首次获得时的固定资源目前不可用，请保留历史记录。';
  return {
    petId: pet.petId, characterId, cgId: unlock.cgId, variant: unlock.variant,
    title: entry?.title ?? '历史纪念画面', hint: entry?.hint ?? hint,
    routeId, eventDefId, rarity: entry?.rarity ?? null,
    unlockStatus: 'UNLOCKED', sourceTripId: unlock.sourceTripId, unlockedAt: unlock.unlockedAt,
    favorite: unlock.favorite, viewedAt: unlock.viewedAt, assetRef: ref,
  };
}

function unlockedEventRow(tx: AppTransaction, pet: PetRecord, unlock: EventCgUnlock): UnlockedGalleryRow {
  const source = tx.getEventOccurrence(unlock.sourceEventId);
  const ref = unlock.assetRef;
  if (unlock.petId !== pet.petId || !source || source.occurrence.petId !== pet.petId || source.status === 'PENDING'
    || source.resolvedAt !== unlock.unlockedAt || source.occurrence.characterId !== unlock.historicalCharacterId
    || source.occurrence.eventId !== unlock.historicalEventDefId || ref.characterId !== unlock.historicalCharacterId
    || ref.eventDefId !== unlock.historicalEventDefId
    || !source.rewards.some(reward => reward.kind === 'CG_UNLOCK' && reward.cgId === unlock.cgId
      && reward.variant === unlock.variant && reward.newlyUnlocked)) throw new Error('Invalid event CG acquisition source');
  const pinned = source.occurrence.asset;
  if (pinned?.state !== 'PINNED' || pinned.assetVersion !== ref.assetVersion || pinned.assetHash !== ref.assetHash
    || pinned.cgId !== unlock.cgId || pinned.variant !== unlock.variant) throw new Error('Invalid event CG asset pin');
  const routeId = source.occurrence.routeId;
  const historical = findBuiltinEventCg(ref.characterId, unlock.cgId, unlock.variant, ref.assetVersion);
  const entry = historical?.assetHash === ref.assetHash && historical.eventDefId === ref.eventDefId
    && historical.routeId === routeId ? historical : undefined;
  return { petId: pet.petId, characterId: ref.characterId, cgId: unlock.cgId, variant: unlock.variant,
    title: entry?.title ?? '历史纪念画面', hint: entry?.hint ?? '首次获得时的固定资源目前不可用，请保留历史记录。',
    routeId, eventDefId: ref.eventDefId, rarity: entry?.rarity ?? null, unlockStatus: 'UNLOCKED',
    sourceTripId: null, sourceEventId: unlock.sourceEventId, unlockedAt: unlock.unlockedAt,
    favorite: unlock.favorite, viewedAt: unlock.viewedAt, assetRef: ref };
}

/** One identity, one first acquisition, regardless of its original ledger. */
export function findAnyCgUnlock(tx: AppTransaction, petId: string, cgId: string, variant: string): CgUnlock | EventCgUnlock | null {
  const trip = tx.getCgUnlock(petId, cgId, variant);
  const event = tx.getEventCgUnlock(petId, cgId, variant);
  if (trip && event) throw new Error('CG has duplicate acquisition sources');
  return trip ?? event;
}

function rowKey(row: { cgId: string; variant: string }): string { return JSON.stringify([row.cgId, row.variant]); }

function matches(row: GalleryRow, query: GalleryQuery): boolean {
  if (query.characterId !== undefined && row.characterId !== query.characterId) return false;
  if (query.routeId !== undefined && row.routeId !== query.routeId) return false;
  if (query.eventDefId !== undefined && row.eventDefId !== query.eventDefId) return false;
  if (query.rarity !== undefined && row.rarity !== query.rarity) return false;
  switch (query.filter) {
    case 'ALL': return true;
    case 'LOCKED': return row.unlockStatus === 'LOCKED';
    case 'UNLOCKED': return row.unlockStatus === 'UNLOCKED';
    case 'FAVORITES': return row.unlockStatus === 'UNLOCKED' && row.favorite;
  }
}

/** Build a pet-scoped, stable page from authoritative acquisition rows and
 * current locked metadata; it must run inside the snapshot's transaction. */
export function projectGallery(tx: AppTransaction, query: GalleryQuery, revision: number): GalleryPage {
  const pets = query.petId === undefined ? tx.listPets() : [tx.getPet(query.petId)].filter((pet) => pet !== null);
  const rows: GalleryRow[] = [];
  for (const pet of pets) {
    const byUnlockKey = new Map<string, GalleryRow>();
    for (const unlock of tx.listCgUnlocks(pet.petId)) {
      const row = unlockedRow(tx, pet, unlock);
      byUnlockKey.set(rowKey(row), row);
    }
    for (const unlock of tx.listEventCgUnlocks(pet.petId)) {
      const row = unlockedEventRow(tx, pet, unlock);
      const key = rowKey(row);
      if (byUnlockKey.has(key)) throw new Error('CG has duplicate acquisition sources');
      byUnlockKey.set(key, row);
    }
    for (const entry of [...BUILTIN_CG_CATALOG, ...EVENT_CG_CATALOG]) {
      if (entry.characterId !== pet.characterId || byUnlockKey.has(rowKey(entry))) continue;
      const latest = findBuiltinCg(pet.characterId, entry.cgId, entry.variant)
        ?? findBuiltinEventCg(pet.characterId, entry.cgId, entry.variant);
      if (latest) byUnlockKey.set(rowKey(entry), lockedRow(pet, latest));
    }
    for (const row of byUnlockKey.values()) if (matches(row, query)) rows.push(row);
  }
  // The primary pet, acquisition timestamps and favorites cannot shift rows
  // within the same filter. Consumers can restart paging on revision changes.
  rows.sort((a, b) => compareIds(a.petId, b.petId) || compareIds(a.cgId, b.cgId) || compareIds(a.variant, b.variant));
  return galleryPageSchema.parse({ revision, rows: rows.slice(query.offset, query.offset + query.limit),
    total: rows.length, offset: query.offset, limit: query.limit });
}
