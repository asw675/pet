import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { CONTRACT_SCHEMA_VERSION, ipcErrorCodeSchema } from '@pet-desktop/contracts';
import { z } from 'zod';

const levels = ['info', 'warning', 'error'] as const;
type DiagnosticLevel = typeof levels[number];
const rotationSlots = 3;
const maxBytes = 256 * 1024;
const maxPending = 128;
const durationLimit = 300_000;
export const diagnosticsRetentionMs = 14 * 24 * 60 * 60 * 1000;
const maintenanceIntervalMs = 60 * 60 * 1000;
const version = z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z0-9.-]{1,40})?(?:\+[a-z0-9.-]{1,40})?$/i);
const windowRole = z.enum(['control-center', 'pet']);
const exitReason = z.enum(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction', 'other']);
const diagnosticEventSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('service-stage'),
    stage: z.enum(['STARTING', 'READY', 'RESTARTING', 'UNAVAILABLE', 'STOPPING']),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ event: z.enum(['window-loaded', 'window-load-failed', 'window-staging-timeout', 'window-presentation-failed', 'window-create-failed']), role: windowRole }),
  z.strictObject({ event: z.literal('window-exited'), role: windowRole, reason: exitReason }),
  z.strictObject({ event: z.literal('child-exited'), role: z.enum(['utility', 'gpu', 'other']), reason: exitReason }),
  z.strictObject({ event: z.enum(['host-startup-failed', 'service-shutdown-failed']) }),
  z.strictObject({
    event: z.literal('request'),
    area: z.enum(['game', 'ai']),
    role: windowRole,
    requestId: z.uuid(),
    outcome: z.union([z.literal('OK'), ipcErrorCodeSchema, z.literal('AI_UNAVAILABLE'), z.literal('AI_ERROR')]),
    elapsedMs: z.number().int().min(0).max(durationLimit),
  }),
]);
const diagnosticRecordSchema = z.strictObject({
  at: z.iso.datetime(),
  level: z.enum(levels),
  appVersion: version,
  protocolSchemaVersion: z.number().int().min(1).max(10_000),
  detail: diagnosticEventSchema,
});
type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;

function levelFor(event: DiagnosticEvent): DiagnosticLevel {
  switch (event.event) {
    case 'service-stage': return event.stage === 'UNAVAILABLE' ? 'error' : event.stage === 'RESTARTING' ? 'warning' : 'info';
    case 'window-loaded': return 'info';
    case 'child-exited':
    case 'window-exited': return event.reason === 'clean-exit' ? 'info' : 'warning';
    case 'request': return event.outcome === 'OK' ? 'info' : 'warning';
    case 'host-startup-failed':
    case 'service-shutdown-failed': return 'error';
    default: return 'warning';
  }
}

export function diagnosticExitReason(value: string): z.infer<typeof exitReason> {
  const result = exitReason.safeParse(value);
  return result.success ? result.data : 'other';
}

async function stat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function regularFile(path: string): Promise<Stats | undefined> {
  const info = await stat(path);
  if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Managed log is not a regular file');
  return info;
}

/** Filesystem reads use the original handle and at most one byte over the
 * storage cap. A replaced or hand-edited file cannot enlarge an export. */
async function readLog(path: string): Promise<string> {
  const info = await regularFile(path);
  if (!info) return '';
  if (info.size > maxBytes) throw new Error('Managed log is too large');
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (!sameFile(info, opened) || !opened.isFile() || opened.nlink !== 1) throw new Error('Managed log changed');
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxBytes) throw new Error('Managed log exceeded the bound');
    return buffer.subarray(0, count).toString('utf8');
  } finally { await file.close(); }
}

function filterRecords(text: string, level: DiagnosticLevel, now: number): DiagnosticRecord[] {
  const entries: DiagnosticRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.length > 1_024) continue;
    try {
      const entry = diagnosticRecordSchema.safeParse(JSON.parse(line));
      if (!entry.success || entry.data.level !== level || levelFor(entry.data.detail) !== level) continue;
      const time = Date.parse(entry.data.at);
      if (time >= now - diagnosticsRetentionMs && time <= now + 24 * maintenanceIntervalMs) entries.push(entry.data);
    } catch { /* Ignore incomplete or foreign records without preserving their text. */ }
  }
  return entries;
}

async function createNewFile(path: string, body: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(body, 'utf8');
    await file.close();
  }
  catch (error) {
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

interface DesktopDiagnosticsOptions {
  userDataDirectory: string;
  appVersion: string;
  now?: () => number;
}

export type DiagnosticPublication = { entries: number } | 'destination-exists' | 'cancelled';

export class DesktopDiagnostics {
  private sequence: Promise<void> = Promise.resolve();
  private pending = 0;
  private nextPrune = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: DesktopDiagnosticsOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleMaintenance();
    this.timer = setInterval(() => this.scheduleMaintenance(), maintenanceIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.flush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 1_000); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  flush(): Promise<void> { return this.sequence; }

  record(detail: DiagnosticEvent): void {
    const parsed = diagnosticEventSchema.safeParse(detail);
    if (!parsed.success) return;
    const at = this.now();
    if (!Number.isFinite(at) || at < 0 || at > 8.64e15) return;
    const level = levelFor(parsed.data);
    const record = diagnosticRecordSchema.safeParse({
      at: new Date(at).toISOString(), level, appVersion: this.options.appVersion,
      protocolSchemaVersion: CONTRACT_SCHEMA_VERSION, detail: parsed.data,
    });
    if (!record.success) return;
    this.enqueue(async () => {
      const directory = await this.logDirectory();
      if (at >= this.nextPrune) await this.prune(directory, at);
      const file = this.slot(directory, level, 0);
      const line = `${JSON.stringify(record.data)}\n`;
      let info = await regularFile(file);
      if (info && info.size + Buffer.byteLength(line) > maxBytes) {
        await this.rotate(directory, level);
        info = undefined;
      }
      if (!info) { await createNewFile(file, line); return; }
      const handle = await open(file, 'r+');
      try {
        const opened = await handle.stat();
        if (!sameFile(info, opened) || !opened.isFile() || opened.nlink !== 1 || info.size !== opened.size) return;
        const buffer = Buffer.from(line);
        let written = 0;
        while (written < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, opened.size + written);
          if (!bytesWritten) throw new Error('Managed log write failed');
          written += bytesWritten;
        }
      } finally { await handle.close(); }
    });
  }

  async publish(destination: string, isCurrent: () => boolean): Promise<DiagnosticPublication> {
    const entries = await this.run(async () => {
      const directory = await this.logDirectory();
      const now = this.now();
      const kept: DiagnosticRecord[] = [];
      for (const level of levels) {
        for (let index = rotationSlots - 1; index >= 0; index--) {
          kept.push(...filterRecords(await readLog(this.slot(directory, level, index)).catch(() => ''), level, now));
        }
      }
      return kept.sort((a, b) => a.at.localeCompare(b.at));
    });
    if (!isCurrent()) return 'cancelled';
    const name = basename(destination);
    if (!isAbsolute(destination) || !name.toLowerCase().endsWith('.json') || name.includes(':') || destination.includes('\0')) {
      throw new Error('Invalid diagnostic destination');
    }
    const parent = await realpath(dirname(destination));
    const target = join(parent, name);
    const staged = join(parent, `.pet-diagnostics-export-${randomUUID()}.tmp`);
    if (!isCurrent()) return 'cancelled';
    const body = JSON.stringify({ format: 'pet-desktop-diagnostics-v1', exportedAt: new Date(this.now()).toISOString(), entries }, null, 2) + '\n';
    await createNewFile(staged, body);
    try {
      if (!isCurrent()) return 'cancelled';
      try { await link(staged, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'destination-exists';
        throw error;
      }
      return { entries: entries.length };
    } finally { await unlink(staged).catch(() => {}); }
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(action);
    this.sequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueue(action: () => Promise<void>): void {
    if (this.pending >= maxPending) return;
    this.pending++;
    void this.run(async () => {
      try { await action(); } finally { this.pending--; }
    }).catch(() => { /* Diagnostics must not block application operation. */ });
  }

  private scheduleMaintenance(): void {
    this.enqueue(async () => {
      const now = this.now();
      await this.prune(await this.logDirectory(), now);
    });
  }

  private async logDirectory(): Promise<string> {
    const directory = join(await realpath(this.options.userDataDirectory), '.pet-diagnostics');
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid diagnostics directory');
    return directory;
  }

  private slot(directory: string, level: DiagnosticLevel, index: number): string {
    return join(directory, `${level}-${index}.jsonl`);
  }

  private async rotate(directory: string, level: DiagnosticLevel): Promise<void> {
    const oldest = this.slot(directory, level, rotationSlots - 1);
    if (await regularFile(oldest)) await unlink(oldest);
    for (let index = rotationSlots - 2; index >= 0; index--) {
      const source = this.slot(directory, level, index);
      if (await regularFile(source)) await rename(source, this.slot(directory, level, index + 1));
    }
  }

  private async prune(directory: string, at: number): Promise<void> {
    this.nextPrune = at + maintenanceIntervalMs;
    const candidate = join(directory, '.retention.tmp');
    if (await regularFile(candidate)) await unlink(candidate);
    for (const level of levels) {
      for (let index = 0; index < rotationSlots; index++) {
        const path = this.slot(directory, level, index);
        try {
          const info = await regularFile(path);
          if (!info) continue;
          if (info.size > maxBytes) { await unlink(path); continue; }
          const before = await readLog(path);
          if (!before) continue;
          const records = filterRecords(before, level, at);
          const after = records.map(entry => JSON.stringify(entry) + '\n').join('');
          if (after === before) continue;
          if (!after) { await unlink(path); continue; }
          await createNewFile(candidate, after);
          try { await rename(candidate, path); }
          finally { await unlink(candidate).catch(() => {}); }
        } catch { /* A changed local file must not prevent pruning other slots. */ }
      }
    }
  }
}

export function recordRequestDiagnostic(
  diagnostics: Pick<DesktopDiagnostics, 'record'> | undefined,
  area: 'game' | 'ai',
  role: z.infer<typeof windowRole>,
  requestId: string,
  outcome: Extract<DiagnosticEvent, { event: 'request' }>['outcome'],
  startTime: number,
): void {
  const elapsedMs = Math.max(0, Math.min(durationLimit, Math.round(performance.now() - startTime)));
  if (outcome !== 'OK' || elapsedMs >= 200) diagnostics?.record({ event: 'request', area, role, requestId, outcome, elapsedMs });
}
