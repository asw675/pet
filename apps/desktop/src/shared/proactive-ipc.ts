import {z} from 'zod';
import {idSchema,nonnegativeIntegerSchema} from '@pet-desktop/contracts';
import {proactiveLimits,proactiveNoticePageSchema,proactiveNoticeSchema,proactiveSettingsSchema,proactiveSettingsSetSchema} from '@pet-desktop/contracts/proactive';
const pet={petId:idSchema};
const page={offset:nonnegativeIntegerSchema.max(proactiveLimits.maxOffset),limit:nonnegativeIntegerSchema.min(1).max(proactiveLimits.maxPage),filter:z.enum(['ALL','UNREAD'])};
export const proactiveIntentSchema=z.discriminatedUnion('method',[
  z.strictObject({method:z.literal('settings/get'),payload:z.strictObject(pet)}),
  z.strictObject({method:z.literal('settings/set'),payload:proactiveSettingsSetSchema}),
  z.strictObject({method:z.literal('notices/list'),payload:z.strictObject({...pet,...page})}),
  z.strictObject({method:z.literal('notice/acknowledge'),payload:z.strictObject({...pet,noticeId:idSchema})}),
  z.strictObject({method:z.literal('notice/dismiss'),payload:z.strictObject({...pet,noticeId:idSchema})}),
]);
export type ProactiveIntent=z.infer<typeof proactiveIntentSchema>;
export const proactiveRequestSchema=z.strictObject({requestId:idSchema,intent:proactiveIntentSchema});
export type ProactiveRequest=z.infer<typeof proactiveRequestSchema>;
const methods=['settings/get','settings/set','notices/list','notice/acknowledge','notice/dismiss'] as const;
const base={requestId:idSchema,ok:z.literal(true)};
const result=<M extends typeof methods[number],D extends z.ZodType>(method:M,data:D)=>z.strictObject({...base,method:z.literal(method),data});
const change=z.strictObject({petId:idSchema,noticeId:idSchema,changed:z.boolean()});
export const proactiveErrorCodeSchema=z.enum(['INVALID_REQUEST','CONFLICT','UNAVAILABLE']);
export type ProactiveErrorCode=z.infer<typeof proactiveErrorCodeSchema>;
export const proactiveResultSchema=z.union([
  result('settings/get',proactiveSettingsSchema),result('settings/set',proactiveSettingsSchema),result('notices/list',proactiveNoticePageSchema),
  result('notice/acknowledge',change),result('notice/dismiss',change),
  z.strictObject({requestId:idSchema,method:z.enum(methods),ok:z.literal(false),error:z.strictObject({code:proactiveErrorCodeSchema,message:z.string().min(1).max(128),retryable:z.boolean()})}),
]);
export type ProactiveResult=z.infer<typeof proactiveResultSchema>;
export const proactiveNoticeReadySchema=z.strictObject({kind:z.literal('notice-ready'),notice:proactiveNoticeSchema.refine(value=>value.deliveryStatus==='READY')});
export type ProactiveNoticeReady=z.infer<typeof proactiveNoticeReadySchema>;
export const PROACTIVE_PULSE_MS = 15_000;
export const proactiveHostSchema = z.strictObject({ petId: idSchema.nullable() });
export const proactiveDesktopBubbleSchema = z.strictObject({ petId: idSchema, text: z.string().min(1).max(proactiveLimits.noticeText) }).nullable();
export type ProactiveDesktopBubble = z.infer<typeof proactiveDesktopBubbleSchema>;
export function proactiveFailure(request: { requestId: string; intent: { method: ProactiveIntent['method'] } }, code: ProactiveErrorCode = 'UNAVAILABLE'): ProactiveResult {
  return {
    ok: false, requestId: request.requestId, method: request.intent.method,
    error: { code, message: code === 'CONFLICT' ? '设置已更新，请重新读取。' : '主动陪伴操作未完成。', retryable: code !== 'INVALID_REQUEST' },
  };
}
export function proactiveResultMatches(request:ProactiveRequest,result:ProactiveResult):boolean{
  if(request.requestId!==result.requestId||request.intent.method!==result.method)return false;
  if(!result.ok)return true;
  if(result.data.petId!==request.intent.payload.petId)return false;
  if(result.method==='notices/list'&&request.intent.method==='notices/list'){
    const a=request.intent.payload,b=result.data;return a.offset===b.offset&&a.limit===b.limit&&a.filter===b.filter;
  }
  if((result.method==='notice/acknowledge'||result.method==='notice/dismiss')
    &&(request.intent.method==='notice/acknowledge'||request.intent.method==='notice/dismiss'))return result.data.noticeId===request.intent.payload.noticeId;
  if(result.method==='settings/set'&&request.intent.method==='settings/set'){
    const a=request.intent.payload,b=result.data;
    return b.enabled===a.enabled&&b.useLocalAi===a.useLocalAi&&JSON.stringify(a.quietHours)===JSON.stringify(b.quietHours)
      &&(b.revision===a.expectedRevision||b.revision===a.expectedRevision+1);
  }
  return true;
}
