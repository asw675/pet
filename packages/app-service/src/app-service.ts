import {
  appSnapshotSchema, CONTRACT_SCHEMA_VERSION, domainCommandSchema, domainEventSchema,
  idSchema, ipcRequestSchema, timestampSchema,
} from '@pet-desktop/contracts';
import type { AppSnapshot, CharacterCatalogPage, DomainCommand, DomainEvent, GalleryPage, GalleryQuery, InventoryPage, IpcErrorCode, IpcResult, PetSnapshot } from '@pet-desktop/contracts';
import {
  advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE, recallTrip,
} from '@pet-desktop/domain';
import type { RewardDraft, TripAdvanceResult, TripFact } from '@pet-desktop/domain';
import { CHARACTER_CATALOG_VERSION, evaluateCharacterAcquisition, normalizeCharacterNickname } from '@pet-desktop/domain/character-catalog';
import { advanceHomeState, interactHome } from '@pet-desktop/domain/home-simulation';
import type { HomeSimulationState } from '@pet-desktop/domain/home-simulation';
import type {
  AppRepository, AppRuntime, AppTransaction, CommandOutcome, PetRecord, PreferencesRecord, RewardLine, TripRecord,
} from './ports.js';
import { freezeTripCgAssets, projectGallery, TRIP_CG_VARIANT as CG_VARIANT } from '#gallery-service';
import { characterAcquisitionContext, createCharacterPet, createStarterPets, projectCharacterCatalog } from '#character-service';
import { applyHomeState, hasVisibleHomeChange, initialHomeState, readHomeState, scheduleFromHome, transitionHomeState } from '#home-state-service';
import { battleProjection, executeEconomyCommand, projectInventory } from '#economy-service';

const DEPARTURE_ENERGY10 = 150;

type Failure = Extract<CommandOutcome, { ok: false }>;
type GalleryOutcome = { ok: true; snapshot: AppSnapshot; gallery: GalleryPage } | Failure;
type CharactersOutcome = { ok: true; snapshot: AppSnapshot; characters: CharacterCatalogPage };
type InventoryOutcome = { ok: true; snapshot: AppSnapshot; inventory: InventoryPage };

function failure(code: IpcErrorCode, message: string, retryable = false): Failure {
  return { ok: false, error: { code, message, retryable } };
}

function internalError(): Failure {
  return failure('INTERNAL_ERROR', 'The application could not complete the operation.', true);
}

function unavailable(): Failure {
  return failure('SERVICE_UNAVAILABLE', 'The application service is closed.', true);
}

function transactionFailure(error: unknown): Failure {
  return error instanceof Error && error.name === 'RepositoryUnavailableError'
    ? failure('SERVICE_UNAVAILABLE', 'The application storage requires a restart.', false)
    : internalError();
}

/** Canonical parsed JSON, independent of property insertion order (arrays retain order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => compareIds(a, b)));
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function equalJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function addNonnegative(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(result)) {
    throw new Error('Invalid persisted or resulting numeric balance');
  }
  return result;
}

/** V1 demo curve; XP is cumulative and retained even at the demo level cap. */
function levelForXp(xp: number): number {
  let remaining = xp;
  let level = 1;
  while (level < 20 && remaining >= 100 + 35 * (level - 1)) {
    remaining -= 100 + 35 * (level - 1);
    level += 1;
  }
  return level;
}

/** A recall is a frozen input too. Its logical departure for return can be
 * recovered from the returning/returned checkpoint without a new random draw. */
function replay(trip: TripRecord): TripAdvanceResult {
  const { snapshot, checkpoint } = trip;
  const initial = createTripCheckpoint(snapshot);
  if (checkpoint.returnReason !== 'RECALLED') {
    return advanceTrip(snapshot, initial, checkpoint.logicalTime);
  }
  const dueAt = checkpoint.nextDueAt ?? checkpoint.actualReturnedAt;
  if (dueAt === null) throw new Error('Recall has no persisted arrival time');
  const recalled = recallTrip(snapshot, initial, dueAt - snapshot.returnDurationMs);
  const resumed = advanceTrip(snapshot, recalled.checkpoint, checkpoint.logicalTime);
  return { ...resumed, facts: [...recalled.facts, ...resumed.facts] };
}

function verifyReplay(trip: TripRecord, facts: readonly TripFact[]): TripAdvanceResult {
  const result = replay(trip);
  if (result.status !== trip.status || !equalJson(result.checkpoint, trip.checkpoint) || !equalJson(result.facts, facts)) {
    throw new Error('Persisted trip does not match its deterministic replay');
  }
  return result;
}

function rewardLines(trip: TripRecord, rewards: RewardDraft): RewardLine[] {
  const { tripId, petId } = trip.snapshot;
  const lines: RewardLine[] = [];
  function add(kind: RewardLine['kind'], targetId: string, amount: number): void {
    if (amount === 0) return;
    const sourceType = 'TRIP';
    lines.push({
      rewardKey: canonicalJson([sourceType, tripId, petId, kind, targetId]),
      sourceType, sourceId: tripId, petId, kind, targetId, amount,
    });
  }
  add('XP', 'xp', rewards.xp);
  add('COIN', 'coin', rewards.coins);
  for (const item of rewards.items) add('ITEM', item.itemId, item.quantity);
  for (const cgId of rewards.cgIds) add('CG', `${cgId}:${CG_VARIANT}`, 1);
  return lines;
}

function sortedRewards(lines: readonly RewardLine[]): RewardLine[] {
  return [...lines].sort((a, b) => compareIds(a.rewardKey, b.rewardKey));
}

/** The concrete SQL driver stays behind this synchronous transaction boundary. */
interface TransactionState {
  tx: AppTransaction;
  preferences: PreferencesRecord;
}

/** The renderer may invoke only the closed, versioned IPC command/query envelope. */
export class AppService {
  private closed = false;
  private readonly repository: AppRepository;
  private readonly runtime: AppRuntime;

  constructor(repository: AppRepository, runtime: AppRuntime) {
    this.repository = repository;
    this.runtime = runtime;
    this.repository.transaction((tx) => {
      if (tx.getPreferences() !== null) {
        // A startup is a recovery boundary, not merely a new IPC listener.
        // Audit completed history before allowing any further game effects.
        const state = this.state(tx);
        for (const trip of tx.listTrips()) {
          if (trip.status === 'SETTLED') this.verifySettledReport(state, trip);
        }
        this.initializeLegacyHomeSchedules(state);
        this.advanceAll(state);
        this.snapshot(state);
        return;
      }
      if (tx.listPets().length !== 0 || tx.listTrips().length !== 0 || tx.getWalletCoins() !== 0
        || tx.listInventory().length !== 0 || tx.listItemInstances().length !== 0 || tx.hasCommandReceipts() || tx.listOutbox(0, 1).length !== 0) {
        // A partially initialized or damaged database is not an empty save.
        throw new Error('Cannot initialize over existing game data');
      }
      const starters = createStarterPets();
      const startedAt = this.now();
      const initial = starters.map((pet) => ({ pet, home: initialHomeState(pet, startedAt) }));
      for (const { pet, home } of initial) tx.savePet(applyHomeState(pet, home));
      tx.setWalletCoins(0);
      tx.savePreferences({ revision: 0, logicalTime: startedAt, primaryPetId: 'pet-1',
        doNotDisturb: false, pausedRender: false });
      for (const { pet, home } of initial) {
        tx.insertPetAcquisition({ petId: pet.petId, acquiredAt: startedAt, origin: 'STARTER',
          catalogVersion: CHARACTER_CATALOG_VERSION, coinCost: 0, commandId: null });
        tx.saveHomeSchedule(scheduleFromHome(home));
      }
    });
  }

  private now(): number {
    return timestampSchema.parse(this.runtime.now());
  }

  private state(tx: AppTransaction): TransactionState {
    const preferences = tx.getPreferences();
    if (preferences === null) throw new Error('Missing initialized preferences');
    return { tx, preferences };
  }

  private revise(state: TransactionState, changes: Partial<PreferencesRecord> = {}): void {
    state.preferences = { ...state.preferences, ...changes, revision: addNonnegative(state.preferences.revision, 1) };
    state.tx.savePreferences(state.preferences);
  }

  /** A v3 (or earlier) save has no HOME schedules at all. Anchor its newly
   * introduced simulation at the last known authority time, not at a guessed
   * adoption date or the current wall clock. Partial absence is corruption. */
  private initializeLegacyHomeSchedules(state: TransactionState): void {
    const pets = state.tx.listPets().sort((a, b) => compareIds(a.petId, b.petId));
    const schedules = pets.map((pet) => state.tx.getHomeSchedule(pet.petId));
    if (schedules.some((entry) => entry === null) && schedules.some((entry) => entry !== null)) {
      throw new Error('Partially missing home schedules');
    }
    for (const pet of pets) {
      if (schedules.every((entry) => entry === null)) {
        this.persistHomeProjection(state, pet, initialHomeState(pet, state.preferences.logicalTime), true);
      } else {
        readHomeState(state.tx, pet, state.preferences.logicalTime);
      }
    }
  }

  private persistHomeProjection(state: TransactionState, pet: PetRecord, home: HomeSimulationState, forceClock = false): void {
    const visibleChanged = hasVisibleHomeChange(pet, home);
    if (visibleChanged) {
      state.tx.savePet({ ...applyHomeState(pet, home), revision: addNonnegative(pet.revision, 1) });
      this.revise(state);
    }
    // Fractions and UTC day changes alone never publish a new revision or
    // require a database write on each poll. They are computed exactly from
    // the last durable baseline on the following tick. Explicit actions and
    // actual presence transitions persist all fractional state atomically.
    if (visibleChanged || forceClock) state.tx.saveHomeSchedule(scheduleFromHome(home));
  }

  private event(state: TransactionState, type: string, aggregateId: string, causationId: string,
    occurredAt: number, payload: DomainEvent['payload']): void {
    state.tx.appendOutbox(domainEventSchema.parse({
      eventId: this.runtime.createId('event'), type, aggregateId,
      revision: state.preferences.revision, occurredAt, causationId,
      schemaVersion: CONTRACT_SCHEMA_VERSION, payload,
    }));
  }

  private snapshot(state: TransactionState): AppSnapshot {
    const trips = state.tx.listTrips();
    const pets = state.tx.listPets().sort((a, b) => compareIds(a.petId, b.petId)).map((pet): PetSnapshot => {
      const active = trips.find((trip) => trip.snapshot.petId === pet.petId && trip.status === 'TRAVELING');
      const previous = trips.filter((trip) => trip.snapshot.petId === pet.petId && trip.status === 'SETTLED')
        .sort((a, b) => (b.checkpoint.actualReturnedAt ?? 0) - (a.checkpoint.actualReturnedAt ?? 0)
          || compareIds(b.snapshot.tripId, a.snapshot.tripId))[0];
      const trip = active ?? previous;
      return {
        petId: pet.petId, characterId: pet.characterId, nickname: pet.nickname,
        presence: pet.presence, activity: pet.activity, mood: pet.mood, healthStatus: pet.healthStatus,
        visibility: pet.visibility, moodScore: pet.moodScore10 / 10, healthPoints: pet.healthPoints10 / 10,
        energy: pet.energy10 / 10, bond: pet.bond10 / 10, level: levelForXp(pet.xp), xp: pet.xp,
        revision: pet.revision,
        ...(trip === undefined ? {} : { trip: {
          tripId: trip.snapshot.tripId, routeId: trip.snapshot.routeId, status: trip.status,
          // The historical projection retains the actual arrival rather than
          // jumping back to the original nominal itinerary after early return.
          expectedReturnAt: trip.status === 'SETTLED' ? trip.checkpoint.actualReturnedAt!
            : trip.checkpoint.phase === 'RETURNING' ? trip.checkpoint.nextDueAt! : trip.snapshot.expectedReturnAt,
        } }),
      };
    });
    const { revision, primaryPetId, doNotDisturb, pausedRender } = state.preferences;
    return appSnapshotSchema.parse({ revision, primaryPetId, doNotDisturb, pausedRender, pets,
      walletCoins: state.tx.getWalletCoins() });
  }

  /** Audit all active trips before advancing any of them; a failed audit rolls
   * back the whole request instead of repairing a corrupt checkpoint in place. */
  private advanceAll(state: TransactionState): void {
    const { tx } = state;
    const targetTime = Math.max(state.preferences.logicalTime, this.now());
    const pets = tx.listPets();
    for (const pet of pets) readHomeState(tx, pet, state.preferences.logicalTime);
    const active = tx.listTrips().filter((trip) => trip.status === 'TRAVELING');
    const travellingPets = new Set<string>();
    for (const trip of active) {
      const pet = pets.find((candidate) => candidate.petId === trip.snapshot.petId);
      const result = verifyReplay(trip, tx.listTripFacts(trip.snapshot.tripId));
      if (pet === undefined || travellingPets.has(pet.petId) || pet.presence !== result.presence
        || pet.activity !== null || trip.reportReadAt !== null
        || trip.checkpoint.logicalTime > state.preferences.logicalTime
        || tx.getSettlement(trip.snapshot.tripId) !== null || tx.listRewards(trip.snapshot.tripId).length !== 0) {
        throw new Error('Active trip and persisted game state are inconsistent');
      }
      travellingPets.add(pet.petId);
    }
    if (pets.some((pet) => (pet.presence !== 'HOME') !== travellingPets.has(pet.petId))) {
      throw new Error('Offsite pet is missing its active trip');
    }
    if (targetTime !== state.preferences.logicalTime) {
      state.preferences = { ...state.preferences, logicalTime: targetTime };
      tx.savePreferences(state.preferences);
    }

    // Resolve globally in due-time order so batched offline work and live reads
    // use the same ordering, even when both pets are away simultaneously.
    while (true) {
      active.sort((a, b) => a.checkpoint.nextDueAt! - b.checkpoint.nextDueAt!
        || compareIds(a.snapshot.petId, b.snapshot.petId) || compareIds(a.snapshot.tripId, b.snapshot.tripId));
      const next = active[0];
      if (next === undefined || next.checkpoint.nextDueAt! > targetTime) break;
      const result = advanceTrip(next.snapshot, next.checkpoint, next.checkpoint.nextDueAt!);
      const updated = this.commitProgress(state, next, result);
      if (updated.status === 'SETTLED') active.shift();
      else active[0] = updated;
    }
    // Advance logical cursors even with no due event, without changing a
    // business revision or emitting a visible update merely for a clock tick.
    for (const trip of active) {
      const result = advanceTrip(trip.snapshot, trip.checkpoint, targetTime);
      if (result.facts.length !== 0) throw new Error('Due travel event was skipped');
      if (result.checkpoint.logicalTime !== trip.checkpoint.logicalTime) {
        tx.updateTrip({ ...trip, checkpoint: result.checkpoint });
      }
    }

    // Resolve travel first. A pet that returned offline begins HOME recovery
    // at its verified actual returnedAt rather than at departure or the final
    // catch-up target. Still-away pets accrue no HOME needs.
    for (const pet of tx.listPets().sort((a, b) => compareIds(a.petId, b.petId))) {
      if (pet.presence !== 'HOME') continue;
      const home = readHomeState(tx, pet, state.preferences.logicalTime);
      this.persistHomeProjection(state, pet, advanceHomeState(home, targetTime));
    }
  }

  /** Replay from the frozen seed, route and recorded recall, then check against
   * the persisted history before applying newly produced facts or any rewards. */
  private commitProgress(state: TransactionState, trip: TripRecord, result: TripAdvanceResult,
    causationId?: string): TripRecord {
    const { tx } = state;
    const updated: TripRecord = { ...trip, checkpoint: result.checkpoint, status: result.status };
    const replayed = verifyReplay(updated, [...tx.listTripFacts(trip.snapshot.tripId), ...result.facts]);
    if (!equalJson(replayed.rewardDraft, result.rewardDraft) || replayed.presence !== result.presence) {
      throw new Error('Candidate trip effect disagrees with the verified replay');
    }
    if (result.facts.length === 0) return trip;
    const pet = tx.getPet(trip.snapshot.petId);
    if (pet === null || pet.presence === 'HOME') throw new Error('Missing active pet');
    tx.appendTripFacts(trip.snapshot.tripId, result.facts);
    this.revise(state);
    let updatedPet: PetRecord = { ...pet, presence: result.presence,
      activity: result.presence === 'HOME' ? 'IDLE' : null, revision: addNonnegative(pet.revision, 1) };
    for (const fact of result.facts) {
      this.event(state, 'TripCheckpointReached', trip.snapshot.tripId, causationId ?? fact.eventId,
        fact.scheduledAt, { petId: pet.petId, factId: fact.eventId, factType: fact.type, sequence: fact.sequence });
    }
    if (updated.status === 'SETTLED') {
      const lastFact = replayed.facts.at(-1);
      if (lastFact?.type !== 'TRIP_RETURNED' || updated.checkpoint.actualReturnedAt === null) {
        throw new Error('Settlement requires a verified return fact');
      }
      updatedPet = this.settle(state, updated, updatedPet, replayed.rewardDraft, causationId ?? lastFact.eventId);
    }
    // A presence transition establishes the new clock boundary. Do not move
    // an away pet's durable home clock to a later polling target before its
    // actual return has been processed in global due-time order.
    const transition = updatedPet.presence !== pet.presence
      ? transitionHomeState(readHomeState(tx, pet, state.preferences.logicalTime), updatedPet,
        updated.status === 'SETTLED' ? updated.checkpoint.actualReturnedAt! : result.checkpoint.logicalTime)
      : null;
    if (transition) updatedPet = applyHomeState(updatedPet, transition);
    tx.updateTrip(updated);
    tx.savePet(updatedPet);
    if (transition) tx.saveHomeSchedule(scheduleFromHome(transition));
    return updated;
  }

  private settle(state: TransactionState, trip: TripRecord, pet: PetRecord, rewards: RewardDraft,
    causationId: string): PetRecord {
    const { tx } = state;
    const tripId = trip.snapshot.tripId;
    const settledAt = trip.checkpoint.actualReturnedAt!;
    if (tx.getSettlement(tripId) !== null || tx.listRewards(tripId).length !== 0
      || !tx.insertSettlement({ tripId, settledAt, rewards })) {
      throw new Error('Active trip already has settlement data');
    }
    const previousLevel = levelForXp(pet.xp);
    let updatedPet = pet;
    const lines = rewardLines(trip, rewards);
    for (const line of lines) {
      // Uniqueness and the mutation it authorizes are in this same transaction.
      if (!tx.insertReward(line)) throw new Error('Unexpected duplicate reward in new settlement');
      switch (line.kind) {
        case 'XP':
          updatedPet = { ...updatedPet, xp: addNonnegative(updatedPet.xp, line.amount) };
          break;
        case 'COIN':
          tx.setWalletCoins(addNonnegative(tx.getWalletCoins(), line.amount));
          break;
        case 'ITEM': {
          const old = tx.listInventory().find((item) => item.itemId === line.targetId)?.quantity ?? 0;
          addNonnegative(old, line.amount);
          tx.addInventory(line.targetId, line.amount);
          break;
        }
        case 'CG': {
          const cgId = line.targetId.slice(0, -(CG_VARIANT.length + 1));
          if (tx.unlockCg({ petId: pet.petId, cgId, variant: CG_VARIANT, sourceTripId: tripId, unlockedAt: settledAt })) {
            this.event(state, 'CGUnlocked', pet.petId, causationId, settledAt, { tripId, cgId, variant: CG_VARIANT });
          }
          break;
        }
      }
    }
    if (!equalJson(sortedRewards(tx.listRewards(tripId)), sortedRewards(lines))) {
      throw new Error('Committed ledger does not match the verified reward draft');
    }
    const level = levelForXp(updatedPet.xp);
    if (level !== previousLevel) {
      this.event(state, 'LevelUp', pet.petId, causationId, settledAt, { previousLevel, level, tripId });
    }
    this.event(state, 'TripSettled', tripId, causationId, settledAt, { petId: pet.petId,
      reason: trip.checkpoint.returnReason, xp: rewards.xp, coins: rewards.coins });
    return updatedPet;
  }

  private verifySettledReport(state: TransactionState, trip: TripRecord): void {
    const { tx } = state;
    const result = verifyReplay(trip, tx.listTripFacts(trip.snapshot.tripId));
    const settlement = tx.getSettlement(trip.snapshot.tripId);
    if (settlement === null || settlement.tripId !== trip.snapshot.tripId
      || settlement.settledAt !== trip.checkpoint.actualReturnedAt || !equalJson(settlement.rewards, result.rewardDraft)
      || settlement.settledAt > state.preferences.logicalTime
      || (trip.reportReadAt !== null && (trip.reportReadAt < settlement.settledAt || trip.reportReadAt > state.preferences.logicalTime))
      || !equalJson(sortedRewards(tx.listRewards(trip.snapshot.tripId)), sortedRewards(rewardLines(trip, result.rewardDraft)))) {
      throw new Error('Settled report differs from the verified history');
    }
  }

  /** A business rejection is a value, not an exception: persist its receipt and
   * any previously due trip work, but no rejected command effects. */
  private execute(state: TransactionState, command: DomainCommand): Failure | undefined {
    const { tx, preferences } = state;
    const at = preferences.logicalTime;
    if (command.expectedRevision !== undefined && command.expectedRevision !== preferences.revision) {
      return failure('REVISION_CONFLICT', 'Game state has changed. Refresh the snapshot and create a new command.', true);
    }
    if (command.type === 'APP_SET_MODE') {
      const { flag, enabled } = command.payload;
      if (preferences[flag] !== enabled) {
        this.revise(state, { [flag]: enabled });
        this.event(state, 'AppModeChanged', 'app', command.commandId, at, { flag, enabled });
      }
      return;
    }
    if (command.type === 'SHOP_PURCHASE' || command.type === 'EQUIPMENT_EQUIP' || command.type === 'EQUIPMENT_UNEQUIP'
      || command.type === 'EQUIPMENT_UPGRADE' || command.type === 'EQUIPMENT_SALVAGE' || command.type === 'ITEM_USE') {
      const result = executeEconomyCommand(tx, command, at, () => this.runtime.createId('item'));
      if (!result.ok) return result;
      for (const affectedPetId of new Set(result.affectedPetIds)) {
        const affected = tx.getPet(affectedPetId);
        if (!affected) throw new Error('Economy mutation refers to an absent pet');
        tx.savePet({ ...affected, revision: addNonnegative(affected.revision, 1) });
      }
      this.revise(state);
      this.event(state, result.eventType, result.aggregateId, command.commandId, at, result.payload);
      return;
    }
    // Acquiring creates an instance and therefore has no existing petId to
    // look up. Every check and the debit happen in this command transaction.
    if (command.type === 'PET_ACQUIRE') {
      const { characterId, catalogVersion } = command.payload;
      if (catalogVersion !== CHARACTER_CATALOG_VERSION) {
        return failure('REVISION_CONFLICT', 'The character catalog has changed. Refresh it before acquiring a character.', true);
      }
      const context = characterAcquisitionContext(tx);
      const decision = evaluateCharacterAcquisition(characterId, context);
      if (!decision.ok) {
        switch (decision.reason) {
          case 'UNKNOWN_CHARACTER': return failure('NOT_FOUND', 'The character does not exist.');
          case 'ALREADY_OWNED': return failure('BUSINESS_RULE', 'This character has already been acquired.');
          case 'CAPACITY_REACHED': return failure('BUSINESS_RULE', 'The pet capacity has been reached.');
          case 'UNMET_REQUIREMENT': return failure('BUSINESS_RULE', 'More settled trips are required to acquire this character.');
          case 'INSUFFICIENT_COINS': return failure('BUSINESS_RULE', 'There are not enough in-game coins.');
        }
      }
      const petId = idSchema.parse(this.runtime.createId('pet'));
      if (tx.getPet(petId) !== null) throw new Error('Generated pet ID already exists');
      const acquired = createCharacterPet(decision.definition, petId, 'HIDDEN');
      const home = initialHomeState(acquired, at);
      tx.savePet(applyHomeState(acquired, home));
      if (decision.coinCost > 0) tx.setWalletCoins(context.walletCoins - decision.coinCost);
      tx.insertPetAcquisition({ petId, acquiredAt: at, origin: 'GAME', catalogVersion,
        coinCost: decision.coinCost, commandId: command.commandId });
      tx.saveHomeSchedule(scheduleFromHome(home));
      this.revise(state);
      this.event(state, 'PetAcquired', petId, command.commandId, at, { petId, characterId, catalogVersion, coinCost: decision.coinCost });
      return;
    }
    const pet = tx.getPet(command.payload.petId);
    if (pet === null) return failure('NOT_FOUND', 'The pet does not exist.');
    const updatePet = (changes: Partial<PetRecord>): void => {
      tx.savePet({ ...pet, ...changes, revision: addNonnegative(pet.revision, 1) });
      this.revise(state);
    };
    switch (command.type) {
      case 'PET_RENAME': {
        let nickname: string;
        try { nickname = normalizeCharacterNickname(command.payload.nickname); }
        catch { return failure('INVALID_REQUEST', 'Invalid pet nickname.'); }
        if (nickname !== pet.nickname) {
          // Nickname is presentation metadata only; presence, travel, stats,
          // acquisition identity and other pets are not changed by a rename.
          updatePet({ nickname });
          this.event(state, 'PetRenamed', pet.petId, command.commandId, at, { petId: pet.petId, nickname });
        }
        return;
      }
      case 'PET_SELECT':
        if (preferences.primaryPetId !== pet.petId) {
          this.revise(state, { primaryPetId: pet.petId });
          this.event(state, 'PetSelected', pet.petId, command.commandId, at, { petId: pet.petId });
        }
        return;
      case 'PET_INTERACT': {
        const { interaction } = command.payload;
        const result = interactHome(readHomeState(tx, pet, at), interaction, at);
        if (!result.accepted) return failure('BUSINESS_RULE', result.reason === 'ACTIVITY_BUSY'
          ? 'Finish the current activity before requesting rest or wake.' : 'The pet must be home to interact.');
        this.persistHomeProjection(state, pet, result.state, true);
        this.event(state, 'PetInteracted', pet.petId, command.commandId, at, { petId: pet.petId, interaction,
          rewardGranted: result.rewardGranted, reason: result.reason ?? null });
        return;
      }
      case 'PET_SET_VISIBILITY':
        // V1.1 section 17.2: the initial product has one visible companion
        // slot. The choice is independent of primary pet and travel presence.
        // Replace the slot in the same transaction rather than temporarily
        // exposing two visible pets or making the renderer hide one itself.
        {
          const changes: Array<{ record: PetRecord; visibility: PetRecord['visibility'] }> = [];
          if (command.payload.visibility === 'VISIBLE') {
            for (const other of tx.listPets()) {
              if (other.petId !== pet.petId && other.visibility === 'VISIBLE') {
                changes.push({ record: other, visibility: 'HIDDEN' });
              }
            }
          }
          if (command.payload.visibility !== pet.visibility) changes.push({ record: pet, visibility: command.payload.visibility });
          for (const change of changes) {
            tx.savePet({ ...change.record, visibility: change.visibility, revision: addNonnegative(change.record.revision, 1) });
          }
          if (changes.length > 0) this.revise(state);
          for (const change of changes) {
            this.event(state, 'PetStateChanged', change.record.petId, command.commandId, at,
              { petId: change.record.petId, visibility: change.visibility });
          }
        }
        return;
      case 'TRIP_START': {
        if (command.payload.routeId !== DEMO_ROUTE.routeId) return failure('NOT_FOUND', 'The route does not exist.');
        if (pet.presence !== 'HOME' || pet.healthStatus !== 'NORMAL' || pet.healthPoints10 <= 0
          || pet.energy10 < DEPARTURE_ENERGY10) {
          return failure('BUSINESS_RULE', 'A healthy pet at home needs at least 15 energy to travel.');
        }
        if (pet.activity === 'CHAT') return failure('BUSINESS_RULE', 'Finish the current conversation before travelling.');
        // The visible projection is already current; recompute any fractions
        // not yet durably saved by its preceding read-only tick before leaving.
        const beforeDeparture = advanceHomeState(readHomeState(tx, pet, at), at);
        // New trips freeze the current progression/equipment-derived power;
        // replay continues to use the exact immutable power in old snapshots.
        const snapshot = createTripSnapshot({ tripId: this.runtime.createId('trip'), petId: pet.petId,
          power: battleProjection(tx, pet).battlePower, seed: this.runtime.seed(), startAt: at, route: DEMO_ROUTE });
        tx.insertTrip({ snapshot, checkpoint: createTripCheckpoint(snapshot), status: 'TRAVELING', reportReadAt: null });
        // Freeze the CG content identity in the same transaction as departure.
        // The trip snapshot and reward keys intentionally retain their existing
        // deterministic format; only its eventual first acquisition gains a
        // separately persisted historical asset reference.
        for (const pin of freezeTripCgAssets(pet, snapshot)) tx.insertTripCgAssetPin(pin);
        const offsite: PetRecord = { ...applyHomeState(pet, beforeDeparture), presence: 'AWAY', activity: null,
          energy10: beforeDeparture.energy10 - DEPARTURE_ENERGY10 };
        const awayHome = transitionHomeState(beforeDeparture, offsite, at);
        this.persistHomeProjection(state, pet, awayHome, true);
        this.event(state, 'TripStarted', snapshot.tripId, command.commandId, at,
          { petId: pet.petId, routeId: snapshot.routeId, expectedReturnAt: snapshot.expectedReturnAt });
        return;
      }
      case 'TRIP_RECALL': {
        const trip = tx.getTrip(command.payload.tripId);
        if (trip === null || trip.snapshot.petId !== pet.petId) return failure('NOT_FOUND', 'The trip does not exist for this pet.');
        if (trip.status !== 'TRAVELING') return failure('BUSINESS_RULE', 'This trip is already settled.');
        if (trip.checkpoint.phase === 'RETURNING') return;
        this.commitProgress(state, trip, recallTrip(trip.snapshot, trip.checkpoint, at), command.commandId);
        return;
      }
      case 'TRIP_REPORT_READ': {
        const trip = tx.getTrip(command.payload.tripId);
        if (trip === null || trip.snapshot.petId !== pet.petId) return failure('NOT_FOUND', 'The trip does not exist for this pet.');
        if (trip.status !== 'SETTLED') return failure('BUSINESS_RULE', 'The report is not ready yet.');
        this.verifySettledReport(state, trip);
        if (trip.reportReadAt === null) {
          tx.updateTrip({ ...trip, reportReadAt: at });
          this.revise(state);
          this.event(state, 'TripReportRead', trip.snapshot.tripId, command.commandId, at, { petId: pet.petId });
        }
        return;
      }
      case 'CG_SET_FAVORITE': {
        const { cgId, variant, favorite } = command.payload;
        const unlock = tx.getCgUnlock(pet.petId, cgId, variant);
        if (unlock === null) return failure('NOT_FOUND', 'The CG has not been unlocked for this pet.');
        if (unlock.favorite !== favorite) {
          if (!tx.setCgFavorite(pet.petId, cgId, variant, favorite)) throw new Error('CG favorite update did not commit');
          this.revise(state);
          this.event(state, 'CGFavoriteChanged', pet.petId, command.commandId, at, { petId: pet.petId, cgId, variant, favorite });
        }
        return;
      }
      case 'CG_MARK_VIEWED': {
        const { cgId, variant, characterId, eventDefId, assetVersion, assetHash } = command.payload;
        const unlock = tx.getCgUnlock(pet.petId, cgId, variant);
        if (unlock === null) return failure('NOT_FOUND', 'The CG has not been unlocked for this pet.');
        const ref = unlock.assetRef;
        if (ref.state !== 'PINNED' || ref.characterId !== characterId || ref.eventDefId !== eventDefId
          || ref.assetVersion !== assetVersion || ref.assetHash !== assetHash) {
          return failure('BUSINESS_RULE', 'The requested image does not match the historical acquisition.');
        }
        if (unlock.viewedAt === null) {
          if (!tx.markCgViewed(pet.petId, cgId, variant, characterId, eventDefId, assetVersion, assetHash, at)) {
            throw new Error('CG first-view update did not commit');
          }
          this.revise(state);
          this.event(state, 'CGViewed', pet.petId, command.commandId, at, { petId: pet.petId, cgId, variant });
        }
        return;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  /** Queries are authoritative and may need to catch up settled travel first. */
  getSnapshot(): AppSnapshot {
    if (this.closed) throw new Error('Service is closed');
    return this.repository.transaction((tx) => {
      const state = this.state(tx);
      this.advanceAll(state);
      return this.snapshot(state);
    });
  }

  /** Gallery and its revisioned snapshot share one authoritative transaction. */
  private getGallery(query: GalleryQuery): GalleryOutcome {
    return this.repository.transaction((tx) => {
      const state = this.state(tx);
      this.advanceAll(state);
      if (query.petId !== undefined && tx.getPet(query.petId) === null) {
        return failure('NOT_FOUND', 'The pet does not exist.');
      }
      const snapshot = this.snapshot(state);
      return { ok: true, snapshot, gallery: projectGallery(tx, query, snapshot.revision) };
    });
  }

  private getCharacters(): CharactersOutcome {
    return this.repository.transaction((tx) => {
      const state = this.state(tx);
      this.advanceAll(state);
      const snapshot = this.snapshot(state);
      return { ok: true, snapshot, characters: projectCharacterCatalog(tx, snapshot.revision) };
    });
  }

  private getInventory(legacyOffset = 0): InventoryOutcome {
    return this.repository.transaction((tx) => {
      const state = this.state(tx);
      this.advanceAll(state);
      const snapshot = this.snapshot(state);
      return { ok: true, snapshot, inventory: projectInventory(tx, snapshot.revision, legacyOffset) };
    });
  }

  dispatch(command: DomainCommand): CommandOutcome {
    if (this.closed) return unavailable();
    const parsed = domainCommandSchema.safeParse(command);
    if (!parsed.success) return failure('INVALID_REQUEST', 'Invalid game command.');
    const closedCommand = parsed.data;
    const fingerprint = canonicalJson(closedCommand);
    try {
      return this.repository.transaction((tx) => {
        const previous = tx.getCommandReceipt(closedCommand.commandId);
        if (previous !== null) {
          return previous.fingerprint === fingerprint ? previous.outcome
            : failure('COMMAND_CONFLICT', 'The command ID was already used for a different command.');
        }
        const state = this.state(tx);
        this.advanceAll(state);
        const denied = this.execute(state, closedCommand);
        const outcome: CommandOutcome = denied ?? { ok: true, snapshot: this.snapshot(state) };
        tx.saveCommandReceipt({ commandId: closedCommand.commandId, fingerprint, outcome,
          createdAt: state.preferences.logicalTime });
        return outcome;
      });
    } catch (error) {
      return transactionFailure(error);
    }
  }

  handleRequest(raw: unknown): IpcResult {
    // Try to preserve a valid caller ID even on malformed envelopes. No detailed
    // Zod error, database exception or untrusted field is reflected back.
    let requestId = 'invalid-request';
    const respondError = (outcome: Failure): IpcResult => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION, ok: false, error: { ...outcome.error, requestId },
    });
    try {
      const candidate = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'requestId')
        ? idSchema.safeParse((raw as { requestId?: unknown }).requestId) : null;
      requestId = candidate?.success ? candidate.data : idSchema.parse(this.runtime.createId('request'));
      const parsed = ipcRequestSchema.safeParse(raw);
      if (!parsed.success) return respondError(failure('INVALID_REQUEST', 'Invalid application request.'));
      requestId = parsed.data.requestId;
      if (this.closed) return respondError(unavailable());
      if (parsed.data.method === 'gallery/list') {
        const outcome = this.getGallery(parsed.data.payload);
        return outcome.ok ? { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: true, requestId,
          snapshot: outcome.snapshot, gallery: outcome.gallery } : respondError(outcome);
      }
      if (parsed.data.method === 'characters/list') {
        const outcome = this.getCharacters();
        return { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: true, requestId,
          snapshot: outcome.snapshot, characters: outcome.characters };
      }
      if (parsed.data.method === 'inventory/list') {
        const outcome = this.getInventory(parsed.data.payload.legacyOffset ?? 0);
        return { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: true, requestId,
          snapshot: outcome.snapshot, inventory: outcome.inventory };
      }
      const outcome = parsed.data.method === 'snapshot/get' ? { ok: true as const, snapshot: this.getSnapshot() }
        : this.dispatch(parsed.data.payload.command);
      return outcome.ok ? { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: true, requestId, snapshot: outcome.snapshot }
        : respondError(outcome);
    } catch (error) {
      return respondError(transactionFailure(error));
    }
  }

  close(): void {
    if (this.closed) return;
    this.repository.close();
    this.closed = true;
  }
}
