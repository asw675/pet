import { idSchema } from '@pet-desktop/contracts';
import { tripDepartureLoadoutSchema } from '@pet-desktop/contracts/travel';
import type { TripDepartureLoadout } from '@pet-desktop/contracts/travel';

/** A frozen loadout belongs to one departure command and one trip. The
 * wire report exposes only the loadout, not the internal receipt link. */
export interface TripDepartureLoadoutRecord {
  tripId: string;
  commandId: string;
  loadout: TripDepartureLoadout;
}

const equipmentOrder = ['WEAPON', 'ARMOR', 'ACCESSORY'] as const;

/** Parse an explicit closed historical projection without deriving anything
 * from today's catalog. Supplies are a set; normalize their order, as well
 * as equipment slots, so persisted and read-back records are deterministic. */
export function canonicalTripDepartureLoadout(value: unknown): TripDepartureLoadout {
  const loadout = tripDepartureLoadoutSchema.parse(value);
  return {
    ...loadout,
    supplies: [...loadout.supplies].sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
    equipment: [...loadout.equipment].sort((left, right) => equipmentOrder.indexOf(left.slot) - equipmentOrder.indexOf(right.slot)),
  };
}

export function validateTripDepartureLoadoutRecord(value: unknown): TripDepartureLoadoutRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !['tripId', 'commandId', 'loadout'].every(key => Object.hasOwn(value, key))) {
    throw new Error('Invalid closed trip departure loadout record');
  }
  const record = value as Record<string, unknown>;
  return { tripId: idSchema.parse(record.tripId), commandId: idSchema.parse(record.commandId),
    loadout: canonicalTripDepartureLoadout(record.loadout) };
}
