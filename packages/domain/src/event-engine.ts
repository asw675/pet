/** Independent, deterministic V1 event rules. No clock, I/O, game-state
 * mutations or trip RNG. The application service owns occurrence receipts,
 * compare-and-set finalization and the transaction that commits effects. */
export const EVENT_RULES_VERSION = 'event-v1' as const;
export const EVENT_OCCURRENCE_SCHEMA_VERSION = 1 as const;
export const EVENT_TRIGGERS = Object.freeze(['HOME_DAILY', 'AFTER_INTERACTION', 'TRIP_RETURNED', 'BOND_MILESTONE'] as const);
export const EVENT_RARITIES = Object.freeze(['COMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const);
export const EVENT_PRESENCES = Object.freeze(['HOME', 'AWAY', 'RETURNING'] as const);
export const EVENT_STATUSES = Object.freeze(['PENDING', 'RESOLVED', 'EXPIRED'] as const);
export type EventTrigger = typeof EVENT_TRIGGERS[number];
export type EventRarity = typeof EVENT_RARITIES[number];
export type EventPresence = typeof EVENT_PRESENCES[number];
export type EventOccurrenceStatus = typeof EVENT_STATUSES[number];

export const EVENT_LIMITS = Object.freeze({
  definitions: 128, conditions: 12, choices: 8, effects: 12, history: 8_192,
  filterIds: 100, weight: 100_000, maxPerPet: 1_000, version: 1_000_000,
  cooldownMs: 365 * 24 * 60 * 60 * 1_000, expiryMs: 7 * 24 * 60 * 60 * 1_000,
  level: 1_000, need10: 1_000, needDelta10: 200, coins: 1_000, itemQuantity: 100,
  title: 120, text: 2_048, id: 128, triggerKey: 512,
});

/** Conjunction only. Prerequisites refer to a previously RESOLVED occurrence
 * for the same pet (not another instance of the same character). */
export type EventCondition =
  | { readonly kind: 'CHARACTER'; readonly characterIds: readonly string[] }
  | { readonly kind: 'LEVEL_AT_LEAST'; readonly level: number }
  | { readonly kind: 'BOND_AT_LEAST'; readonly bond10: number }
  | { readonly kind: 'PRESENCE'; readonly presence: EventPresence }
  | { readonly kind: 'ROUTE'; readonly routeIds: readonly string[] }
  | { readonly kind: 'PREREQUISITE'; readonly eventId: string; readonly eventVersion?: number; readonly choiceId?: string };

/** The engine grants only bounded closed effect candidates. Signed need
 * deltas are clamped by the authoritative state writer, not by the UI. */
export type EventEffect =
  | { readonly kind: 'MOOD_DELTA'; readonly delta10: number }
  | { readonly kind: 'BOND_DELTA'; readonly delta10: number }
  | { readonly kind: 'COIN'; readonly amount: number }
  | { readonly kind: 'ITEM'; readonly itemId: string; readonly quantity: number }
  | { readonly kind: 'CG_UNLOCK' };

export interface EventNarrative {
  readonly title: string;
  readonly text: string;
  /** Stable semantic action, not a model path or executable animation. */
  readonly actionId: string | null;
}

interface CgIdentity {
  readonly characterId: string;
  readonly eventDefId: string;
  readonly cgId: string;
  readonly variant: string;
}
export type PinnedEventAsset = CgIdentity & {
  readonly state: 'PINNED'; readonly assetVersion: string; readonly assetHash: string;
};
/** A deliberate future-art marker is not an unlock, not a URL, and cannot
 * be converted into a pinned CG by looking up current content on replay. */
export type EventAssetRef = PinnedEventAsset | (CgIdentity & { readonly state: 'FUTURE_UNAVAILABLE' });

export interface EventChoice {
  readonly choiceId: string;
  readonly label: string;
  readonly resultText: string;
  readonly effects: readonly EventEffect[];
}

export interface EventDefinition {
  readonly eventId: string;
  readonly version: number;
  readonly trigger: EventTrigger;
  readonly conditions: readonly EventCondition[];
  readonly weight: number;
  readonly rarity: EventRarity;
  readonly cooldownMs: number;
  readonly maxPerPet: number;
  readonly narrative: EventNarrative;
  /** Common effects are applied once together with the selected branch. */
  readonly effects: readonly EventEffect[];
  readonly choices: readonly EventChoice[];
  readonly defaultChoiceId: string | null;
  readonly expiresAfterMs: number | null;
  readonly asset: EventAssetRef | null;
}

export interface EventContext {
  readonly petId: string;
  readonly characterId: string;
  readonly presence: EventPresence;
  readonly level: number;
  readonly bond10: number;
  /** Only returned-trip triggers carry route/provenance, not a mutable trip. */
  readonly routeId?: string;
  readonly sourceTripId?: string;
}

export interface EventHistoryEntry {
  readonly occurrenceId: string;
  readonly triggerKey: string;
  readonly petId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly occurredAt: number;
  readonly status: EventOccurrenceStatus;
  readonly resolvedAt: number | null;
  readonly choiceId: string | null;
}

export interface EventSelectionInput {
  readonly trigger: EventTrigger;
  /** Persistent authority allocates/looks up these IDs, even on no-event. */
  readonly triggerKey: string;
  readonly occurrenceId: string;
  readonly seed: number;
  readonly at: number;
  readonly chanceBps: number;
  readonly context: EventContext;
  readonly history: readonly EventHistoryEntry[];
}

/** The immutable occurrence is sufficient to resolve even after the event
 * catalog is replaced. Never resolve using the latest definition. */
export interface FrozenEventOccurrence {
  readonly schemaVersion: typeof EVENT_OCCURRENCE_SCHEMA_VERSION;
  readonly rulesVersion: typeof EVENT_RULES_VERSION;
  readonly occurrenceId: string;
  readonly triggerKey: string;
  readonly petId: string;
  readonly characterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly trigger: EventTrigger;
  readonly routeId: string | null;
  readonly sourceTripId: string | null;
  readonly seed: number;
  readonly occurredAt: number;
  readonly rarity: EventRarity;
  readonly narrative: EventNarrative;
  readonly effects: readonly EventEffect[];
  readonly choices: readonly EventChoice[];
  readonly defaultChoiceId: string | null;
  readonly deadlineAt: number | null;
  readonly asset: EventAssetRef | null;
}

interface SelectionAudit {
  readonly triggerKey: string;
  readonly seed: number;
  readonly rngState: number;
  readonly drawCount: 0 | 1 | 2;
}
export type EventSelectionResult = SelectionAudit & (
  | { readonly kind: 'NO_EVENT'; readonly reason: 'NO_ELIGIBLE' | 'CHANCE_MISS' | 'TRIGGER_ALREADY_SEEN' | 'TRIGGER_INELIGIBLE' }
  | { readonly kind: 'OCCURRENCE'; readonly occurrence: FrozenEventOccurrence }
);

export interface EventEffectDraft {
  readonly moodDelta10: number;
  readonly bondDelta10: number;
  readonly coins: number;
  readonly items: readonly { readonly itemId: string; readonly quantity: number }[];
  readonly cgUnlock: PinnedEventAsset | null;
}

interface EventResolveBase {
  readonly occurrenceId: string;
  readonly petId: string;
  readonly status: EventOccurrenceStatus;
  /** Authority's nondecreasing logical time, never a renderer timestamp. */
  readonly at: number;
}
export type EventResolveRequest = EventResolveBase & (
  | { readonly kind: 'AUTO' }
  | { readonly kind: 'CHOICE'; readonly choiceId: string }
  | { readonly kind: 'EXPIRE' }
);
export type EventResolutionFailure = 'IDENTITY_MISMATCH' | 'ALREADY_FINAL' | 'NOT_YET_CREATED'
  | 'CHOICE_REQUIRED' | 'NO_CHOICES' | 'UNKNOWN_CHOICE' | 'DEADLINE_PASSED' | 'NOT_DUE';
export type EventResolutionResult =
  | { readonly ok: false; readonly reason: EventResolutionFailure }
  | { readonly ok: true; readonly occurrenceId: string; readonly status: 'RESOLVED' | 'EXPIRED';
      readonly choiceId: string | null; readonly resultText: string; readonly resolvedAt: number; readonly effects: EventEffectDraft };

const MAX_TIME = Number.MAX_SAFE_INTEGER;
const UINT32_MAX = 0xffff_ffff;
const BPS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function invalid(label: string): never { throw new RangeError(`Invalid event ${label}`); }

function record(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return invalid(label);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(data, key))) return invalid(label);
  return data;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(label);
  return value;
}
function choose<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid(label);
  return value as T;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) return invalid(label);
  return value;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max || !value.trim() || CONTROL.test(value)) return invalid(label);
  return value;
}
function triggerKey(value: unknown): string { return text(value, EVENT_LIMITS.triggerKey, 'trigger key'); }
function array(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(label);
  // Sparse arrays are not a closed, serializable input format.
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return invalid(label);
  return value;
}
function compareId(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function idList(value: unknown, label: string): readonly string[] {
  const values = array(value, 1, EVENT_LIMITS.filterIds, label).map(raw => id(raw, label));
  if (new Set(values).size !== values.length) return invalid(label);
  return Object.freeze(values.sort(compareId));
}
function nullableId(value: unknown, label: string): string | null { return value === null ? null : id(value, label); }

function parseCondition(raw: unknown): EventCondition {
  const root = record(raw, 'condition', ['kind'], ['characterIds', 'level', 'bond10', 'presence', 'routeIds', 'eventId', 'eventVersion', 'choiceId']);
  const kind = root.kind;
  switch (kind) {
    case 'CHARACTER': {
      const c = record(raw, 'character condition', ['kind', 'characterIds']);
      return Object.freeze({ kind, characterIds: idList(c.characterIds, 'character filter') });
    }
    case 'LEVEL_AT_LEAST': {
      const c = record(raw, 'level condition', ['kind', 'level']);
      return Object.freeze({ kind, level: integer(c.level, 1, EVENT_LIMITS.level, 'condition level') });
    }
    case 'BOND_AT_LEAST': {
      const c = record(raw, 'bond condition', ['kind', 'bond10']);
      return Object.freeze({ kind, bond10: integer(c.bond10, 0, EVENT_LIMITS.need10, 'condition bond') });
    }
    case 'PRESENCE': {
      const c = record(raw, 'presence condition', ['kind', 'presence']);
      return Object.freeze({ kind, presence: choose(c.presence, EVENT_PRESENCES, 'condition presence') });
    }
    case 'ROUTE': {
      const c = record(raw, 'route condition', ['kind', 'routeIds']);
      return Object.freeze({ kind, routeIds: idList(c.routeIds, 'route filter') });
    }
    case 'PREREQUISITE': {
      const c = record(raw, 'prerequisite condition', ['kind', 'eventId'], ['eventVersion', 'choiceId']);
      return Object.freeze({ kind, eventId: id(c.eventId, 'prerequisite event ID'),
        ...(Object.hasOwn(c, 'eventVersion') ? { eventVersion: integer(c.eventVersion, 1, EVENT_LIMITS.version, 'prerequisite version') } : {}),
        ...(Object.hasOwn(c, 'choiceId') ? { choiceId: id(c.choiceId, 'prerequisite choice') } : {}) });
    }
    default: return invalid('condition kind');
  }
}

function parseEffect(raw: unknown): EventEffect {
  const root = record(raw, 'effect', ['kind'], ['delta10', 'amount', 'itemId', 'quantity']);
  const kind = root.kind;
  switch (kind) {
    case 'MOOD_DELTA': case 'BOND_DELTA': {
      const e = record(raw, 'need effect', ['kind', 'delta10']);
      const delta10 = integer(e.delta10, -EVENT_LIMITS.needDelta10, EVENT_LIMITS.needDelta10, 'need delta');
      if (delta10 === 0) return invalid('zero need delta');
      return Object.freeze({ kind, delta10 });
    }
    case 'COIN': {
      const e = record(raw, 'coin effect', ['kind', 'amount']);
      return Object.freeze({ kind, amount: integer(e.amount, 1, EVENT_LIMITS.coins, 'coin amount') });
    }
    case 'ITEM': {
      const e = record(raw, 'item effect', ['kind', 'itemId', 'quantity']);
      return Object.freeze({ kind, itemId: id(e.itemId, 'item ID'), quantity: integer(e.quantity, 1, EVENT_LIMITS.itemQuantity, 'item quantity') });
    }
    case 'CG_UNLOCK':
      record(raw, 'CG unlock effect', ['kind']);
      return Object.freeze({ kind });
    default: return invalid('effect kind');
  }
}
function parseEffects(raw: unknown): readonly EventEffect[] {
  return Object.freeze(array(raw, 0, EVENT_LIMITS.effects, 'effect list').map(parseEffect));
}
function parseNarrative(raw: unknown): EventNarrative {
  const n = record(raw, 'narrative', ['title', 'text', 'actionId']);
  return Object.freeze({ title: text(n.title, EVENT_LIMITS.title, 'narrative title'),
    text: text(n.text, EVENT_LIMITS.text, 'narrative text'), actionId: nullableId(n.actionId, 'semantic action') });
}
function parseChoice(raw: unknown): EventChoice {
  const c = record(raw, 'choice', ['choiceId', 'label', 'resultText', 'effects']);
  return Object.freeze({ choiceId: id(c.choiceId, 'choice ID'), label: text(c.label, EVENT_LIMITS.title, 'choice label'),
    resultText: text(c.resultText, EVENT_LIMITS.text, 'choice result'), effects: parseEffects(c.effects) });
}
function parseAsset(raw: unknown): EventAssetRef | null {
  if (raw === null) return null;
  const fields = ['state', 'characterId', 'eventDefId', 'cgId', 'variant'];
  const root = record(raw, 'asset reference', fields, ['assetVersion', 'assetHash']);
  const identity = { characterId: id(root.characterId, 'asset character'), eventDefId: id(root.eventDefId, 'asset event'),
    cgId: id(root.cgId, 'asset CG ID'), variant: id(root.variant, 'asset variant') };
  if (root.state === 'FUTURE_UNAVAILABLE') {
    record(raw, 'future asset reference', fields);
    return Object.freeze({ ...identity, state: 'FUTURE_UNAVAILABLE' });
  }
  if (root.state !== 'PINNED') return invalid('asset state');
  record(raw, 'pinned asset reference', [...fields, 'assetVersion', 'assetHash']);
  const assetVersion = text(root.assetVersion, 64, 'asset version');
  const assetHash = text(root.assetHash, 64, 'asset hash');
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u.test(assetVersion)
    || !/^[a-f0-9]{64}$/u.test(assetHash)) return invalid('pinned asset identity');
  return Object.freeze({ ...identity, state: 'PINNED', assetVersion, assetHash });
}

function effectDraft(effects: readonly EventEffect[], asset: EventAssetRef | null): EventEffectDraft {
  let moodDelta10 = 0, bondDelta10 = 0, coins = 0;
  let moodMagnitude10 = 0, bondMagnitude10 = 0;
  let cgUnlock: PinnedEventAsset | null = null;
  const items = new Map<string, number>();
  for (const e of effects) {
    switch (e.kind) {
      case 'MOOD_DELTA': moodDelta10 += e.delta10; moodMagnitude10 += Math.abs(e.delta10); break;
      case 'BOND_DELTA': bondDelta10 += e.delta10; bondMagnitude10 += Math.abs(e.delta10); break;
      case 'COIN': coins += e.amount; break;
      case 'ITEM': {
        const quantity = (items.get(e.itemId) ?? 0) + e.quantity;
        if (quantity > EVENT_LIMITS.itemQuantity) return invalid('combined item quantity');
        items.set(e.itemId, quantity);
        break;
      }
      case 'CG_UNLOCK':
        if (asset?.state !== 'PINNED' || cgUnlock !== null) return invalid('CG effect without a single pinned asset');
        cgUnlock = asset;
        break;
    }
  }
  if (moodMagnitude10 > EVENT_LIMITS.needDelta10 || bondMagnitude10 > EVENT_LIMITS.needDelta10
    || coins > EVENT_LIMITS.coins) return invalid('combined effects');
  return Object.freeze({ moodDelta10, bondDelta10, coins,
    items: Object.freeze([...items].sort(([a], [b]) => compareId(a, b)).map(([itemId, quantity]) => Object.freeze({ itemId, quantity }))),
    cgUnlock });
}

function parseBranches(choicesRaw: unknown, defaultRaw: unknown, expiryRaw: unknown, effects: readonly EventEffect[],
  asset: EventAssetRef | null, expiryValidator: (value: unknown) => number): {
    readonly choices: readonly EventChoice[]; readonly defaultChoiceId: string | null; readonly expiry: number | null;
  } {
  const choices = Object.freeze(array(choicesRaw, 0, EVENT_LIMITS.choices, 'choices').map(parseChoice));
  const defaultChoiceId = nullableId(defaultRaw, 'default choice');
  if (choices.length === 0) {
    if (defaultChoiceId !== null || expiryRaw !== null) return invalid('automatic event branch configuration');
    effectDraft(effects, asset);
    return { choices, defaultChoiceId, expiry: null };
  }
  if (choices.length < 2 || new Set(choices.map(c => c.choiceId)).size !== choices.length
    || defaultChoiceId === null || !choices.some(c => c.choiceId === defaultChoiceId)) return invalid('choice configuration');
  const expiry = expiryValidator(expiryRaw);
  for (const choice of choices) effectDraft([...effects, ...choice.effects], asset);
  return { choices, defaultChoiceId, expiry };
}

function parseDefinition(raw: unknown): EventDefinition {
  const d = record(raw, 'definition', ['eventId', 'version', 'trigger', 'conditions', 'weight', 'rarity', 'cooldownMs', 'maxPerPet',
    'narrative', 'effects', 'choices', 'defaultChoiceId', 'expiresAfterMs', 'asset']);
  const eventId = id(d.eventId, 'event ID');
  const trigger = choose(d.trigger, EVENT_TRIGGERS, 'trigger');
  const conditions = Object.freeze(array(d.conditions, 0, EVENT_LIMITS.conditions, 'conditions').map(parseCondition));
  if (conditions.some(c => (c.kind === 'ROUTE' && trigger !== 'TRIP_RETURNED')
    || (c.kind === 'PREREQUISITE' && c.eventId === eventId))) return invalid('definition conditions');
  const effects = parseEffects(d.effects);
  const asset = parseAsset(d.asset);
  if (asset !== null) {
    // A descriptor with a specific heroine cannot be selected for another
    // character merely because the author forgot a character constraint.
    if (asset.eventDefId !== eventId || !conditions.some(c => c.kind === 'CHARACTER'
      && c.characterIds.length === 1 && c.characterIds[0] === asset.characterId)) return invalid('asset definition identity');
  }
  const branches = parseBranches(d.choices, d.defaultChoiceId, d.expiresAfterMs, effects, asset,
    value => integer(value, 1, EVENT_LIMITS.expiryMs, 'choice expiry duration'));
  return Object.freeze({ eventId, version: integer(d.version, 1, EVENT_LIMITS.version, 'definition version'),
    trigger, conditions, weight: integer(d.weight, 1, EVENT_LIMITS.weight, 'weight'), rarity: choose(d.rarity, EVENT_RARITIES, 'rarity'),
    cooldownMs: integer(d.cooldownMs, 0, EVENT_LIMITS.cooldownMs, 'cooldown'),
    maxPerPet: integer(d.maxPerPet, 1, EVENT_LIMITS.maxPerPet, 'per-pet limit'), narrative: parseNarrative(d.narrative),
    effects, choices: branches.choices, defaultChoiceId: branches.defaultChoiceId, expiresAfterMs: branches.expiry, asset });
}

/** Validates and freezes independent copies; permits historical versions in
 * the supplied catalog, but only its latest version per stable ID is active. */
export function validateEventCatalog(raw: unknown): readonly EventDefinition[] {
  const definitions = array(raw, 0, EVENT_LIMITS.definitions, 'catalog').map(parseDefinition)
    .sort((a, b) => compareId(a.eventId, b.eventId) || a.version - b.version);
  if (definitions.some((d, i) => i > 0 && d.eventId === definitions[i - 1]!.eventId && d.version === definitions[i - 1]!.version)) {
    return invalid('duplicate definition identity');
  }
  return Object.freeze(definitions);
}

function parseHistory(raw: unknown, when: number): readonly EventHistoryEntry[] {
  const entries = array(raw, 0, EVENT_LIMITS.history, 'history').map(value => {
    const e = record(value, 'history entry', ['occurrenceId', 'triggerKey', 'petId', 'eventId', 'eventVersion', 'occurredAt', 'status', 'resolvedAt', 'choiceId']);
    const occurredAt = integer(e.occurredAt, 0, when, 'historical time');
    const status = choose(e.status, EVENT_STATUSES, 'historical status');
    const resolvedAt = e.resolvedAt === null ? null : integer(e.resolvedAt, occurredAt, when, 'historical resolution time');
    const choiceId = nullableId(e.choiceId, 'historical choice');
    if ((status === 'PENDING') !== (resolvedAt === null) || (status === 'PENDING' && choiceId !== null)
      || (status === 'EXPIRED' && choiceId === null)) return invalid('historical resolution');
    return { occurrenceId: id(e.occurrenceId, 'history occurrence ID'), triggerKey: triggerKey(e.triggerKey),
      petId: id(e.petId, 'history pet ID'), eventId: id(e.eventId, 'history event ID'),
      eventVersion: integer(e.eventVersion, 1, EVENT_LIMITS.version, 'history event version'), occurredAt, status, resolvedAt, choiceId };
  });
  if (new Set(entries.map(e => e.occurrenceId)).size !== entries.length || new Set(entries.map(e => e.triggerKey)).size !== entries.length) {
    return invalid('duplicate historical identity');
  }
  return entries;
}

function parseSelectionInput(raw: unknown): EventSelectionInput {
  const i = record(raw, 'selection input', ['trigger', 'triggerKey', 'occurrenceId', 'seed', 'at', 'chanceBps', 'context', 'history']);
  const trigger = choose(i.trigger, EVENT_TRIGGERS, 'selection trigger');
  const at = integer(i.at, 0, MAX_TIME, 'selection time');
  const c = record(i.context, 'context', ['petId', 'characterId', 'presence', 'level', 'bond10'], ['routeId', 'sourceTripId']);
  const routeId = Object.hasOwn(c, 'routeId') ? id(c.routeId, 'context route') : undefined;
  const sourceTripId = Object.hasOwn(c, 'sourceTripId') ? id(c.sourceTripId, 'context trip') : undefined;
  // Both route and exact source trip are mandatory on completed-return
  // triggers; neither may be smuggled onto an unrelated trigger.
  if ((trigger === 'TRIP_RETURNED') !== (routeId !== undefined)
    || (trigger === 'TRIP_RETURNED') !== (sourceTripId !== undefined)) {
    return invalid('trigger provenance');
  }
  return { trigger, triggerKey: triggerKey(i.triggerKey), occurrenceId: id(i.occurrenceId, 'occurrence ID'),
    seed: integer(i.seed, 1, UINT32_MAX, 'seed'), at, chanceBps: integer(i.chanceBps, 0, BPS, 'chance in basis points'),
    context: { petId: id(c.petId, 'context pet ID'), characterId: id(c.characterId, 'context character ID'),
      presence: choose(c.presence, EVENT_PRESENCES, 'context presence'), level: integer(c.level, 1, EVENT_LIMITS.level, 'context level'),
      bond10: integer(c.bond10, 0, EVENT_LIMITS.need10, 'context bond'),
      ...(routeId === undefined ? {} : { routeId }), ...(sourceTripId === undefined ? {} : { sourceTripId }) },
    history: parseHistory(i.history, at) };
}

function eligible(definition: EventDefinition, input: EventSelectionInput, petHistory: readonly EventHistoryEntry[]): boolean {
  const c = input.context;
  if (definition.trigger !== input.trigger) return false;
  const previous = petHistory.filter(h => h.eventId === definition.eventId);
  if (previous.length >= definition.maxPerPet || previous.some(h => h.status === 'PENDING'
    || input.at - h.occurredAt < definition.cooldownMs)) return false;
  return definition.conditions.every(condition => {
    switch (condition.kind) {
      case 'CHARACTER': return condition.characterIds.includes(c.characterId);
      case 'LEVEL_AT_LEAST': return c.level >= condition.level;
      case 'BOND_AT_LEAST': return c.bond10 >= condition.bond10;
      case 'PRESENCE': return c.presence === condition.presence;
      case 'ROUTE': return c.routeId !== undefined && condition.routeIds.includes(c.routeId);
      case 'PREREQUISITE': return petHistory.some(h => h.status === 'RESOLVED' && h.eventId === condition.eventId
        && (condition.eventVersion === undefined || h.eventVersion === condition.eventVersion)
        && (condition.choiceId === undefined || h.choiceId === condition.choiceId));
    }
  });
}

/** Separate event-v1 non-cryptographic random stream. Exact multiply-high
 * avoids floating-point rounding ambiguity. Chance uses one draw and, only
 * on success, weighted selection uses one more draw. No eligible => zero. */
function draw(state: number, maxExclusive: number): { state: number; value: number } {
  let next = state | 0;
  next ^= next << 13; next ^= next >>> 17; next ^= next << 5;
  const unsigned = next >>> 0;
  return { state: unsigned, value: Number((BigInt(unsigned) * BigInt(maxExclusive)) >> 32n) };
}

function freezeOccurrence(definition: EventDefinition, input: EventSelectionInput): FrozenEventOccurrence {
  const duration = definition.expiresAfterMs;
  if (duration !== null && input.at > MAX_TIME - duration) return invalid('deadline overflow');
  return Object.freeze({ schemaVersion: EVENT_OCCURRENCE_SCHEMA_VERSION, rulesVersion: EVENT_RULES_VERSION,
    occurrenceId: input.occurrenceId, triggerKey: input.triggerKey, petId: input.context.petId, characterId: input.context.characterId,
    eventId: definition.eventId, eventVersion: definition.version, trigger: input.trigger,
    routeId: input.context.routeId ?? null, sourceTripId: input.context.sourceTripId ?? null,
    seed: input.seed, occurredAt: input.at, rarity: definition.rarity, narrative: definition.narrative,
    effects: definition.effects, choices: definition.choices, defaultChoiceId: definition.defaultChoiceId,
    deadlineAt: duration === null ? null : input.at + duration, asset: definition.asset });
}

/** Selects a versioned occurrence from immutable inputs. Authority persists
 * the returned trigger receipt even on NO_EVENT; calling this function with
 * a different seed is not a valid alternative to retrieving that receipt. */
export function selectEvent(catalog: readonly EventDefinition[], rawInput: EventSelectionInput): EventSelectionResult {
  const definitions = validateEventCatalog(catalog), input = parseSelectionInput(rawInput);
  const { seed, triggerKey: key } = input;
  const noEvent = (reason: Extract<EventSelectionResult, { kind: 'NO_EVENT' }>['reason'],
    drawCount: 0 | 1 = 0, rngState = seed): EventSelectionResult => Object.freeze({ kind: 'NO_EVENT', reason, triggerKey: key, seed, drawCount, rngState });
  if (input.history.some(h => h.triggerKey === key)) return noEvent('TRIGGER_ALREADY_SEEN');
  if (input.history.some(h => h.occurrenceId === input.occurrenceId)) return invalid('reused occurrence ID');
  // V1 events only affect the home pet, including the completed return of a
  // trip. Neither an in-flight choice nor its expiry can rewrite trip-v1.
  if (input.context.presence !== 'HOME') return noEvent('TRIGGER_INELIGIBLE');
  const petHistory = input.history.filter(h => h.petId === input.context.petId);
  const active = new Map<string, EventDefinition>();
  for (const definition of definitions) active.set(definition.eventId, definition);
  const candidates = [...active.values()].filter(d => eligible(d, input, petHistory));
  if (candidates.length === 0) return noEvent('NO_ELIGIBLE');
  const chance = draw(seed, BPS);
  if (chance.value >= input.chanceBps) return noEvent('CHANCE_MISS', 1, chance.state);
  const total = candidates.reduce((sum, d) => sum + d.weight, 0);
  const weighted = draw(chance.state, total);
  let remaining = weighted.value;
  for (const definition of candidates) {
    if (remaining < definition.weight) {
      return Object.freeze({ kind: 'OCCURRENCE', triggerKey: key, seed, rngState: weighted.state, drawCount: 2,
        occurrence: freezeOccurrence(definition, input) });
    }
    remaining -= definition.weight;
  }
  return invalid('weighted selection');
}

/** Strict persisted occurrence decoder; does not consult an updated catalog. */
export function validateFrozenOccurrence(raw: unknown): FrozenEventOccurrence {
  const o = record(raw, 'frozen occurrence', ['schemaVersion', 'rulesVersion', 'occurrenceId', 'triggerKey', 'petId', 'characterId',
    'eventId', 'eventVersion', 'trigger', 'routeId', 'sourceTripId', 'seed', 'occurredAt', 'rarity', 'narrative', 'effects',
    'choices', 'defaultChoiceId', 'deadlineAt', 'asset']);
  if (o.schemaVersion !== EVENT_OCCURRENCE_SCHEMA_VERSION || o.rulesVersion !== EVENT_RULES_VERSION) return invalid('occurrence rules version');
  const occurredAt = integer(o.occurredAt, 0, MAX_TIME, 'occurrence time');
  const characterId = id(o.characterId, 'occurrence character ID'), eventId = id(o.eventId, 'occurrence event ID');
  const trigger = choose(o.trigger, EVENT_TRIGGERS, 'occurrence trigger');
  const routeId = nullableId(o.routeId, 'occurrence route'), sourceTripId = nullableId(o.sourceTripId, 'occurrence trip');
  if ((trigger === 'TRIP_RETURNED') !== (routeId !== null)
    || (trigger === 'TRIP_RETURNED') !== (sourceTripId !== null)) return invalid('occurrence provenance');
  const effects = parseEffects(o.effects), asset = parseAsset(o.asset);
  if (asset !== null && (asset.characterId !== characterId || asset.eventDefId !== eventId)) return invalid('occurrence asset identity');
  const branches = parseBranches(o.choices, o.defaultChoiceId, o.deadlineAt, effects, asset,
    value => integer(value, occurredAt + 1, occurredAt + Math.min(EVENT_LIMITS.expiryMs, MAX_TIME - occurredAt), 'occurrence deadline'));
  return Object.freeze({ schemaVersion: EVENT_OCCURRENCE_SCHEMA_VERSION, rulesVersion: EVENT_RULES_VERSION,
    occurrenceId: id(o.occurrenceId, 'occurrence ID'), triggerKey: triggerKey(o.triggerKey), petId: id(o.petId, 'occurrence pet ID'),
    characterId, eventId, eventVersion: integer(o.eventVersion, 1, EVENT_LIMITS.version, 'occurrence event version'), trigger, routeId, sourceTripId,
    seed: integer(o.seed, 1, UINT32_MAX, 'occurrence seed'), occurredAt, rarity: choose(o.rarity, EVENT_RARITIES, 'occurrence rarity'),
    narrative: parseNarrative(o.narrative), effects, choices: branches.choices, defaultChoiceId: branches.defaultChoiceId,
    deadlineAt: branches.expiry, asset });
}

function parseResolveRequest(raw: unknown): EventResolveRequest {
  const common = ['kind', 'occurrenceId', 'petId', 'status', 'at'];
  const r = record(raw, 'resolve request', common, ['choiceId']);
  const kind = choose(r.kind, ['AUTO', 'CHOICE', 'EXPIRE'] as const, 'resolve request kind');
  record(raw, 'resolve request', kind === 'CHOICE' ? [...common, 'choiceId'] : common);
  const base = { occurrenceId: id(r.occurrenceId, 'resolve occurrence ID'), petId: id(r.petId, 'resolve pet ID'),
    status: choose(r.status, EVENT_STATUSES, 'resolve status'), at: integer(r.at, 0, MAX_TIME, 'resolve time') };
  return kind === 'CHOICE' ? { ...base, kind, choiceId: id(r.choiceId, 'resolve choice ID') } : { ...base, kind };
}

/** Returns an effect draft only for a pending exact occurrence. At the
 * deadline a choice is late, even if the service has not yet applied the
 * default. Expiry resolves at its scheduled deadline (not wake time). */
export function resolveEventOccurrence(rawOccurrence: FrozenEventOccurrence, rawRequest: EventResolveRequest): EventResolutionResult {
  const occurrence = validateFrozenOccurrence(rawOccurrence), request = parseResolveRequest(rawRequest);
  const deny = (reason: EventResolutionFailure): EventResolutionResult => Object.freeze({ ok: false, reason });
  if (request.occurrenceId !== occurrence.occurrenceId || request.petId !== occurrence.petId) return deny('IDENTITY_MISMATCH');
  if (request.status !== 'PENDING') return deny('ALREADY_FINAL');
  if (request.at < occurrence.occurredAt) return deny('NOT_YET_CREATED');
  const result = (status: 'RESOLVED' | 'EXPIRED', choice: EventChoice | null, resolvedAt: number): EventResolutionResult => Object.freeze({
    ok: true, occurrenceId: occurrence.occurrenceId, status, choiceId: choice?.choiceId ?? null,
    resultText: choice?.resultText ?? occurrence.narrative.text, resolvedAt,
    effects: effectDraft(choice === null ? occurrence.effects : [...occurrence.effects, ...choice.effects], occurrence.asset),
  });
  if (request.kind === 'AUTO') {
    if (occurrence.choices.length !== 0) return deny('CHOICE_REQUIRED');
    return result('RESOLVED', null, occurrence.occurredAt);
  }
  const deadline = occurrence.deadlineAt;
  if (deadline === null) return deny('NO_CHOICES');
  if (request.kind === 'EXPIRE') {
    if (request.at < deadline) return deny('NOT_DUE');
    const defaultChoice = occurrence.choices.find(c => c.choiceId === occurrence.defaultChoiceId)!;
    return result('EXPIRED', defaultChoice, deadline);
  }
  if (request.at >= deadline) return deny('DEADLINE_PASSED');
  const choice = occurrence.choices.find(c => c.choiceId === request.choiceId);
  if (choice === undefined) return deny('UNKNOWN_CHOICE');
  return result('RESOLVED', choice, request.at);
}
