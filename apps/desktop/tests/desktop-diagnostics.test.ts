import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DesktopDiagnostics, diagnosticsRetentionMs, diagnosticExitReason, recordRequestDiagnostic } from '../src/main/desktop-diagnostics';

let root: string;
let now: number;
let logger: DesktopDiagnostics;
const initial = Date.parse('2026-11-01T12:00:00.000Z');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pet-diagnostics-'));
  now = initial;
  logger = new DesktopDiagnostics({ userDataDirectory: root, appVersion: '0.0.0', now: () => now });
});

afterEach(async () => {
  await logger.stop();
  await rm(root, { recursive: true, force: true });
});

async function exportJson(name: string) {
  const destination = join(root, name);
  const result = await logger.publish(destination, () => true);
  const contents = await readFile(destination, 'utf8');
  return { result, report: JSON.parse(contents), contents };
}

it('stores only versioned allowlisted fields and does not log fast successful requests', async () => {
  const trace = randomUUID();
  logger.record({ event: 'service-stage', stage: 'READY', generation: 1 });
  logger.record({ event: 'window-exited', role: 'pet', reason: diagnosticExitReason('unexpected private value') });
  logger.record({ event: 'window-loaded', role: 'control-center', audio: 'private audio' } as never);
  logger.record({ event: 'window-exited', role: 'pet', reason: 'secret' } as never);
  recordRequestDiagnostic(logger, 'ai', 'control-center', trace, 'OK', performance.now());
  recordRequestDiagnostic(logger, 'game', 'control-center', trace, 'TIMEOUT', performance.now() - 381);
  const { result, report, contents } = await exportJson('report.json');
  expect(result).toEqual({ entries: 3 });
  expect(report.format).toBe('pet-desktop-diagnostics-v1');
  expect(report.entries).toMatchObject([
    { appVersion: '0.0.0', protocolSchemaVersion: 1, level: 'info', detail: { event: 'service-stage', stage: 'READY', generation: 1 } },
    { level: 'warning', detail: { event: 'window-exited', role: 'pet', reason: 'other' } },
    { level: 'warning', detail: { event: 'request', area: 'game', requestId: trace, role: 'control-center', outcome: 'TIMEOUT' } },
  ]);
  expect(report.entries[2].detail.elapsedMs).toBeGreaterThanOrEqual(380);
  expect(contents).not.toMatch(/private|secret|audio/);
});

it('keeps at most three bounded slots per severity without rotating a separate error', async () => {
  logger.record({ event: 'service-stage', stage: 'READY', generation: 1 });
  logger.record({ event: 'host-startup-failed' });
  await logger.flush();
  const directory = join(root, '.pet-diagnostics');
  const line = await readFile(join(directory, 'info-0.jsonl'), 'utf8');
  const cap = 256 * 1024;
  const full = line.repeat(Math.floor(cap / Buffer.byteLength(line)));
  for (let index = 0; index < 3; index++) await writeFile(join(directory, `info-${index}.jsonl`), full, 'utf8');
  now++;
  logger.record({ event: 'service-stage', stage: 'READY', generation: 2 });
  await logger.flush();
  expect((await readdir(directory)).sort()).toEqual(['error-0.jsonl', 'info-0.jsonl', 'info-1.jsonl', 'info-2.jsonl']);
  expect((await stat(join(directory, 'info-2.jsonl'))).size).toBe(Buffer.byteLength(full));
  expect((await readFile(join(directory, 'info-0.jsonl'), 'utf8')).trim()).toContain('"generation":2');
  expect(await readFile(join(directory, 'error-0.jsonl'), 'utf8')).toContain('host-startup-failed');
});

it('prunes expiration and strips malformed, oversized, extra-field and misclassified records at export', async () => {
  logger.record({ event: 'service-stage', stage: 'READY', generation: 11 });
  await logger.flush();
  const directory = join(root, '.pet-diagnostics');
  const file = join(directory, 'info-0.jsonl');
  const original = JSON.parse(await readFile(file, 'utf8'));
  now = initial + diagnosticsRetentionMs + 1;
  const retained = { ...original, at: new Date(now).toISOString(), detail: { ...original.detail, generation: 12 } };
  await appendFile(file, JSON.stringify(retained) + '\n');
  logger.record({ event: 'service-stage', stage: 'READY', generation: 13 });
  await logger.flush();
  const disk = await readFile(file, 'utf8');
  expect(disk).not.toContain('"generation":11');
  expect(disk).toContain('"generation":12');
  await appendFile(file, [
    JSON.stringify({ ...retained, path: 'private-path' }),
    JSON.stringify({ ...retained, level: 'error', detail: { ...retained.detail, generation: 14 } }),
    JSON.stringify({ ...retained, at: '2099-01-01T00:00:00.000Z', detail: { ...retained.detail, generation: 15 } }),
    'invalid-secret-record',
  ].join('\n') + '\n');
  await writeFile(join(directory, 'warning-0.jsonl'), 'unbounded-secret'.repeat(40_000), 'utf8');
  await mkdir(join(directory, 'error-1.jsonl'));
  const { result, report, contents } = await exportJson('clean.json');
  expect(result).toEqual({ entries: 2 });
  expect(report.entries.map((entry: { detail: { generation: number } }) => entry.detail.generation)).toEqual([12, 13]);
  expect(contents).not.toMatch(/private-path|secret/);
});

it('publishes only to the authorized filename and neither overwrites nor leaves a cancelled candidate', async () => {
  const existing = join(root, 'exists.json');
  await writeFile(existing, 'keep');
  expect(await logger.publish(existing, () => true)).toBe('destination-exists');
  expect(await readFile(existing, 'utf8')).toBe('keep');
  const removed = join(root, 'revoked.json');
  let check = 0;
  expect(await logger.publish(removed, () => ++check < 3)).toBe('cancelled');
  expect(await readdir(root)).not.toContain('revoked.json');
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await expect(logger.publish('relative.json', () => true)).rejects.toThrow('Invalid diagnostic destination');
});
