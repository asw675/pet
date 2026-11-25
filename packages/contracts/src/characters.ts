import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().min(1).max(160);
const description = z.string().min(1).max(2048);
const names = z.array(shortText).max(16);
const stats = z.strictObject({ hp: nonnegative.max(1_000_000), atk: nonnegative.max(1_000_000),
  def: nonnegative.max(1_000_000), spd: nonnegative.max(1_000_000), luk: nonnegative.max(1_000_000) });

export const characterCatalogVersionSchema = nonnegative.min(1);
export const characterProfessionSchema = z.enum(['MAGE', 'RANGER', 'MECHANICAL_SUPPORT']);
export const characterAvailabilitySchema = z.enum([
  'AVAILABLE', 'ALREADY_OWNED', 'CAPACITY_REACHED', 'UNMET_REQUIREMENT', 'INSUFFICIENT_COINS',
]);

const characterUnlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('STARTER') }),
  z.strictObject({ kind: z.literal('EXPLORATION_COINS'), requiredSettledTrips: nonnegative.min(1), coinCost: nonnegative }),
]);

const ruinsTitle = z.strictObject({ id: z.literal('ruins-pathbreaker'), earnedAt: nonnegative, tripId: identifier });
const ownedInstanceFields = { petId: identifier, nickname: z.string().min(1).max(80), ruinsTitle: ruinsTitle.optional() };
export const ownedCharacterInstanceSchema = z.discriminatedUnion('origin', [
  z.strictObject({ ...ownedInstanceFields, origin: z.literal('LEGACY'), acquiredAt: z.null() }),
  z.strictObject({ ...ownedInstanceFields, origin: z.literal('STARTER'), acquiredAt: nonnegative }),
  z.strictObject({ ...ownedInstanceFields, origin: z.literal('GAME'), acquiredAt: nonnegative }),
]);
export type OwnedCharacterInstance = z.infer<typeof ownedCharacterInstanceSchema>;

/** Catalog metadata and acquisition projection, never an instance mutation or API key. */
export const characterCatalogRowSchema = z.strictObject({
  characterId: identifier,
  displayName: shortText,
  species: shortText,
  profession: characterProfessionSchema,
  professionLabel: shortText,
  background: description,
  personality: z.strictObject({ summary: description, traits: names, likes: names, speechStyle: description }),
  voiceStyleId: identifier,
  adventureFocus: names,
  basePower: nonnegative.min(1).max(1000),
  baseStats: stats.refine((value) => value.hp > 0, 'Base HP must be positive'),
  growthPerLevel: stats,
  unlock: characterUnlockSchema,
  instances: z.array(ownedCharacterInstanceSchema).max(100),
  availability: characterAvailabilitySchema,
}).superRefine((row, ctx) => {
  const ids = new Set(row.instances.map((instance) => instance.petId));
  if (ids.size !== row.instances.length) ctx.addIssue({ code: 'custom', path: ['instances'], message: 'Duplicate instance' });
  if ((row.availability === 'ALREADY_OWNED') !== (row.instances.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['availability'], message: 'Ownership contradicts availability' });
  }
});
export type CharacterCatalogRow = z.infer<typeof characterCatalogRowSchema>;

export const characterCatalogPageSchema = z.strictObject({
  revision: nonnegative,
  catalogVersion: characterCatalogVersionSchema,
  settledTrips: nonnegative,
  walletCoins: nonnegative,
  rows: z.array(characterCatalogRowSchema).max(100),
}).superRefine((page, ctx) => {
  const characters = new Set<string>();
  const pets = new Set<string>();
  for (const [index, row] of page.rows.entries()) {
    if (characters.has(row.characterId)) ctx.addIssue({ code: 'custom', path: ['rows', index], message: 'Duplicate character' });
    characters.add(row.characterId);
    for (const instance of row.instances) {
      if (pets.has(instance.petId)) ctx.addIssue({ code: 'custom', path: ['rows', index, 'instances'], message: 'Instance has two templates' });
      pets.add(instance.petId);
    }
    if (row.instances.length === 0 && row.availability !== 'CAPACITY_REACHED') {
      const expected = row.unlock.kind === 'STARTER' ? 'AVAILABLE'
        : page.settledTrips < row.unlock.requiredSettledTrips ? 'UNMET_REQUIREMENT'
          : page.walletCoins < row.unlock.coinCost ? 'INSUFFICIENT_COINS' : 'AVAILABLE';
      if (row.availability !== expected) ctx.addIssue({ code: 'custom', path: ['rows', index, 'availability'],
        message: 'Acquisition availability contradicts the projected requirements' });
    }
  }
  if (pets.size > 100) ctx.addIssue({ code: 'custom', path: ['rows'], message: 'Too many instances' });
});
export type CharacterCatalogPage = z.infer<typeof characterCatalogPageSchema>;

export const petAcquirePayloadSchema = z.strictObject({ characterId: identifier, catalogVersion: characterCatalogVersionSchema });
export const petRenamePayloadSchema = z.strictObject({ petId: identifier, nickname: z.string().min(1).max(80) });
export type PetAcquirePayload = z.infer<typeof petAcquirePayloadSchema>;
export type PetRenamePayload = z.infer<typeof petRenamePayloadSchema>;
