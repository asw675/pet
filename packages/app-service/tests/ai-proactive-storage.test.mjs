import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { proactiveLimits } from '@pet-desktop/contracts/proactive';
import { AppService, SQLiteRepository } from '../src/index.ts';

const now = 1_800_000_000_000;
const petId = 'pet-1';
const settings = { petId, expectedRevision: 0, enabled: true, quietHours: null, useLocalAi: false };

function fixture(action) {
  const database = new DatabaseSync(':memory:');
  const repository = new SQLiteRepository(database, { persistent: false });
  const service = new AppService(repository, { now: () => now, createId: kind => `fixture-${kind}`, seed: () => 1 });
  try {
    return service.withFeatureTransaction(tx => action(tx.proactive()));
  } finally {
    service.close();
  }
}

function notice(input = {}) {
  return { noticeId: 'fixture-notice', petId, trigger: 'RETURNED', sourceKey: 'return:fixture-trip',
    sourceAt: now, createdAt: now, text: '测试提醒', generation: null, ...input };
}

describe('private proactive notice storage on SQLite', () => {
  it('defaults to disabled and consumes each source only once after explicit consent', () => fixture(storage => {
    expect(storage.getSettings(petId)).toMatchObject({ enabled: false, revision: 0, enabledAt: null });
    expect(storage.reserve(notice())).toBeNull();
    expect(storage.setSettings(settings, now)).toMatchObject({ enabled: true, revision: 1, enabledAt: now });
    expect(() => storage.setSettings(settings, now)).toThrow(/revision conflict/);
    expect(storage.reserve(notice())).toMatchObject({ deliveryStatus: 'READY', generation: null, responseKind: 'RULE' });
    const later = now + proactiveLimits.cooldownMs;
    expect(storage.reserve(notice({ noticeId: 'duplicate', createdAt: later }))).toBeNull();
    expect(storage.reserve(notice({ noticeId: 'too-soon', sourceKey: 'return:new-trip', createdAt: now + 2 }))).toBeNull();
  }));

  it('retains a pending local generation privately and falls back safely when consent is withdrawn', () => fixture(storage => {
    storage.setSettings({ ...settings, useLocalAi: true }, now);
    const generation = { requestId: 'fixture-turn', conversationId: 'fixture-conversation', kind: 'LOCAL_AI' };
    expect(storage.reserve(notice({ generation }))).toMatchObject({ deliveryStatus: 'PENDING' });
    const identity = { petId, requestId: generation.requestId, conversationId: generation.conversationId };
    expect(storage.listNotices(petId, 0, 20, 'ALL').rows).toEqual([]);
    expect(storage.isAuthorizedGeneration(identity)).toBe(true);
    expect(storage.isAuthorizedGeneration({ ...identity, petId: 'pet-2' })).toBe(false);
    storage.setSettings({ ...settings, expectedRevision: 1, enabled: false }, now + 5);
    expect(storage.isAuthorizedGeneration(identity)).toBe(false);
    expect(storage.recoverPending(now + 6)).toBe(1);
    expect(storage.listNotices(petId, 0, 20, 'UNREAD').rows).toEqual([]);
    expect(storage.getNotice(petId, 'fixture-notice')).toMatchObject({ deliveryStatus: 'DISMISSED', responseKind: 'RULE' });
  }));

  it('uses persisted low-energy episodes, and acknowledgments and dismissals are idempotent', () => fixture(storage => {
    storage.setSettings(settings, now);
    const low = storage.observeLowEnergy(petId, true, now);
    expect(low).toMatchObject({ episode: 1, low: true, lowSince: now });
    expect(storage.reserve(notice({ trigger: 'LOW_ENERGY', sourceKey: 'low:99' }))).toBeNull();
    expect(storage.reserve(notice({ trigger: 'LOW_ENERGY', sourceKey: 'low:1' }))).not.toBeNull();
    expect(storage.acknowledge('pet-2', 'fixture-notice', now + 1)).toBe(false);
    expect(storage.acknowledge(petId, 'fixture-notice', now + 1)).toBe(true);
    expect(storage.acknowledge(petId, 'fixture-notice', now + 2)).toBe(false);
    expect(storage.dismiss(petId, 'fixture-notice', now + 2)).toBe(true);
    expect(storage.dismiss(petId, 'fixture-notice', now + 3)).toBe(false);
    storage.observeLowEnergy(petId, false, now + 4);
    expect(storage.observeLowEnergy(petId, true, now + 5)).toMatchObject({ episode: 2, lowSince: now + 5 });
  }));
});
