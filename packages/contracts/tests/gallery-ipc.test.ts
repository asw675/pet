import { describe, expect, it } from 'vitest';
import { domainCommandSchema, galleryIpcResultSchema, ipcRequestSchema, ipcResultSchema, resultMatchesMethod, snapshotIpcResultSchema } from '../src/index.js';

const snapshot = { revision: 4, primaryPetId: null, pets: [], walletCoins: 0, doNotDisturb: false, pausedRender: false };
const snapshotResult = { schemaVersion: 1 as const, ok: true as const, requestId: 'gallery-request', snapshot };
const gallery = { revision: 4, offset: 0, limit: 12, total: 0, rows: [] };
const galleryResult = { ...snapshotResult, gallery };
const request = { schemaVersion: 1, requestId: 'gallery-request', method: 'gallery/list', payload: { filter: 'ALL', offset: 0, limit: 12 } };

describe('gallery transport DTO compatibility', () => {
  it('admits only the closed paginated gallery query', () => {
    expect(ipcRequestSchema.parse(request).method).toBe('gallery/list');
    for (const payload of [{ ...request.payload, path: '/untrusted' }, { ...request.payload, limit: 51 }, { filter: 'ALL' }]) {
      expect(ipcRequestSchema.safeParse({ ...request, payload }).success).toBe(false);
    }
  });

  it('preserves the historical snapshot success shape exactly', () => {
    expect(snapshotIpcResultSchema.parse(snapshotResult)).toEqual(snapshotResult);
    expect(ipcResultSchema.parse(snapshotResult)).toEqual(snapshotResult);
    expect(resultMatchesMethod('snapshot/get', snapshotResult)).toBe(true);
    expect(resultMatchesMethod('command/dispatch', snapshotResult)).toBe(true);
    expect(resultMatchesMethod('gallery/list', snapshotResult)).toBe(false);
  });

  it('requires gallery results with the identical snapshot revision and matching query method', () => {
    const result = galleryIpcResultSchema.parse(galleryResult);
    expect(result).toEqual(galleryResult);
    expect(resultMatchesMethod('gallery/list', result)).toBe(true);
    expect(resultMatchesMethod('snapshot/get', result)).toBe(false);
    expect(resultMatchesMethod('command/dispatch', result)).toBe(false);
    expect(snapshotIpcResultSchema.safeParse(galleryResult).success).toBe(false);
    expect(galleryIpcResultSchema.safeParse(snapshotResult).success).toBe(false);
    expect(ipcResultSchema.safeParse({ ...galleryResult, gallery: { ...gallery, revision: 3 } }).success).toBe(false);
    expect(ipcResultSchema.safeParse({ ...galleryResult, path: 'private' }).success).toBe(false);
  });

  it('preserves common error results for every method', () => {
    const failure = ipcResultSchema.parse({ schemaVersion: 1, ok: false,
      error: { code: 'FORBIDDEN', requestId: 'gallery-request', retryable: false, message: 'Forbidden' } });
    expect(resultMatchesMethod('gallery/list', failure)).toBe(true);
    expect(resultMatchesMethod('command/dispatch', failure)).toBe(true);
    expect(resultMatchesMethod('snapshot/get', failure)).toBe(true);
  });

  it('admits the new narrow commands with no authority-granting or file data', () => {
    const common = { commandId: 'cg-command', issuedAt: 10, expectedRevision: 4 };
    const key = { petId: 'pet-1', cgId: 'morning-dew', variant: 'default' };
    expect(domainCommandSchema.parse({ ...common, type: 'CG_SET_FAVORITE', payload: { ...key, favorite: true } }).type).toBe('CG_SET_FAVORITE');
    const pin = { ...key, characterId: 'star-singer', eventDefId: 'dew-postcard', assetVersion: '1.0.0', assetHash: 'a'.repeat(64) };
    expect(domainCommandSchema.parse({ ...common, type: 'CG_MARK_VIEWED', payload: pin }).type).toBe('CG_MARK_VIEWED');
    expect(domainCommandSchema.safeParse({ ...common, type: 'CG_MARK_VIEWED', payload: { ...pin, viewedAt: 5 } }).success).toBe(false);
    expect(domainCommandSchema.safeParse({ ...common, type: 'CG_UNLOCK', payload: key }).success).toBe(false);
  });
});
