import { describe, expect, it } from 'vitest';
import { proactiveIntentSchema, proactiveResultMatches, proactiveResultSchema } from '../src/shared/proactive-ipc';
import type { ProactiveRequest } from '../src/shared/proactive-ipc';

describe('proactive settings and notice contracts', () => {
  it('requires a revision, a real quiet interval and explicit permission for local generation', () => {
    const payload = { petId: 'pet-1', expectedRevision: 0, enabled: false, useLocalAi: false, quietHours: null };
    expect(proactiveIntentSchema.safeParse({ method: 'settings/set', payload }).success).toBe(true);
    expect(proactiveIntentSchema.safeParse({ method: 'settings/set', payload: { ...payload, useLocalAi: true } }).success).toBe(false);
    expect(proactiveIntentSchema.safeParse({ method: 'settings/set', payload: { ...payload, quietHours: { startMinute: 22, endMinute: 22 } } }).success)
      .toBe(false);
    expect(proactiveIntentSchema.safeParse({ method: 'settings/set', payload: { ...payload, providerId: 'other' } }).success).toBe(false);
  });

  it('rejects a result for another pet, offset or request', () => {
    const request: ProactiveRequest = { requestId: 'q1', intent: { method: 'notices/list',
      payload: { petId: 'pet-1', offset: 0, limit: 10, filter: 'UNREAD' } } };
    const data = { ...request.intent.payload, rows: [] };
    const reply = { ok: true, requestId: 'q1', method: 'notices/list', data };
    expect(proactiveResultMatches(request, proactiveResultSchema.parse(reply))).toBe(true);
    expect(proactiveResultMatches(request, proactiveResultSchema.parse({ ...reply, requestId: 'q2' }))).toBe(false);
    expect(proactiveResultMatches(request, proactiveResultSchema.parse({ ...reply, data: { ...data, petId: 'pet-2' } }))).toBe(false);
    expect(proactiveResultMatches(request, proactiveResultSchema.parse({ ...reply, data: { ...data, offset: 10 } }))).toBe(false);
  });
});
