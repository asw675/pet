import { z } from 'zod';
import { appSnapshotSchema, idSchema, ipcRequestSchema, ipcResultSchema, nonnegativeIntegerSchema } from '@pet-desktop/contracts';
import type { AppBridge, AppSnapshot } from '@pet-desktop/contracts';

export const DESKTOP_IPC = Object.freeze({
  request: 'pet-desktop:request:v1',
  snapshot: 'pet-desktop:snapshot:v1',
  getStatus: 'pet-desktop:get-status:v1',
  status: 'pet-desktop:status:v1',
  openControlCenter: 'pet-desktop:open-control-center:v1',
  petInteractive: 'pet-desktop:pet-interactive:v1',
  petVisualReady: 'pet-desktop:pet-visual-ready:v1',
});

export const serviceStatusSchema = z.strictObject({
  stage: z.enum(['STARTING', 'READY', 'RESTARTING', 'UNAVAILABLE', 'STOPPING']),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const hostActionResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['FORBIDDEN', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE']) }),
]);
export type HostActionResult = z.infer<typeof hostActionResultSchema>;

/** A visual completion signal, not a domain action or arbitrary resource reference.
 * The host derives the pet identity from the sending pet window. */
export const petVisualReadySchema = z.strictObject({
  characterId: idSchema,
  generation: nonnegativeIntegerSchema,
  result: z.enum(['READY', 'FALLBACK']),
});
export type PetVisualReady = z.infer<typeof petVisualReadySchema>;

export type DesktopRole = 'pet' | 'control-center';
interface DesktopBridgeBase extends AppBridge {
  getServiceStatus(): Promise<ServiceStatus>;
  subscribeServiceStatus(listener: (status: ServiceStatus) => void): () => void;
  openControlCenter(): Promise<HostActionResult>;
}

export interface PetDesktopBridge extends DesktopBridgeBase {
  readonly role: 'pet';
  setInteractive(interactive: boolean): Promise<HostActionResult>;
  reportVisualReady(report: PetVisualReady): Promise<HostActionResult>;
}
export interface ControlCenterBridge extends DesktopBridgeBase {
  readonly role: 'control-center';
}
export type DesktopBridge = PetDesktopBridge | ControlCenterBridge;

export const serviceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), request: ipcRequestSchema }),
  z.strictObject({ kind: z.literal('shutdown') }),
]);
export type ServiceInput = z.infer<typeof serviceInputSchema>;

export const serviceOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), schemaVersion: z.literal(1),
    sqliteVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), driver: z.literal('better-sqlite3') }),
  z.strictObject({ kind: z.literal('result'), result: ipcResultSchema }),
  z.strictObject({ kind: z.literal('snapshot'), snapshot: appSnapshotSchema }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({ kind: z.literal('fatal'), code: z.enum([
    'INVALID_STARTUP', 'STARTUP_FAILED', 'PROTOCOL_ERROR', 'SERVICE_FAILED', 'CLOSE_FAILED',
  ]) }),
]);
export type ServiceOutput = z.infer<typeof serviceOutputSchema>;

export type SnapshotListener = (snapshot: AppSnapshot) => void;
export type StatusListener = (status: ServiceStatus) => void;
