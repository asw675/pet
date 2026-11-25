import type { SqliteConnection } from './ports.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const COORDINATE_LIMIT = 1_000_000;
const EXTENT_LIMIT = 32_768;
export const HOST_SCALE_CHOICES = Object.freeze([50,75,100,125,150,200] as const);
export type HostScalePercent = typeof HOST_SCALE_CHOICES[number];
export interface HostPreferenceValues { hotkeysEnabled: boolean; scalePercent: HostScalePercent; reducedMotion: boolean }
export interface HostPreferences extends HostPreferenceValues { revision: number; updatedAt: number | null }
export const DEFAULT_HOST_PREFERENCES: Readonly<HostPreferenceValues> = Object.freeze({ hotkeysEnabled:true,scalePercent:100,reducedMotion:false });
export type HostWindowRole = 'control-center'|'pet';
/** Only a real Main-observed DIP rectangle/display. Coordinates are never
 * renderer-authored commands, and DPI is integer thousandths, not a raw
 * multiplier to apply again to Electron's DIP geometry. */
export interface HostWindowAnchor {
  role: HostWindowRole; petId: string | null; displayId: number;
  offsetX: number; offsetY: number; x: number; y: number; width: number; height: number;
  displayScale1000: number; observedAt: number;
}

/** Additive schema mounted once by the numbered single-writer repository.
 * No OS state, keybinding text, unbounded settings object, or raw paths. */
export const HOST_PREFERENCES_MIGRATION_SQL = `
CREATE TABLE host_preferences (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND ${MAX_SAFE}),
  hotkeys_enabled INTEGER NOT NULL CHECK(hotkeys_enabled IN (0,1)),
  scale_percent INTEGER NOT NULL CHECK(scale_percent IN (50,75,100,125,150,200)),
  reduced_motion INTEGER NOT NULL CHECK(reduced_motion IN (0,1)),
  updated_at INTEGER CHECK(updated_at BETWEEN 0 AND ${MAX_SAFE}),
  CHECK((revision=0 AND updated_at IS NULL AND hotkeys_enabled=1 AND scale_percent=100 AND reduced_motion=0)
    OR (revision>0 AND updated_at IS NOT NULL))
) STRICT;
INSERT INTO host_preferences VALUES(1,0,1,100,0,NULL);
CREATE TRIGGER host_preferences_no_replace BEFORE INSERT ON host_preferences
WHEN EXISTS(SELECT 1 FROM host_preferences) BEGIN SELECT RAISE(ABORT,'Host preference singleton is not replaceable'); END;
CREATE TRIGGER host_preferences_monotonic BEFORE UPDATE ON host_preferences
WHEN OLD.singleton IS NOT NEW.singleton OR NEW.revision<>OLD.revision+1 OR NEW.updated_at IS NULL
  OR (OLD.updated_at IS NOT NULL AND NEW.updated_at<OLD.updated_at)
  OR (NEW.hotkeys_enabled=OLD.hotkeys_enabled AND NEW.scale_percent=OLD.scale_percent AND NEW.reduced_motion=OLD.reduced_motion)
BEGIN SELECT RAISE(ABORT,'Host preferences require an explicit monotonic change'); END;
CREATE TRIGGER host_preferences_no_delete BEFORE DELETE ON host_preferences
BEGIN SELECT RAISE(ABORT,'Host preference singleton cannot be deleted'); END;
CREATE TABLE host_window_anchors (
  owner_key TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('control-center','pet')),
  pet_id TEXT REFERENCES pets(pet_id),
  display_id INTEGER NOT NULL CHECK(display_id BETWEEN -${MAX_SAFE} AND ${MAX_SAFE}),
  offset_x INTEGER NOT NULL CHECK(offset_x BETWEEN -${COORDINATE_LIMIT} AND ${COORDINATE_LIMIT}),
  offset_y INTEGER NOT NULL CHECK(offset_y BETWEEN -${COORDINATE_LIMIT} AND ${COORDINATE_LIMIT}),
  x INTEGER NOT NULL CHECK(x BETWEEN -${COORDINATE_LIMIT} AND ${COORDINATE_LIMIT}),
  y INTEGER NOT NULL CHECK(y BETWEEN -${COORDINATE_LIMIT} AND ${COORDINATE_LIMIT}),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND ${EXTENT_LIMIT}),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND ${EXTENT_LIMIT}),
  display_scale1000 INTEGER NOT NULL CHECK(display_scale1000 BETWEEN 250 AND 8000),
  observed_at INTEGER NOT NULL CHECK(observed_at BETWEEN 0 AND ${MAX_SAFE}),
  CHECK((role='control-center' AND pet_id IS NULL AND owner_key='control-center')
    OR (role='pet' AND pet_id IS NOT NULL AND owner_key='pet:'||pet_id))
) STRICT;
CREATE TRIGGER host_window_anchor_no_replace BEFORE INSERT ON host_window_anchors
WHEN EXISTS(SELECT 1 FROM host_window_anchors a WHERE a.owner_key=NEW.owner_key) OR (SELECT count(*) FROM host_window_anchors)>=101
BEGIN SELECT RAISE(ABORT,'Host anchor identity is not replaceable'); END;
CREATE TRIGGER host_window_anchor_monotonic BEFORE UPDATE ON host_window_anchors
WHEN OLD.owner_key IS NOT NEW.owner_key OR OLD.role IS NOT NEW.role OR OLD.pet_id IS NOT NEW.pet_id OR NEW.observed_at<OLD.observed_at
BEGIN SELECT RAISE(ABORT,'Host anchor identity and observation time are monotonic'); END;
`;

export type HostPreferenceErrorCode = 'INACTIVE'|'INVALID_RECORD'|'REVISION_CONFLICT'|'NOT_FOUND'|'OBSERVATION_REGRESSION';
export class HostPreferenceStorageError extends Error {
  readonly code: HostPreferenceErrorCode;
  constructor(code:HostPreferenceErrorCode){super(code);this.name='HostPreferenceStorageError';this.code=code;}
}
const fail=(code:HostPreferenceErrorCode):never=>{throw new HostPreferenceStorageError(code);};
function row(value:unknown):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return fail('INVALID_RECORD');
  return value as Record<string,unknown>;
}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  const data=row(value);
  if(Object.keys(data).length!==keys.length||keys.some(key=>!Object.hasOwn(data,key)))return fail('INVALID_RECORD');
  return data;
}
function integer(value:unknown,min=0,max=MAX_SAFE):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail('INVALID_RECORD');return value;
}
function sqlInteger(value:unknown,min=0,max=MAX_SAFE):number{return integer(typeof value==='bigint'?Number(value):value,min,max);}
function bool(value:unknown):boolean{if(typeof value!=='boolean')return fail('INVALID_RECORD');return value;}
function sqlBool(value:unknown):boolean{return sqlInteger(value,0,1)===1;}
function scale(value:unknown):HostScalePercent{if(!HOST_SCALE_CHOICES.includes(value as HostScalePercent))return fail('INVALID_RECORD');return value as HostScalePercent;}
function pet(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))return fail('INVALID_RECORD');return value;}
function identity(role:unknown,petId:unknown):{role:HostWindowRole;petId:string|null;key:string}{
  if(role==='control-center'&&petId===null)return {role,petId:null,key:'control-center'};
  if(role==='pet'){const id=pet(petId);return {role,petId:id,key:`pet:${id}`};}
  return fail('INVALID_RECORD');
}
function preferencesValues(value:unknown):HostPreferenceValues{
  const data=closed(value,['hotkeysEnabled','scalePercent','reducedMotion']);
  return {hotkeysEnabled:bool(data.hotkeysEnabled),scalePercent:scale(data.scalePercent),reducedMotion:bool(data.reducedMotion)};
}
function samePreferences(a:HostPreferenceValues,b:HostPreferenceValues):boolean{
  return a.hotkeysEnabled===b.hotkeysEnabled&&a.scalePercent===b.scalePercent&&a.reducedMotion===b.reducedMotion;
}
const anchorFields=['role','petId','displayId','offsetX','offsetY','x','y','width','height','displayScale1000','observedAt'] as const;
function anchor(value:unknown):HostWindowAnchor{
  const data=closed(value,anchorFields),owner=identity(data.role,data.petId);
  return {role:owner.role,petId:owner.petId,displayId:integer(data.displayId,-MAX_SAFE),
    offsetX:integer(data.offsetX,-COORDINATE_LIMIT,COORDINATE_LIMIT),offsetY:integer(data.offsetY,-COORDINATE_LIMIT,COORDINATE_LIMIT),
    x:integer(data.x,-COORDINATE_LIMIT,COORDINATE_LIMIT),y:integer(data.y,-COORDINATE_LIMIT,COORDINATE_LIMIT),
    width:integer(data.width,1,EXTENT_LIMIT),height:integer(data.height,1,EXTENT_LIMIT),
    displayScale1000:integer(data.displayScale1000,250,8000),observedAt:integer(data.observedAt)};
}
function anchorFromRow(value:unknown):HostWindowAnchor{
  const r=row(value),owner=identity(r.role,r.pet_id);
  if(owner.key!==r.owner_key)return fail('INVALID_RECORD');
  return anchor({role:owner.role,petId:owner.petId,displayId:sqlInteger(r.display_id,-MAX_SAFE),
    offsetX:sqlInteger(r.offset_x,-COORDINATE_LIMIT,COORDINATE_LIMIT),offsetY:sqlInteger(r.offset_y,-COORDINATE_LIMIT,COORDINATE_LIMIT),
    x:sqlInteger(r.x,-COORDINATE_LIMIT,COORDINATE_LIMIT),y:sqlInteger(r.y,-COORDINATE_LIMIT,COORDINATE_LIMIT),
    width:sqlInteger(r.width,1,EXTENT_LIMIT),height:sqlInteger(r.height,1,EXTENT_LIMIT),
    displayScale1000:sqlInteger(r.display_scale1000,250,8000),observedAt:sqlInteger(r.observed_at)});
}
function sameGeometry(a:HostWindowAnchor,b:HostWindowAnchor):boolean{
  return anchorFields.every(field=>field==='observedAt'||a[field]===b[field]);
}

/** A short, scoped projection on the authoritative game's existing writer. */
export class HostPreferenceStorage {
  private readonly connection:SqliteConnection;
  private readonly inScope:()=>boolean;
  constructor(connection:SqliteConnection,inScope:()=>boolean){this.connection=connection;this.inScope=inScope;}
  private get db():SqliteConnection{if(!this.inScope())return fail('INACTIVE');return this.connection;}

  getPreferences():HostPreferences{
    const r=row(this.db.prepare('SELECT * FROM host_preferences WHERE singleton=1').get());
    const revision=sqlInteger(r.revision),updatedAt=r.updated_at===null?null:sqlInteger(r.updated_at);
    const values={hotkeysEnabled:sqlBool(r.hotkeys_enabled),scalePercent:scale(sqlInteger(r.scale_percent)),reducedMotion:sqlBool(r.reduced_motion)};
    if((revision===0)!==(updatedAt===null)||(revision===0&&!samePreferences(values,DEFAULT_HOST_PREFERENCES)))return fail('INVALID_RECORD');
    return {...values,revision,updatedAt};
  }

  savePreferences(raw:HostPreferenceValues,expectedRevision:number,at:number):HostPreferences{
    const db=this.db,values=preferencesValues(raw),expected=integer(expectedRevision),now=integer(at),before=this.getPreferences();
    if(before.revision!==expected||(before.updatedAt!==null&&now<before.updatedAt))return fail('REVISION_CONFLICT');
    if(samePreferences(before,values))return before;
    if(expected===MAX_SAFE)return fail('REVISION_CONFLICT');
    const revision=expected+1;
    const changed=db.prepare(`UPDATE host_preferences SET revision=?,hotkeys_enabled=?,scale_percent=?,reduced_motion=?,updated_at=? WHERE singleton=1 AND revision=?`)
      .run(revision,Number(values.hotkeysEnabled),values.scalePercent,Number(values.reducedMotion),now,expected).changes;
    if(sqlInteger(changed)!==1)return fail('REVISION_CONFLICT');
    return {...values,revision,updatedAt:now};
  }

  getAnchor(role:HostWindowRole,petId:string|null):HostWindowAnchor|null{
    const owner=identity(role,petId),value=this.db.prepare('SELECT * FROM host_window_anchors WHERE owner_key=?').get(owner.key);
    return value==null?null:anchorFromRow(value);
  }

  listAnchors():HostWindowAnchor[]{
    const values=this.db.prepare('SELECT * FROM host_window_anchors ORDER BY owner_key ASC LIMIT 102').all();
    if(values.length>101)return fail('INVALID_RECORD');return values.map(anchorFromRow);
  }

  saveAnchor(raw:HostWindowAnchor):boolean{
    const db=this.db,next=anchor(raw),owner=identity(next.role,next.petId),before=this.getAnchor(next.role,next.petId);
    if(owner.petId!==null&&db.prepare('SELECT 1 FROM pets WHERE pet_id=?').get(owner.petId)==null)return fail('NOT_FOUND');
    if(before!==null&&next.observedAt<before.observedAt)return fail('OBSERVATION_REGRESSION');
    if(before!==null&&sameGeometry(before,next)){
      // Preserve the observation high-water mark even when a later event
      // confirms identical geometry; a delayed older move cannot win.
      if(next.observedAt>before.observedAt){
        const changed=db.prepare('UPDATE host_window_anchors SET observed_at=? WHERE owner_key=? AND observed_at=?')
          .run(next.observedAt,owner.key,before.observedAt).changes;
        if(sqlInteger(changed)!==1)return fail('OBSERVATION_REGRESSION');
      }
      return false;
    }
    if(before===null){
      if(this.listAnchors().length>=101)return fail('INVALID_RECORD');
      db.prepare('INSERT INTO host_window_anchors VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(owner.key,next.role,next.petId,next.displayId,next.offsetX,next.offsetY,next.x,next.y,next.width,next.height,next.displayScale1000,next.observedAt);
    }else{
      const changed=db.prepare(`UPDATE host_window_anchors SET display_id=?,offset_x=?,offset_y=?,x=?,y=?,width=?,height=?,display_scale1000=?,observed_at=? WHERE owner_key=? AND observed_at=?`)
        .run(next.displayId,next.offsetX,next.offsetY,next.x,next.y,next.width,next.height,next.displayScale1000,next.observedAt,owner.key,before.observedAt).changes;
      if(sqlInteger(changed)!==1)return fail('OBSERVATION_REGRESSION');
    }
    return true;
  }
}
