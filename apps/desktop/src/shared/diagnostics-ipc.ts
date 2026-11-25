import { z } from 'zod';

export const diagnosticsExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), entries: z.number().int().min(0).max(30_000) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['FORBIDDEN', 'INVALID_REQUEST', 'BUSY', 'CANCELLED', 'UNAVAILABLE', 'DESTINATION_EXISTS', 'EXPORT_FAILED']),
  }),
]);

export type DiagnosticsExportResult = z.infer<typeof diagnosticsExportResultSchema>;
