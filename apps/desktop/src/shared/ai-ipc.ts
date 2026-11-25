import { z } from 'zod';
import { idSchema, nonnegativeIntegerSchema } from '@pet-desktop/contracts';
import { aiErrorSchema, aiLimits, aiCancelReasonSchema, actionProposalSchema, chatMessageSchema,
  conversationSchema, credentialRefSchema, memoryRecordSchema, pendingMemoryCandidateSchema, providerConfigSchema } from '@pet-desktop/contracts/ai';

const id = idSchema, integer = nonnegativeIntegerSchema;
const page = { offset: integer.max(1_000_000), limit: integer.min(1).max(50) };
const pet = { petId: id };
const scope = { ...pet, conversationId: id };
export const chatIdentitySchema = z.strictObject({ ...scope, requestId: id });
export type ChatIdentity = z.infer<typeof chatIdentitySchema>;
const userText = z.string().min(1).max(aiLimits.userText).refine(text => text.trim().length > 0);
const shortText = z.string().min(1).max(120).refine(text => text.trim().length > 0);
const summary = z.string().min(1).max(512).refine(text => text.trim().length > 0);
const recipients = z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length);
const confirmFields = { kind: z.literal('CONFIRM'), editedSummary: summary.optional(), expiresAt: integer.nullable().optional(), pinned: z.boolean().optional() };
const memoryConfirmation = z.discriminatedUnion('scope', [
  z.strictObject({ ...confirmFields, scope: z.literal('PRIVATE') }),
  z.strictObject({ ...confirmFields, scope: z.literal('SHARED'), recipientPetIds: recipients }),
]);
const editFields = { kind: z.literal('EDIT'), summary, expiresAt: integer.nullable(), pinned: z.boolean() };
const memoryEdit = z.discriminatedUnion('scope', [z.strictObject({ ...editFields, scope: z.literal('PRIVATE') }),
  z.strictObject({ ...editFields, scope: z.literal('SHARED'), recipientPetIds: recipients })]);

/** User-authored intent only. AI context, persona, provider result, credentials,
 * tool execution, path or arbitrary action never belong to this API. */
export const aiIntentSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('settings/list'), payload: z.strictObject({ ...page }) }),
  z.strictObject({ method: z.literal('provider/save'), payload: z.strictObject({ config: providerConfigSchema, expectedRevision: integer.nullable() }) }),
  z.strictObject({ method: z.literal('provider/assign'), payload: z.strictObject({ ...pet, providerId: id, providerRevision: integer, allowCloudContext: z.boolean() }) }),
  z.strictObject({ method: z.literal('provider/clear'), payload: z.strictObject(pet) }),
  z.strictObject({ method: z.literal('conversations/list'), payload: z.strictObject({ ...pet, ...page }) }),
  z.strictObject({ method: z.literal('conversation/create'), payload: z.strictObject({ ...pet, title: shortText }) }),
  z.strictObject({ method: z.literal('messages/list'), payload: z.strictObject({ ...scope, ...page }) }),
  z.strictObject({ method: z.literal('message/edit'), payload: z.strictObject({ ...scope, messageId: id, text: userText }) }),
  z.strictObject({ method: z.literal('message/delete'), payload: z.strictObject({ ...scope, messageId: id }) }),
  z.strictObject({ method: z.literal('chat/start'), payload: chatIdentitySchema.extend({ trigger: z.literal('USER'), userText }) }),
  z.strictObject({ method: z.literal('chat/cancel'), payload: chatIdentitySchema.extend({ reason: z.literal('USER') }) }),
  z.strictObject({ method: z.literal('proposals/list'), payload: z.strictObject(pet) }),
  z.strictObject({ method: z.literal('proposal/dismiss'), payload: z.strictObject({ ...pet, proposalId: id }) }),
  z.strictObject({ method: z.literal('memory/list'), payload: z.strictObject({ ...pet, ...page, candidateOffset: integer.max(1_000_000) }) }),
  z.strictObject({ method: z.literal('memory/confirm'), payload: z.strictObject({ ...pet, candidateId: id, decision: memoryConfirmation }) }),
  z.strictObject({ method: z.literal('memory/reject'), payload: z.strictObject({ ...pet, candidateId: id }) }),
  z.strictObject({ method: z.literal('memory/edit'), payload: z.strictObject({ ...pet, memoryId: id, decision: memoryEdit }) }),
  z.strictObject({ method: z.literal('memory/delete'), payload: z.strictObject({ ...pet, memoryId: id }) }),
  z.strictObject({ method: z.literal('memory/revoke'), payload: z.strictObject({ ...pet, memoryId: id, recipientPetId: id }) }),
  z.strictObject({ method: z.literal('memory/clear'), payload: z.strictObject(pet) }),
]);
export type AiIntent = z.infer<typeof aiIntentSchema>;
export const aiRequestSchema = z.strictObject({ requestId: id, intent: aiIntentSchema });
export type AiRequest = z.infer<typeof aiRequestSchema>;

export const providerRecordViewSchema = z.strictObject({ config: providerConfigSchema, revision: integer, updatedAt: integer });
export const providerAssignmentViewSchema = z.strictObject({ ...pet, providerId: id, providerRevision: integer, assignedAt: integer, cloudConsent: z.boolean() });
export type ProviderRecordView = z.infer<typeof providerRecordViewSchema>;
export type ProviderAssignmentView = z.infer<typeof providerAssignmentViewSchema>;
const settingsView = z.strictObject({ providers: z.array(providerRecordViewSchema).max(50), assignments: z.array(providerAssignmentViewSchema).max(100) });
const successFields = { requestId: id, ok: z.literal(true) };
const boolean = z.strictObject({ changed: z.boolean() });
const dataMethod = <M extends AiIntent['method'], D extends z.ZodType>(method: M, data: D) => z.strictObject({ ...successFields, method: z.literal(method), data });
const methodNames = ['settings/list','provider/save','provider/assign','provider/clear','conversations/list','conversation/create','messages/list','message/edit','message/delete',
  'chat/start','chat/cancel','proposals/list','proposal/dismiss','memory/list','memory/confirm','memory/reject','memory/edit','memory/delete','memory/revoke','memory/clear'] as const;
export const aiResultSchema = z.union([
  dataMethod('settings/list', settingsView),
  dataMethod('provider/save', providerRecordViewSchema),
  dataMethod('provider/assign', providerAssignmentViewSchema),
  dataMethod('provider/clear', boolean),
  dataMethod('conversations/list', z.strictObject({ ...pet, ...page, rows: z.array(conversationSchema).max(50) })),
  dataMethod('conversation/create', conversationSchema),
  dataMethod('messages/list', z.strictObject({ ...scope, ...page, rows: z.array(chatMessageSchema).max(50) })),
  dataMethod('message/edit', boolean), dataMethod('message/delete', boolean),
  dataMethod('chat/start', chatIdentitySchema), dataMethod('chat/cancel', boolean),
  dataMethod('proposals/list', z.strictObject({ ...pet, rows: z.array(actionProposalSchema).max(50) })),
  dataMethod('proposal/dismiss', boolean),
  dataMethod('memory/list', z.strictObject({ ...pet, ...page, candidateOffset: integer, memories: z.array(memoryRecordSchema).max(50), candidates: z.array(pendingMemoryCandidateSchema).max(50) })),
  dataMethod('memory/confirm', memoryRecordSchema), dataMethod('memory/edit', memoryRecordSchema),
  dataMethod('memory/reject', boolean), dataMethod('memory/delete', boolean), dataMethod('memory/revoke', boolean),
  dataMethod('memory/clear', z.strictObject({ count: integer })),
  z.strictObject({ requestId: id, method: z.enum(methodNames), ok: z.literal(false), error: aiErrorSchema }),
]).superRefine((result, ctx) => {
  if (!result.ok) return;
  const issue = () => ctx.addIssue({ code: 'custom', message: 'AI result scope or duplicate identity is inconsistent' });
  switch (result.method) {
    case 'conversations/list': if (result.data.rows.some(row => row.petId !== result.data.petId) || new Set(result.data.rows.map(row=>row.conversationId)).size !== result.data.rows.length) issue(); break;
    case 'messages/list': if (result.data.rows.some(row=>row.petId!==result.data.petId||row.conversationId!==result.data.conversationId)
      || new Set(result.data.rows.map(row=>row.messageId)).size!==result.data.rows.length) issue(); break;
    case 'memory/list': if(result.data.memories.some(row=>row.ownerPetId!==result.data.petId)||result.data.candidates.some(row=>row.ownerPetId!==result.data.petId)) issue(); break;
    case 'proposals/list': if(result.data.rows.some(row=>row.petId!==result.data.petId)) issue(); break;
    case 'settings/list': if(new Set(result.data.providers.map(row=>row.config.providerId)).size!==result.data.providers.length
      || new Set(result.data.assignments.map(row=>row.petId)).size!==result.data.assignments.length) issue(); break;
  }
});
export type AiResult = z.infer<typeof aiResultSchema>;

/** Correlate user-facing response identity even when the service sends a valid
 * schema of the wrong page or conversation. */
export function aiResultMatches(request: AiRequest, result: AiResult): boolean {
  if(request.requestId!==result.requestId || request.intent.method!==result.method) return false;
  if(!result.ok) return true;
  const payload=request.intent.payload;
  const data=result.data;
  for(const key of ['petId','conversationId','offset','limit','candidateOffset'] as const) {
    if(key in payload && key in data && (payload as unknown as Record<string,unknown>)[key] !== (data as unknown as Record<string,unknown>)[key]) return false;
  }
  if(result.method==='chat/start' && request.intent.method==='chat/start') return result.data.requestId===request.intent.payload.requestId;
  if(result.method==='provider/save' && request.intent.method==='provider/save') return result.data.config.providerId===request.intent.payload.config.providerId;
  if(result.method==='provider/assign' && request.intent.method==='provider/assign') return result.data.providerId===request.intent.payload.providerId && result.data.providerRevision===request.intent.payload.providerRevision;
  return true;
}

/** Credentials have a separate Main-only ingress; plaintext never travels in
 * any ai-request, ai-result, conversation, or model output DTO. */
export const credentialSaveSchema = z.strictObject({ providerId: id, credentialRef: credentialRefSchema, secret: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u) });
export type CredentialSave = z.infer<typeof credentialSaveSchema>;
export const credentialRevokeSchema = credentialSaveSchema.omit({ secret: true });
export type CredentialRevoke = z.infer<typeof credentialRevokeSchema>;
export const credentialLookupSchema = z.strictObject({ lookupId: id, providerId: id, credentialRef: credentialRefSchema, identity: chatIdentitySchema });
export const credentialLookupReplySchema = z.strictObject({ lookupId: id, secret: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u).nullable() });
export const internalChatCancelSchema = chatIdentitySchema.extend({ reason: aiCancelReasonSchema });
