import { isAbsolute } from 'node:path';
import { resultMatchesMethod } from '@pet-desktop/contracts';
import type { AppService } from '@pet-desktop/app-service';
import { serviceInputSchema, serviceOutputSchema } from '../shared/protocol';
import type { ServiceOutput } from '../shared/protocol';
import type { FeatureOutput } from '../shared/feature-protocol';
import type { UtilityFeatures } from './feature-router';

export const SNAPSHOT_TICK_MS = 1_000;

type FatalCode = Extract<ServiceOutput, { kind: 'fatal' }>['code'];
type Service = Pick<AppService, 'getSnapshot' | 'handleRequest' | 'close'>;

interface UtilityOptions {
  /** Only the trusted Main process supplies this single startup argument. */
  args: readonly string[];
  start(databasePath: string): { service: Service; sqliteVersion: string; createFeatures?: (send:(message:FeatureOutput)=>void,fault:()=>void)=>UtilityFeatures };
  send(message: ServiceOutput): void;
  exit(code: 0 | 1): void;
}

/** Synchronous, serial transport. Timer and request callbacks share a single
 * utility-process event loop; no transaction can outlive either callback. */
export function startUtilityTransport(options: UtilityOptions): {
  receive(message: unknown): void;
  abort(): void;
} {
  let service: Service | undefined;
  let features:UtilityFeatures|undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let terminal = false;
  let lastRevision = -1;

  function send(message: ServiceOutput): void {
    options.send(serviceOutputSchema.parse(message));
  }

  function finish(code?: FatalCode): void {
    if (terminal) return;
    terminal = true;
    if (timer !== undefined) clearInterval(timer);
    try {
      try{features?.close();}finally{service?.close();}
    } catch {
      code = 'CLOSE_FAILED';
    }
    let exitCode: 0 | 1 = code === undefined ? 0 : 1;
    try {
      send(code === undefined ? { kind: 'stopped' } : { kind: 'fatal', code });
    } catch {
      exitCode = 1; // The parent may already be disconnected.
    } finally {
      options.exit(exitCode);
    }
  }

  function pushSnapshot(): void {
    if (service === undefined) throw new Error('Service not initialized');
    const output = serviceOutputSchema.parse({ kind: 'snapshot', snapshot: service.getSnapshot() });
    if (output.kind !== 'snapshot') throw new Error('Invalid snapshot output');
    if (output.snapshot.revision < lastRevision) throw new Error('Authoritative snapshot revision regressed');
    if (output.snapshot.revision > lastRevision) {
      options.send(output);
      lastRevision = output.snapshot.revision;
    }
  }

  function tick(): void {
    if (terminal) return;
    try {
      pushSnapshot();
    } catch {
      finish('SERVICE_FAILED');
    }
  }

  function receive(message: unknown): void {
    if (terminal) return;
    try {
      const parsed = serviceInputSchema.safeParse(message);
      if (!parsed.success) {
        finish('PROTOCOL_ERROR');
        return;
      }
      if (parsed.data.kind === 'shutdown') {
        finish();
        return;
      }
      if (service === undefined) throw new Error('Service not initialized');
      if(parsed.data.kind!=='request'){
        if(!features){finish('PROTOCOL_ERROR');return;}
        features.receive(parsed.data);return;
      }
      const result = service.handleRequest(parsed.data.request);
      const resultId = result.ok ? result.requestId : result.error.requestId;
      if (resultId !== parsed.data.request.requestId || !resultMatchesMethod(parsed.data.request.method, result)) {
        finish('PROTOCOL_ERROR');
        return;
      }
      send({ kind: 'result', result });
      // A duplicate command can legitimately return its historical receipt.
      // It is not the current projection; query the authority even on a
      // denied/error result because advancing due events may have committed.
      pushSnapshot();
    } catch {
      finish('SERVICE_FAILED');
    }
  }

  const databasePath = options.args[0];
  if (options.args.length !== 1 || databasePath === undefined || !isAbsolute(databasePath) || databasePath.includes('\0')) {
    finish('INVALID_STARTUP');
  } else {
    try {
      const started = options.start(databasePath);
      service = started.service;
      features=started.createFeatures?.(message=>{if(!terminal)send(message);},()=>finish('SERVICE_FAILED'));
      // Validate the initial projection before advertising readiness.
      const initial = serviceOutputSchema.parse({ kind: 'snapshot', snapshot: service.getSnapshot() });
      if (initial.kind !== 'snapshot') throw new Error('Invalid initial projection');
      send({ kind: 'ready', schemaVersion: 1, driver: 'better-sqlite3', sqliteVersion: started.sqliteVersion });
      options.send(initial);
      lastRevision = initial.snapshot.revision;
      timer = setInterval(tick, SNAPSHOT_TICK_MS);
    } catch {
      finish('STARTUP_FAILED');
    }
  }

  return { receive, abort: () => finish('SERVICE_FAILED') };
}
