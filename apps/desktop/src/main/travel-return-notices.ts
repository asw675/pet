import type { AppSnapshot } from '@pet-desktop/contracts';

/** Counts observed commits once. Startup and a new service generation begin
 * from a fresh baseline. Durable reports remain in the travel center. */
export class TravelReturnNotices {
  private pending = 0;
  private presented = 0;

  observe(previous: AppSnapshot | undefined, next: AppSnapshot): void {
    if (!previous || next.revision <= previous.revision) return;
    const travelling = new Map(previous.pets.flatMap(pet =>
      pet.trip?.status === 'TRAVELING' ? [[pet.petId, pet.trip.tripId] as const] : []));
    for (const pet of next.pets) {
      if (pet.trip?.status !== 'SETTLED' || travelling.get(pet.petId) !== pet.trip.tripId) continue;
      this.pending = Math.min(this.pending + 1, 10_000);
    }
  }

  get pendingCount(): number { return this.pending; }
  get presentedCount(): number { return this.presented; }

  markPresented(): void {
    this.presented = Math.min(this.presented + this.pending, 10_000);
    this.pending = 0;
  }

  acknowledgePresented(): void { this.presented = 0; }
}
