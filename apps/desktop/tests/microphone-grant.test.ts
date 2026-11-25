import { describe, expect, it } from 'vitest';
import { MicrophoneGrantPolicy } from '../src/main/microphone-grant';
import type { MicrophoneAuthorityContext } from '../src/main/microphone-grant';
import type { VoiceJob } from '@pet-desktop/contracts/voice';

const url = 'file:///app/renderer/control-center/index.html';
const context: MicrophoneAuthorityContext = { binding: { senderId: 1, role: 'control-center', trustedUrl: url },
  sender: { senderId: 1, isMainFrame: true, frameUrl: `${url}#/chat`, documentUrl: `${url}#/chat` },
  serviceGeneration: 2, documentEpoch: 3, eligible: true };
const job = { petId: 'star', conversationId: 'chat-1', turnId: 'turn-1', generation: 1 } satisfies VoiceJob;
function fixture() { let now = 100, i = 0; const policy = new MicrophoneGrantPolicy(() => `grant-${++i}`, () => now); return { policy, at: (next: number) => { now = next; } }; }

describe('one-shot Main microphone grants', () => {
  it('requires bounded exact job and current trusted control-center context', () => {
    const { policy } = fixture();
    for (const changed of [{ eligible: false }, { binding: undefined }, { documentEpoch: -1 },
      { sender: { ...context.sender, isMainFrame: false } }, { sender: { ...context.sender, senderId: 2 } },
      { sender: { ...context.sender, frameUrl: 'https://example.invalid' } },
      { binding: { senderId: 1, role: 'pet', trustedUrl: url, petId: 'star' } }]) expect(policy.approve({ ...context, ...changed } as MicrophoneAuthorityContext, job)).toBeNull();
    expect(policy.approve(context, { ...job, token: 'not-allowed' })).toBeNull();
    expect(policy.approve(context, job)).toEqual({ grantId: 'grant-1', job });
  });
  it('does not authorize browser checks, screen, camera, mixed/unknown types or no lease', () => {
    const { policy } = fixture();
    expect(policy.checkPermission()).toBe(false);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(false);
    policy.approve(context, job);
    for (const [permission, types] of [['display-capture', ['audio']], ['media', ['video']], ['media', ['audio', 'video']], ['media', ['audio', 'audio']], ['media', undefined], ['media', []], ['geolocation', ['audio']]] as const) {
      expect(policy.consumeMediaRequest(context, permission, types)).toBe(false);
    }
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(true);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(false);
    expect(policy.checkPermission()).toBe(false);
  });
  it('binds native lease to sender, document, service epoch and denies stale approvals', () => {
    const { policy } = fixture(); policy.approve(context, job);
    for (const changed of [{ documentEpoch: 4 }, { serviceGeneration: 3 }, { eligible: false }, { sender: { ...context.sender, isMainFrame: false } }]) {
      expect(policy.consumeMediaRequest({ ...context, ...changed }, 'media', ['audio'])).toBe(false);
    }
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(true);
  });
  it('invalidates unconsumed permission after TTL, and refuses overlapping active capture', () => {
    const { policy, at } = fixture();
    const grant = policy.approve(context, job)!;
    expect(policy.approve(context, { ...job, turnId: 'turn-2' })).toBeNull();
    at(15_100);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(false);
    const next = policy.approve(context, { ...job, generation: 2 })!;
    expect(next.grantId).not.toBe(grant.grantId);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(true);
    expect(policy.approve(context, job)).toBeNull();
    at(50_100);
    expect(policy.overdueCapture()).toEqual(next);
    expect(policy.approve(context, job)).toBeNull(); // never silently overlap
    policy.invalidate();
    expect(policy.approve(context, job)).not.toBeNull();
  });
  it('only exact revoke releases the current lease; host invalidation is fail closed', () => {
    const { policy } = fixture(), grant = policy.approve(context, job)!;
    expect(policy.revoke(context, { ...grant, job: { ...job, turnId: 'other' } })).toBe(false);
    expect(policy.revoke({ ...context, documentEpoch: 4 }, grant)).toBe(false);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(true);
    expect(policy.revoke(context, grant)).toBe(true);
    expect(policy.revoke(context, grant)).toBe(false);
    const next = policy.approve(context, { ...job, generation: 2 })!;
    expect(policy.invalidate(2)).toBeNull();
    expect(policy.invalidate(1)).toEqual(next);
    expect(policy.consumeMediaRequest(context, 'media', ['audio'])).toBe(false);
  });
});
