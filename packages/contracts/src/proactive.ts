import { z } from 'zod';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const time=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const minute=z.number().int().min(0).max(1439);
const text=z.string().min(1).max(1000).refine(value=>value.trim().length>0);
export const proactiveLimits=Object.freeze({
  cooldownMs:2*60*60_000,dailyCap:3,interactionSilenceMs:15*60_000,idleMs:4*60*60_000,returnFreshnessMs:6*60*60_000,
  lowEnergyThreshold:30,maxPage:50,maxOffset:10_000,maxPendingMs:5*60_000,noticeText:1000,
});
export const proactiveQuietHoursSchema=z.strictObject({startMinute:minute,endMinute:minute})
  .refine(value=>value.startMinute!==value.endMinute,'Quiet hours must be a real nonempty interval');
export type ProactiveQuietHours=z.infer<typeof proactiveQuietHoursSchema>;
const flags={enabled:z.boolean(),useLocalAi:z.boolean(),quietHours:proactiveQuietHoursSchema.nullable()};
export const proactiveSettingsSetSchema=z.strictObject({petId:id,expectedRevision:time,...flags})
  .refine(value=>value.enabled||!value.useLocalAi,'Disabled feature cannot retain background AI opt-in');
export type ProactiveSettingsSet=z.infer<typeof proactiveSettingsSetSchema>;
export const proactiveSettingsSchema=z.strictObject({petId:id,revision:time,...flags,updatedAt:time.nullable(),enabledAt:time.nullable()})
  .superRefine((value,ctx)=>{
    if((!value.enabled&&value.useLocalAi)||(value.enabled!==(value.enabledAt!==null))
      ||(value.revision===0&&(value.updatedAt!==null||value.enabled))||(value.revision>0&&value.updatedAt===null)
      ||(value.enabledAt!==null&&(value.updatedAt===null||value.enabledAt>value.updatedAt)))ctx.addIssue({code:'custom',message:'Inconsistent proactive setting history'});
  });
export type ProactiveSettings=z.infer<typeof proactiveSettingsSchema>;

export const proactiveTriggerSchema=z.enum(['RETURNED','LOW_ENERGY','IDLE']);
export type ProactiveTrigger=z.infer<typeof proactiveTriggerSchema>;
export const proactiveGenerationSchema=z.strictObject({requestId:id,conversationId:id,kind:z.enum(['LOCAL_AI','MOCK'])});
export type ProactiveGeneration=z.infer<typeof proactiveGenerationSchema>;
export const proactiveNoticeStatusSchema=z.enum(['PENDING','READY','ACKNOWLEDGED','DISMISSED']);
export type ProactiveNoticeStatus=z.infer<typeof proactiveNoticeStatusSchema>;
export const proactiveNoticeSchema=z.strictObject({
  noticeId:id,petId:id,trigger:proactiveTriggerSchema,sourceKey:z.string().regex(/^(return|low|idle):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  sourceAt:time,createdAt:time,text,responseKind:z.enum(['RULE','LOCAL_AI','MOCK']),deliveryStatus:proactiveNoticeStatusSchema,
  generation:proactiveGenerationSchema.nullable(),readyAt:time.nullable(),acknowledgedAt:time.nullable(),dismissedAt:time.nullable(),
}).superRefine((value,ctx)=>{
  const expectedPrefix=value.trigger==='RETURNED'?'return:':value.trigger==='LOW_ENERGY'?'low:':'idle:';
  const {deliveryStatus:status,readyAt,acknowledgedAt,dismissedAt}=value;
  if(!value.sourceKey.startsWith(expectedPrefix)||value.sourceAt>value.createdAt||(value.responseKind!=='RULE'&&value.generation?.kind!==value.responseKind)
    ||(status==='PENDING'&&(value.generation===null||readyAt!==null||value.responseKind!=='RULE'))
    ||(status!=='PENDING'&&(readyAt===null||readyAt<value.createdAt))
    ||(status==='ACKNOWLEDGED'&&acknowledgedAt===null)||(acknowledgedAt!==null&&(readyAt===null||acknowledgedAt<readyAt||!['ACKNOWLEDGED','DISMISSED'].includes(status)))
    ||(status==='DISMISSED')!==(dismissedAt!==null)||(dismissedAt!==null&&(readyAt===null||dismissedAt<readyAt||acknowledgedAt!==null&&dismissedAt<acknowledgedAt))){
    ctx.addIssue({code:'custom',message:'Inconsistent proactive notice lifecycle or source'});
  }
});
export type ProactiveNotice=z.infer<typeof proactiveNoticeSchema>;
export const proactiveNoticeViewSchema=proactiveNoticeSchema.refine(value=>value.deliveryStatus!=='PENDING','Generation not yet completed');
export const proactiveNoticePageSchema=z.strictObject({petId:id,offset:time.max(proactiveLimits.maxOffset),limit:time.min(1).max(proactiveLimits.maxPage),
  filter:z.enum(['ALL','UNREAD']),rows:z.array(proactiveNoticeViewSchema).max(proactiveLimits.maxPage)})
  .refine(value=>value.rows.length<=value.limit&&new Set(value.rows.map(row=>row.noticeId)).size===value.rows.length
    &&value.rows.every(row=>row.petId===value.petId&&(value.filter==='ALL'||row.deliveryStatus==='READY')),'Notice page scope mismatch');
export type ProactiveNoticePage=z.infer<typeof proactiveNoticePageSchema>;
