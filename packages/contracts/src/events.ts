import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const trigger = z.enum(['HOME_DAILY', 'AFTER_INTERACTION', 'TRIP_RETURNED', 'BOND_MILESTONE']);
const rarity = z.enum(['COMMON', 'RARE', 'EPIC', 'LEGENDARY']);
const short = z.string().min(1).max(120);
const text = z.string().min(1).max(2048);
const choice = z.strictObject({ choiceId: id, label: short });

/** Actual committed effect projection. Signed need delta is the applied
 * (clamped) amount, not a promised draft. No target paths or future art hash. */
const eventReward = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MOOD_DELTA'), delta10: z.number().int().min(-1000).max(1000) }),
  z.strictObject({ kind: z.literal('BOND_DELTA'), delta10: z.number().int().min(-1000).max(1000) }),
  z.strictObject({ kind: z.literal('COIN'), amount: positive.max(1000) }),
  z.strictObject({ kind: z.literal('ITEM'), itemId: id, quantity: positive.max(100) }),
  z.strictObject({ kind: z.literal('CG_UNLOCK'), cgId: id, variant: id, newlyUnlocked: z.boolean() }),
]);
export type EventReward = z.infer<typeof eventReward>;
const fields = {
  occurrenceId: id, petId: id, characterId: id, eventId: id, eventVersion: positive.max(1_000_000), trigger,
  sourceTripId: id.nullable(), routeId: id.nullable(), occurredAt: integer, rarity,
  title: short, narrative: text, actionId: id.nullable(), choices: z.array(choice).max(8), deadlineAt: integer.nullable(),
  artState: z.enum(['NONE', 'LOCKED', 'UNAVAILABLE', 'UNLOCKED']),
};

const pending = z.strictObject({ ...fields, status: z.literal('PENDING'), choices: z.array(choice).min(1).max(8), deadlineAt: integer,
  resolvedAt: z.null(), selectedChoiceId: z.null(), resultText: z.null(), rewards: z.tuple([]) });
const finalized = z.strictObject({ ...fields, status: z.enum(['RESOLVED', 'EXPIRED']), resolvedAt: integer,
  selectedChoiceId: id.nullable(), resultText: text, rewards: z.array(eventReward).max(14) });
export const eventOccurrenceViewSchema = z.discriminatedUnion('status', [pending, finalized]).superRefine((event, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((event.trigger === 'TRIP_RETURNED') !== (event.sourceTripId !== null && event.routeId !== null)
    || (event.trigger !== 'TRIP_RETURNED' && (event.sourceTripId !== null || event.routeId !== null))) reject('Travel occurrence provenance is contradictory');
  if (new Set(event.choices.map((entry) => entry.choiceId)).size !== event.choices.length
    || (event.choices.length === 0) !== (event.deadlineAt === null) || (event.deadlineAt !== null && event.deadlineAt <= event.occurredAt)) reject('Choice/deadline identity is invalid');
  if (event.status === 'PENDING') {
    if (event.artState === 'UNLOCKED') reject('Pending occurrence cannot award CG');
    return;
  }
  if (event.resolvedAt < event.occurredAt || (event.choices.length === 0 ? event.selectedChoiceId !== null || event.status === 'EXPIRED'
    : !event.choices.some((entry) => entry.choiceId === event.selectedChoiceId))) reject('Resolved occurrence choice is inconsistent');
  if (event.deadlineAt !== null && (event.status === 'EXPIRED' ? event.resolvedAt !== event.deadlineAt : event.resolvedAt >= event.deadlineAt)) reject('Resolution does not respect the deadline');
  const keys = event.rewards.map((reward) => reward.kind === 'ITEM' ? `ITEM:${reward.itemId}` : reward.kind);
  if (new Set(keys).size !== keys.length || (event.artState === 'UNLOCKED') !== event.rewards.some((reward) => reward.kind === 'CG_UNLOCK')) reject('Reward identity/art status inconsistent');
});
export type EventOccurrenceView = z.infer<typeof eventOccurrenceViewSchema>;

export const eventListQuerySchema = z.strictObject({ petId: id.optional(), filter: z.enum(['ALL', 'PENDING', 'HISTORY']),
  offset: integer.max(1_000_000), limit: positive.max(30) });
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export const eventPageSchema = z.strictObject({ revision: integer, petId: id.nullable(), filter: z.enum(['ALL', 'PENDING', 'HISTORY']),
  pendingTotal: integer, total: integer, offset: integer.max(1_000_000), limit: positive.max(30), rows: z.array(eventOccurrenceViewSchema).max(30) }).superRefine((page, ctx) => {
  if (page.rows.length !== Math.min(page.limit, Math.max(0, page.total - page.offset)) || new Set(page.rows.map((event) => event.occurrenceId)).size !== page.rows.length
    || (page.petId !== null && page.rows.some((event) => event.petId !== page.petId))
    || (page.filter === 'PENDING' && (page.total !== page.pendingTotal || page.rows.some((event) => event.status !== 'PENDING')))
    || (page.filter === 'HISTORY' && page.rows.some((event) => event.status === 'PENDING'))
    || (page.filter === 'ALL' && page.pendingTotal > page.total)) ctx.addIssue({ code: 'custom', message: 'Event page count/filter/identity inconsistent' });
  for (let i = 1; i < page.rows.length; i++) {
    const previous = page.rows[i - 1]!, next = page.rows[i]!;
    if (previous.occurredAt < next.occurredAt || (previous.occurredAt === next.occurredAt && previous.occurrenceId >= next.occurrenceId)) ctx.addIssue({ code: 'custom', path: ['rows', i], message: 'Event page order inconsistent' });
  }
});
export type EventPage = z.infer<typeof eventPageSchema>;

/** Only selection and identity; no client-time or effect/reward overrides. */
export const eventChoosePayloadSchema = z.strictObject({ petId: id, occurrenceId: id, choiceId: id });
export type EventChoosePayload = z.infer<typeof eventChoosePayloadSchema>;
