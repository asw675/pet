import {
  proactiveLimits, proactiveNoticePageSchema, proactiveNoticeSchema, proactiveSettingsSchema, proactiveSettingsSetSchema, proactiveTriggerSchema,
} from '@pet-desktop/contracts/proactive';
import type {
  ProactiveGeneration,ProactiveNotice,ProactiveNoticePage,ProactiveSettings,ProactiveSettingsSet,ProactiveTrigger,
} from '@pet-desktop/contracts/proactive';
import type { SqliteConnection,SqlValue } from './ports.js';

const DAY_MS=86_400_000;
const SAFE=Number.MAX_SAFE_INTEGER;
const uint=(field:string)=>`${field} BETWEEN 0 AND ${SAFE}`;
const sqlId=(field:string)=>`length(${field}) BETWEEN 1 AND 128 AND ${field} GLOB '[A-Za-z0-9]*' AND ${field} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
/** Additive migration by the integrating repository. No modifications or
 * rewards to pets, inventory, coins, trips, or existing conversation rows. */
export const AI_PROACTIVE_MIGRATION_SQL=`
CREATE TABLE proactive_settings (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${SAFE}),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  local_ai INTEGER NOT NULL CHECK(local_ai IN (0,1) AND (enabled=1 OR local_ai=0)),
  quiet_start INTEGER CHECK(quiet_start BETWEEN 0 AND 1439),
  quiet_end INTEGER CHECK(quiet_end BETWEEN 0 AND 1439),
  updated_at INTEGER NOT NULL CHECK(${uint('updated_at')}),
  enabled_at INTEGER CHECK(${uint('enabled_at')} AND enabled_at<=updated_at),
  CHECK((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start<>quiet_end)),
  CHECK((enabled=1 AND enabled_at IS NOT NULL) OR (enabled=0 AND enabled_at IS NULL))
) STRICT;
CREATE TRIGGER proactive_settings_revision BEFORE UPDATE ON proactive_settings
WHEN NEW.pet_id<>OLD.pet_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (OLD.enabled=1 AND NEW.enabled=1 AND OLD.enabled_at IS NOT NEW.enabled_at)
BEGIN SELECT RAISE(ABORT,'invalid proactive settings revision'); END;

CREATE TABLE proactive_observations (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  low_energy INTEGER NOT NULL CHECK(low_energy IN (0,1)),
  low_episode INTEGER NOT NULL CHECK(${uint('low_episode')}),
  low_since INTEGER CHECK(${uint('low_since')}),
  observed_at INTEGER NOT NULL CHECK(${uint('observed_at')}),
  CHECK((low_energy=0 AND low_since IS NULL) OR (low_energy=1 AND low_episode>0 AND low_since IS NOT NULL AND low_since<=observed_at))
) STRICT;
CREATE TABLE proactive_notices (
  notice_id TEXT PRIMARY KEY NOT NULL CHECK(${sqlId('notice_id')}),
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  trigger TEXT NOT NULL CHECK(trigger IN ('RETURNED','LOW_ENERGY','IDLE')),
  source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 5 AND 135),
  source_at INTEGER NOT NULL CHECK(${uint('source_at')}),
  created_at INTEGER NOT NULL CHECK(${uint('created_at')} AND created_at>=source_at),
  day_bucket INTEGER NOT NULL CHECK(day_bucket=created_at/${DAY_MS}),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND ${proactiveLimits.noticeText}),
  response_kind TEXT NOT NULL CHECK(response_kind IN ('RULE','LOCAL_AI','MOCK')),
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','READY','ACKNOWLEDGED','DISMISSED')),
  generation_request_id TEXT UNIQUE CHECK(${sqlId('generation_request_id')}),
  generation_conversation_id TEXT CHECK(${sqlId('generation_conversation_id')}),
  generation_kind TEXT CHECK(generation_kind IN ('LOCAL_AI','MOCK')),
  ready_at INTEGER CHECK(${uint('ready_at')} AND ready_at>=created_at),
  acknowledged_at INTEGER CHECK(${uint('acknowledged_at')} AND acknowledged_at>=ready_at),
  dismissed_at INTEGER CHECK(${uint('dismissed_at')} AND dismissed_at>=ready_at AND (acknowledged_at IS NULL OR dismissed_at>=acknowledged_at)),
  UNIQUE(pet_id,trigger,source_key),
  CHECK((generation_request_id IS NULL AND generation_conversation_id IS NULL AND generation_kind IS NULL)
    OR (generation_request_id IS NOT NULL AND generation_conversation_id IS NOT NULL AND generation_kind IS NOT NULL)),
  CHECK(response_kind='RULE' OR response_kind=generation_kind),
  CHECK((delivery_status='PENDING' AND generation_request_id IS NOT NULL AND response_kind='RULE' AND ready_at IS NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL)
    OR (delivery_status='READY' AND ready_at IS NOT NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL)
    OR (delivery_status='ACKNOWLEDGED' AND ready_at IS NOT NULL AND acknowledged_at IS NOT NULL AND dismissed_at IS NULL)
    OR (delivery_status='DISMISSED' AND ready_at IS NOT NULL AND dismissed_at IS NOT NULL))
) STRICT;
CREATE INDEX proactive_pet_time ON proactive_notices(pet_id,created_at DESC,notice_id);
CREATE INDEX proactive_pet_day ON proactive_notices(pet_id,day_bucket);
CREATE UNIQUE INDEX proactive_one_pending ON proactive_notices(pet_id) WHERE delivery_status='PENDING';
CREATE TRIGGER proactive_reserve_guard BEFORE INSERT ON proactive_notices
WHEN NEW.delivery_status NOT IN ('PENDING','READY') OR NEW.response_kind<>'RULE'
 OR NOT EXISTS(SELECT 1 FROM proactive_settings s WHERE s.pet_id=NEW.pet_id AND s.enabled=1 AND s.enabled_at<=NEW.created_at
   AND (NEW.generation_request_id IS NULL OR s.local_ai=1))
 OR EXISTS(SELECT 1 FROM proactive_notices n WHERE n.pet_id=NEW.pet_id AND n.created_at>NEW.created_at-${proactiveLimits.cooldownMs})
 OR (SELECT COUNT(*) FROM proactive_notices n WHERE n.pet_id=NEW.pet_id AND n.day_bucket=NEW.day_bucket)>=${proactiveLimits.dailyCap}
BEGIN SELECT RAISE(ABORT,'proactive notice is disabled or outside budget'); END;
CREATE TRIGGER proactive_notice_transition BEFORE UPDATE ON proactive_notices
WHEN OLD.notice_id IS NOT NEW.notice_id OR OLD.pet_id IS NOT NEW.pet_id OR OLD.trigger IS NOT NEW.trigger
 OR OLD.source_key IS NOT NEW.source_key OR OLD.source_at IS NOT NEW.source_at OR OLD.created_at IS NOT NEW.created_at OR OLD.day_bucket IS NOT NEW.day_bucket
 OR OLD.generation_request_id IS NOT NEW.generation_request_id OR OLD.generation_conversation_id IS NOT NEW.generation_conversation_id OR OLD.generation_kind IS NOT NEW.generation_kind
 OR NOT ((OLD.delivery_status='PENDING' AND NEW.delivery_status='READY') OR (OLD.delivery_status='READY' AND NEW.delivery_status IN ('ACKNOWLEDGED','DISMISSED'))
   OR (OLD.delivery_status='ACKNOWLEDGED' AND NEW.delivery_status='DISMISSED'))
 OR (OLD.delivery_status<>'PENDING' AND (OLD.text IS NOT NEW.text OR OLD.response_kind IS NOT NEW.response_kind OR OLD.ready_at IS NOT NEW.ready_at))
 OR (OLD.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS NOT NEW.acknowledged_at)
BEGIN SELECT RAISE(ABORT,'invalid proactive notice lifecycle transition'); END;
CREATE TRIGGER proactive_notice_no_delete BEFORE DELETE ON proactive_notices
BEGIN SELECT RAISE(ABORT,'proactive notice receipts are retained'); END;
`;

type Row=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function id(value:unknown):string{if(typeof value!=='string'||!ID.test(value))throw new Error('Invalid proactive ID');return value;}
function integer(value:unknown):number{const number=typeof value==='bigint'?Number(value):value;if(typeof number!=='number'||!Number.isSafeInteger(number)||number<0)throw new Error('Invalid proactive time/integer');return number;}
function nullableInteger(value:unknown):number|null{return value===null?null:integer(value);}
function bool(value:unknown):boolean{const v=integer(value);if(v!==0&&v!==1)throw new Error('Invalid proactive bool');return v===1;}
function row(value:unknown):Row{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid proactive row');return value as Row;}
function same(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
function defaultSettings(petId:string):ProactiveSettings{return proactiveSettingsSchema.parse({petId,revision:0,enabled:false,useLocalAi:false,
  quietHours:{startMinute:22*60,endMinute:8*60},updatedAt:null,enabledAt:null});}

export interface ProactiveLowObservation {petId:string;low:boolean;episode:number;lowSince:number|null;observedAt:number}
export interface ProactiveReserveInput {noticeId:string;petId:string;trigger:ProactiveTrigger;sourceKey:string;sourceAt:number;createdAt:number;text:string;generation:ProactiveGeneration|null}
export interface ProactiveGenerationIdentity {petId:string;requestId:string;conversationId:string}
export class ProactiveSettingsConflict extends Error {}

/** Same active SQLite connection and transaction as the game authority. */
export class AiProactiveStorage {
  private readonly connection:SqliteConnection;
  private readonly inScope:()=>boolean;
  constructor(connection:SqliteConnection,inScope:()=>boolean){this.connection=connection;this.inScope=inScope;}
  private get db():SqliteConnection{if(!this.inScope())throw new Error('Transaction is no longer active');return this.connection;}
  private get(sql:string,...values:SqlValue[]):Row|null{const value=this.db.prepare(sql).get(...values);return value===undefined||value===null?null:row(value);}
  private all(sql:string,...values:SqlValue[]):Row[]{return this.db.prepare(sql).all(...values).map(row);}
  private run(sql:string,...values:SqlValue[]):number{return integer(this.db.prepare(sql).run(...values).changes);}
  getSettings(petId:string):ProactiveSettings{
    const pet=id(petId),value=this.get('SELECT * FROM proactive_settings WHERE pet_id=?',pet);
    if(!value)return defaultSettings(pet);
    return proactiveSettingsSchema.parse({petId:pet,revision:integer(value.revision),enabled:bool(value.enabled),useLocalAi:bool(value.local_ai),
      quietHours:value.quiet_start===null?null:{startMinute:integer(value.quiet_start),endMinute:integer(value.quiet_end)},
      updatedAt:integer(value.updated_at),enabledAt:nullableInteger(value.enabled_at)});
  }
  setSettings(raw:ProactiveSettingsSet,at:number):ProactiveSettings{
    const input=proactiveSettingsSetSchema.parse(raw),now=integer(at),current=this.getSettings(input.petId);
    if(input.expectedRevision!==current.revision||current.updatedAt!==null&&now<current.updatedAt)throw new ProactiveSettingsConflict('Proactive settings revision conflict');
    const {enabled,useLocalAi,quietHours}=input;
    if(enabled===current.enabled&&useLocalAi===current.useLocalAi&&same(quietHours,current.quietHours))return current;
    const next=proactiveSettingsSchema.parse({petId:input.petId,revision:current.revision+1,enabled,useLocalAi,quietHours,updatedAt:now,
      enabledAt:enabled?(current.enabledAt??now):null});
    this.run(`INSERT INTO proactive_settings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET
      revision=excluded.revision,enabled=excluded.enabled,local_ai=excluded.local_ai,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,
      updated_at=excluded.updated_at,enabled_at=excluded.enabled_at`,next.petId,next.revision,Number(enabled),Number(useLocalAi),
      quietHours?.startMinute??null,quietHours?.endMinute??null,now,next.enabledAt);
    // Preserve the monotonically allocated episode counter: a later re-enable
    // must not reuse a consumed source key, while disabled tracking stops.
    if(!enabled)this.run('UPDATE proactive_observations SET low_energy=0,low_since=NULL,observed_at=max(observed_at,?) WHERE pet_id=?',now,next.petId);
    return next;
  }
  private observation(petId:string):ProactiveLowObservation|null{
    const value=this.get('SELECT * FROM proactive_observations WHERE pet_id=?',id(petId));
    return value?{petId:id(value.pet_id),low:bool(value.low_energy),episode:integer(value.low_episode),lowSince:nullableInteger(value.low_since),observedAt:integer(value.observed_at)}:null;
  }
  observeLowEnergy(petId:string,low:boolean,at:number):ProactiveLowObservation|null{
    const pet=id(petId),now=integer(at),settings=this.getSettings(pet);
    if(typeof low!=='boolean'||!settings.enabled||settings.enabledAt===null||now<settings.enabledAt)return null;
    const old=this.observation(pet);
    if(old&&now<old.observedAt)return null;
    const episode=integer((old?.episode??0)+(low&&!old?.low?1:0)),lowSince=low?(old?.lowSince??now):null;
    this.run(`INSERT INTO proactive_observations VALUES(?,?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET
      low_energy=excluded.low_energy,low_episode=excluded.low_episode,low_since=excluded.low_since,observed_at=excluded.observed_at`,
    pet,Number(low),episode,lowSince,now);
    return {petId:pet,low,episode,lowSince,observedAt:now};
  }
  private notice(value:Row):ProactiveNotice{
    return proactiveNoticeSchema.parse({noticeId:value.notice_id,petId:value.pet_id,trigger:value.trigger,sourceKey:value.source_key,
      sourceAt:integer(value.source_at),createdAt:integer(value.created_at),text:value.text,responseKind:value.response_kind,deliveryStatus:value.delivery_status,
      generation:value.generation_request_id===null?null:{requestId:value.generation_request_id,conversationId:value.generation_conversation_id,kind:value.generation_kind},
      readyAt:nullableInteger(value.ready_at),acknowledgedAt:nullableInteger(value.acknowledged_at),dismissedAt:nullableInteger(value.dismissed_at)});
  }
  getNotice(petId:string,noticeId:string):ProactiveNotice|null{
    const value=this.get('SELECT * FROM proactive_notices WHERE pet_id=? AND notice_id=?',id(petId),id(noticeId));
    return value?this.notice(value):null;
  }
  /** Trusted AI utility authorization: no arbitrary PROACTIVE chat request
   * can begin without the exact durable pending notice and current opt-in. */
  isAuthorizedGeneration(identity:ProactiveGenerationIdentity):boolean{
    return this.generationTrigger(identity)!==null;
  }
  generationTrigger(identity: ProactiveGenerationIdentity): ProactiveTrigger | null {
    const found = this.get(`SELECT n.trigger FROM proactive_notices n JOIN proactive_settings s ON s.pet_id=n.pet_id
      WHERE n.pet_id=? AND n.generation_request_id=? AND n.generation_conversation_id=? AND n.delivery_status='PENDING'
      AND s.enabled=1 AND s.local_ai=1`,id(identity.petId),id(identity.requestId),id(identity.conversationId));
    return found ? proactiveTriggerSchema.parse(found.trigger) : null;
  }
  hasSource(petId:string,trigger:ProactiveTrigger,sourceKey:string):boolean{
    return this.get('SELECT 1 FROM proactive_notices WHERE pet_id=? AND trigger=? AND source_key=?',id(petId),trigger,sourceKey)!==null;
  }
  canReserve(petId:string,at:number):boolean{
    const pet=id(petId),now=integer(at),settings=this.getSettings(pet);
    if(!settings.enabled||settings.enabledAt===null||now<settings.enabledAt||settings.updatedAt===null||now<settings.updatedAt)return false;
    const latest=this.get('SELECT created_at FROM proactive_notices WHERE pet_id=? ORDER BY created_at DESC LIMIT 1',pet);
    if(latest&&now-integer(latest.created_at)<proactiveLimits.cooldownMs)return false;
    if(this.get("SELECT 1 FROM proactive_notices WHERE pet_id=? AND delivery_status='PENDING'",pet))return false;
    return integer(this.get('SELECT COUNT(*) n FROM proactive_notices WHERE pet_id=? AND day_bucket=?',pet,Math.floor(now/DAY_MS))?.n)<proactiveLimits.dailyCap;
  }
  reserve(raw:ProactiveReserveInput):ProactiveNotice|null{
    const notice=proactiveNoticeSchema.parse({...raw,responseKind:'RULE',deliveryStatus:raw.generation?'PENDING':'READY',
      readyAt:raw.generation?null:raw.createdAt,acknowledgedAt:null,dismissedAt:null});
    const now=notice.createdAt,settings=this.getSettings(notice.petId);
    if(!this.canReserve(notice.petId,now)||this.hasSource(notice.petId,notice.trigger,notice.sourceKey)||notice.generation&&!settings.useLocalAi)return null;
    if(notice.trigger==='RETURNED'&&now-notice.sourceAt>proactiveLimits.returnFreshnessMs)return null;
    if(notice.trigger==='IDLE'&&(notice.sourceKey!==`idle:${notice.sourceAt}`||now-notice.sourceAt<proactiveLimits.idleMs
      ||settings.enabledAt===null||notice.sourceAt<settings.enabledAt))return null;
    if(notice.trigger==='LOW_ENERGY'){
      const observation=this.observation(notice.petId);
      if(!observation?.low||observation.lowSince!==notice.sourceAt||notice.sourceKey!==`low:${observation.episode}`
        ||observation.observedAt!==now)return null;
    }
    this.run(`INSERT INTO proactive_notices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,notice.noticeId,notice.petId,notice.trigger,notice.sourceKey,
      notice.sourceAt,now,Math.floor(now/DAY_MS),notice.text,notice.responseKind,notice.deliveryStatus,notice.generation?.requestId??null,
      notice.generation?.conversationId??null,notice.generation?.kind??null,notice.readyAt,null,null);
    return notice;
  }
  /** Exact request-bound assistant text from completed PROACTIVE turn, never
   * a renderer/model supplied response or another pet/conversation. */
  private durableReply(identity:ProactiveGenerationIdentity,kind:ProactiveGeneration['kind'],createdAt:number,at:number):string|null{
    const value=this.get(`SELECT m.text FROM ai_turns t JOIN ai_messages m ON m.message_id=t.assistant_message_id
      JOIN ai_provider_configs p ON p.provider_id=t.provider_id AND p.revision=t.provider_revision
      WHERE t.request_id=? AND t.pet_id=? AND t.conversation_id=? AND t.trigger='PROACTIVE' AND t.status='COMPLETED'
      AND t.started_at>=? AND t.terminal_at<=? AND json_extract(p.config_json,'$.privacyBoundary')=?
      AND m.request_id=t.request_id AND m.pet_id=t.pet_id AND m.conversation_id=t.conversation_id AND m.role='ASSISTANT' AND m.status='COMPLETED' AND m.deleted_at IS NULL`,
    id(identity.requestId),id(identity.petId),id(identity.conversationId),integer(createdAt),integer(at),kind==='MOCK'?'MOCK':'LOCAL');
    return typeof value?.text==='string'&&value.text.length<=proactiveLimits.noticeText&&value.text.trim().length>0?value.text:null;
  }
  settleGeneration(noticeId:string,identity:ProactiveGenerationIdentity,at:number,useDurableReply:boolean):ProactiveNotice|null{
    const current=this.getNotice(identity.petId,noticeId),now=integer(at);
    if(!current||current.deliveryStatus!=='PENDING'||current.generation===null||current.generation.requestId!==id(identity.requestId)
      ||current.generation.conversationId!==id(identity.conversationId)||now<current.createdAt)return null;
    const settings=this.getSettings(identity.petId);
    const reply=useDurableReply&&settings.enabled&&settings.useLocalAi?this.durableReply(identity,current.generation.kind,current.createdAt,now):null;
    if(this.run("UPDATE proactive_notices SET text=?,response_kind=?,delivery_status='READY',ready_at=? WHERE notice_id=? AND delivery_status='PENDING'",
      reply??current.text,reply!==null?current.generation.kind:'RULE',now,current.noticeId)!==1)return null;
    if(!settings.enabled)this.dismiss(identity.petId,noticeId,now);
    return this.getNotice(identity.petId,noticeId);
  }
  listPending(petId?:string):ProactiveNotice[]{
    return (petId===undefined?this.all("SELECT * FROM proactive_notices WHERE delivery_status='PENDING' ORDER BY created_at,notice_id LIMIT 100")
      :this.all("SELECT * FROM proactive_notices WHERE pet_id=? AND delivery_status='PENDING' LIMIT 1",id(petId))).map(value=>this.notice(value));
  }
  recoverPending(at:number,expiredOnly=false):number{
    const now=integer(at);let count=0;
    for(const notice of this.listPending()){
      const generation=notice.generation;
      if(generation&&(!expiredOnly||now-notice.createdAt>=proactiveLimits.maxPendingMs)&&this.settleGeneration(notice.noticeId,{petId:notice.petId,...generation},Math.max(now,notice.createdAt),false))count++;
    }
    return count;
  }
  listNotices(petId:string,offset:number,limit:number,filter:'ALL'|'UNREAD'):ProactiveNoticePage{
    const pet=id(petId),page=proactiveNoticePageSchema.parse({petId:pet,offset,limit,filter,rows:[]});
    const clause=filter==='UNREAD'?"delivery_status='READY'":"delivery_status<>'PENDING'";
    const rows=this.all(`SELECT * FROM proactive_notices WHERE pet_id=? AND ${clause} ORDER BY created_at DESC,notice_id LIMIT ? OFFSET ?`,pet,page.limit,page.offset).map(value=>this.notice(value));
    return proactiveNoticePageSchema.parse({...page,rows});
  }
  acknowledge(petId:string,noticeId:string,at:number):boolean{
    return this.run("UPDATE proactive_notices SET delivery_status='ACKNOWLEDGED',acknowledged_at=? WHERE pet_id=? AND notice_id=? AND delivery_status='READY' AND ready_at<=?",
      integer(at),id(petId),id(noticeId),integer(at))===1;
  }
  dismiss(petId:string,noticeId:string,at:number):boolean{
    const now=integer(at);
    return this.run("UPDATE proactive_notices SET delivery_status='DISMISSED',dismissed_at=? WHERE pet_id=? AND notice_id=? AND delivery_status IN ('READY','ACKNOWLEDGED') AND ready_at<=? AND (acknowledged_at IS NULL OR acknowledged_at<=?)",
      now,id(petId),id(noticeId),now,now)===1;
  }
}
