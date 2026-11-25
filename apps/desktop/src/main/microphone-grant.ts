import { idSchema } from '@pet-desktop/contracts';
import { voiceJobSchema } from '@pet-desktop/contracts/voice';
import type { VoiceJob } from '@pet-desktop/contracts/voice';
import { authorizeSender } from './boundary';
import type { SenderContext, WindowBinding } from './boundary';

export interface MicrophoneGrant {
  readonly grantId: string;
  readonly job: VoiceJob;
}
export interface MicrophoneAuthorityContext {
  readonly binding: WindowBinding | undefined;
  readonly sender: SenderContext;
  /** Host-observed document epoch and service epoch; not renderer inputs. */
  readonly documentEpoch: number;
  readonly serviceGeneration: number;
  readonly eligible: boolean;
}
interface ApprovalOwner {
  readonly senderId: number;
  readonly documentEpoch: number;
  readonly serviceGeneration: number;
}
interface PendingApproval extends ApprovalOwner {
  readonly grant: MicrophoneGrant;
  readonly expiresAt: number;
}

function owner(context: MicrophoneAuthorityContext): ApprovalOwner | null {
  if (!context.eligible || !authorizeSender(context.binding, context.sender, 'control-center')
    || !Number.isSafeInteger(context.documentEpoch) || context.documentEpoch < 0
    || !Number.isSafeInteger(context.serviceGeneration) || context.serviceGeneration < 0) return null;
  return { senderId: context.sender.senderId, documentEpoch: context.documentEpoch, serviceGeneration: context.serviceGeneration };
}
function sameOwner(a: ApprovalOwner | null, b: ApprovalOwner): boolean {
  return a !== null && a.senderId === b.senderId && a.documentEpoch === b.documentEpoch && a.serviceGeneration === b.serviceGeneration;
}
function sameJob(a: VoiceJob, b: VoiceJob): boolean {
  return a.petId === b.petId && a.conversationId === b.conversationId && a.turnId === b.turnId
    && a.generation === b.generation && a.requestId === b.requestId;
}
const validTime = (now: number): boolean => Number.isFinite(now) && now >= 0;

/** Single, ephemeral permission broker. Main validates the real document and
 * receives explicit trusted native approval before calling approve(). The
 * renderer cannot mint a grant or broaden it to any other browser permission.
 * No permission is granted via a generic permission *check*: Chromium must
 * make a new media request and consume the exact pending one-shot lease. */
export class MicrophoneGrantPolicy {
  private pending: PendingApproval | undefined;
  private consumed: PendingApproval | undefined;

  constructor(private readonly createId: () => string, private readonly now: () => number,
    private readonly lifetimeMs = 15_000) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 20_000) throw new Error('Invalid microphone lease lifetime');
  }

  approve(context: MicrophoneAuthorityContext, rawJob: unknown): MicrophoneGrant | null {
    const bound = owner(context), parsed = voiceJobSchema.safeParse(rawJob), now = this.now();
    if (!bound || !parsed.success || !validTime(now)) return null;
    this.expirePending(now);
    // Never let a second renderer gesture silently supersede an active job.
    if (this.pending || this.consumed) return null;
    const grantId = idSchema.parse(this.createId());
    const grant = Object.freeze({ grantId, job: Object.freeze({ ...parsed.data }) });
    this.pending = { ...bound, grant, expiresAt: now + this.lifetimeMs };
    return grant;
  }

  private expirePending(now: number): void {
    if (!validTime(now) || (this.pending && now >= this.pending.expiresAt)) this.pending = undefined;
    // A consumed lease is intentionally NOT silently expired: the host must
    // stop/destroy an unresponsive capture before granting another stream.
  }

  /** Current Chromium request details must identify audio-only and the exact
   * trusted main frame. Reject missing/duplicate/mixed media types. */
  consumeMediaRequest(context: MicrophoneAuthorityContext, permission: string, mediaTypes: unknown): boolean {
    const now = this.now(); this.expirePending(now);
    if (permission !== 'media' || !Array.isArray(mediaTypes) || mediaTypes.length !== 1 || mediaTypes[0] !== 'audio'
      || !this.pending || !sameOwner(owner(context), this.pending)) return false;
    this.consumed = { ...this.pending, expiresAt: now + 35_000 };
    this.pending = undefined;
    return true;
  }

  /** Checks never cache persistent browser permission. Actual access must use
   * the request handler above; camera, screen capture, etc. remain denied. */
  checkPermission(): false { return false; }

  /** Host watchdog: if a consumed lease outlives the capture deadline, the
   * host must close/recover its owner rather than rearming permission. */
  overdueCapture(): MicrophoneGrant | null {
    const now = this.now();
    return this.consumed && (!validTime(now) || now >= this.consumed.expiresAt) ? this.consumed.grant : null;
  }

  revoke(context: MicrophoneAuthorityContext, rawGrant: unknown): boolean {
    if (!rawGrant || typeof rawGrant !== 'object' || !('grantId' in rawGrant) || !('job' in rawGrant)
      || Object.keys(rawGrant).length !== 2 || !idSchema.safeParse(rawGrant.grantId).success) return false;
    const job = voiceJobSchema.safeParse(rawGrant.job);
    if (!job.success) return false;
    const bound = owner(context);
    for (const state of [this.pending, this.consumed]) {
      if (!state || !sameOwner(bound, state) || state.grant.grantId !== rawGrant.grantId || !sameJob(state.grant.job, job.data)) continue;
      if (this.pending === state) this.pending = undefined;
      if (this.consumed === state) this.consumed = undefined;
      return true;
    }
    return false;
  }

  /** Trusted host shutdown, reload, lock/suspend, focus loss or service
   * generation change. Returns the exact canceled job for renderer cleanup. */
  invalidate(senderId?: number): MicrophoneGrant | null {
    const state = this.pending ?? this.consumed;
    if (!state || (senderId !== undefined && senderId !== state.senderId)) return null;
    this.pending = undefined; this.consumed = undefined;
    return state.grant;
  }
}
