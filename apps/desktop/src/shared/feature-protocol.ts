import { z } from 'zod';
import { idSchema } from '@pet-desktop/contracts';
import { chatStreamEventSchema } from '@pet-desktop/contracts/ai';
import { aiRequestSchema, aiResultSchema, credentialLookupSchema, credentialLookupReplySchema, internalChatCancelSchema } from './ai-ipc';
import { voiceServiceRequestSchema, voiceServiceResultSchema } from './voice-ipc';
import { workspaceAuthorityRequestSchema,workspaceAuthorityResultSchema } from './workspace-ipc';
import { voiceSettingsRequestSchema,voiceSettingsResultSchema } from './voice-settings-ipc';
import { proactiveHostSchema, proactiveNoticeReadySchema, proactiveRequestSchema, proactiveResultSchema } from './proactive-ipc';

/** Main↔utility only. No renderer may invoke credential replies or internal
 * cancellation directly; these never cross a renderer bridge. */
import { hostAuthorityRequestSchema, hostAuthorityResultSchema } from './host-settings-ipc';

export const featureInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proactive-host'), context: proactiveHostSchema }),
  z.strictObject({ kind: z.literal('proactive-request'), request: proactiveRequestSchema }),
  z.strictObject({ kind: z.literal('host-authority-request'), requestId: idSchema, request: hostAuthorityRequestSchema }),
  z.strictObject({ kind:z.literal('ai-request'), request:aiRequestSchema }),
  z.strictObject({ kind:z.literal('voice-request'), requestId:idSchema, request:voiceServiceRequestSchema }),
  z.strictObject({ kind:z.literal('credential-reply'), reply:credentialLookupReplySchema }),
  z.strictObject({ kind:z.literal('internal-chat-cancel'), cancel:internalChatCancelSchema }),
  z.strictObject({kind:z.literal('workspace-authority-request'),request:workspaceAuthorityRequestSchema}),
  z.strictObject({kind:z.literal('voice-settings-request'),requestId:idSchema,request:voiceSettingsRequestSchema}),
]);
export type FeatureInput=z.infer<typeof featureInputSchema>;
export const featureOutputSchema=z.discriminatedUnion('kind',[
  z.strictObject({ kind: z.literal('proactive-result'), result: proactiveResultSchema }),
  z.strictObject({ kind: z.literal('proactive-ready'), event: proactiveNoticeReadySchema }),
  z.strictObject({ kind: z.literal('host-authority-result'), requestId: idSchema, result: hostAuthorityResultSchema }),
  z.strictObject({kind:z.literal('ai-result'),result:aiResultSchema}),
  z.strictObject({kind:z.literal('voice-result'),requestId:idSchema,result:voiceServiceResultSchema}),
  z.strictObject({kind:z.literal('chat-event'),event:chatStreamEventSchema}),
  z.strictObject({kind:z.literal('credential-lookup'),lookup:credentialLookupSchema}),
  z.strictObject({kind:z.literal('workspace-authority-result'),result:workspaceAuthorityResultSchema}),
  z.strictObject({kind:z.literal('voice-settings-result'),requestId:idSchema,result:voiceSettingsResultSchema}),
]);
export type FeatureOutput=z.infer<typeof featureOutputSchema>;
