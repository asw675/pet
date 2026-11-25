import { describe, expect, it } from 'vitest';
import type { AppSnapshot, PetSnapshot, TripSnapshot } from '@pet-desktop/contracts';
import { TravelReturnNotices } from '../src/main/travel-return-notices';

function pet(petId: string, tripId: string, status: TripSnapshot['status']): PetSnapshot {
  return {
    petId, characterId: 'star-singer', nickname: '星咏', presence: status === 'SETTLED' ? 'HOME' : 'AWAY',
    activity: status === 'SETTLED' ? 'IDLE' : null, mood: 'CALM', healthStatus: 'NORMAL', visibility: 'VISIBLE',
    moodScore: 50, healthPoints: 100, energy: 50, bond: 0, level: 1, xp: 0, revision: 0,
    trip: { tripId, routeId: 'meadow', status, expectedReturnAt: 1_700_000_000_000 },
  };
}

function snapshot(revision: number, ...pets: PetSnapshot[]): AppSnapshot {
  return { revision, primaryPetId: null, pets, walletCoins: 0, doNotDisturb: false, pausedRender: false };
}

describe('travel return summaries', () => {
  it('aggregates only matching transitions from in progress to committed settlement', () => {
    const notices = new TravelReturnNotices();
    const before = snapshot(1, pet('a', 'trip-a', 'TRAVELING'), pet('b', 'trip-b', 'TRAVELING'), pet('c', 'trip-c', 'TRAVELING'));
    const first = snapshot(2, pet('a', 'trip-a', 'SETTLED'), pet('b', 'trip-b', 'TRAVELING'), pet('c', 'unrelated', 'SETTLED'));
    const second = snapshot(3, pet('a', 'trip-a', 'SETTLED'), pet('b', 'trip-b', 'SETTLED'));
    notices.observe(before, first);
    notices.observe(first, second);
    expect(notices.pendingCount).toBe(2);
    expect(notices.presentedCount).toBe(0);
    notices.markPresented();
    expect(notices.presentedCount).toBe(2);
    expect(notices.pendingCount).toBe(0);
  });

  it('keeps newly pending returns when a previously presented summary is acknowledged', () => {
    const notices = new TravelReturnNotices();
    const before = snapshot(1, pet('a', 'trip-a', 'TRAVELING'), pet('b', 'trip-b', 'TRAVELING'));
    const first = snapshot(2, pet('a', 'trip-a', 'SETTLED'), pet('b', 'trip-b', 'TRAVELING'));
    notices.observe(before, first);
    notices.markPresented();
    notices.observe(first, snapshot(3, pet('b', 'trip-b', 'SETTLED')));
    notices.acknowledgePresented();
    expect(notices.presentedCount).toBe(0);
    expect(notices.pendingCount).toBe(1);
  });

  it('does not treat startup history, duplicate revisions or rollbacks as a new return', () => {
    const notices = new TravelReturnNotices();
    const before = snapshot(2, pet('a', 'trip-a', 'TRAVELING'));
    const past = snapshot(1, pet('a', 'trip-a', 'SETTLED'));
    notices.observe(undefined, past);
    notices.observe(before, past);
    notices.observe(before, snapshot(2, ...past.pets));
    expect(notices.pendingCount).toBe(0);
  });
});
