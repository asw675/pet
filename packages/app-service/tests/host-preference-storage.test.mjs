import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SQLiteRepository } from '../src/sqlite-repository.ts';
import { DEFAULT_HOST_PREFERENCES, HOST_SCALE_CHOICES } from '../src/host-preference-storage.ts';

const AT=1_800_000_000_000;
const pet=(petId='pet-a')=>({petId,characterId:'star-singer',nickname:'旅伴',power:30,presence:'HOME',activity:'IDLE',mood:'CALM',healthStatus:'NORMAL',
  visibility:'VISIBLE',moodScore10:750,healthPoints10:1000,energy10:600,bond10:150,xp:0,revision:0});
const preferences={revision:0,logicalTime:AT,primaryPetId:'pet-a',doNotDisturb:false,pausedRender:false};
const anchor=(role='control-center',petId=null,changes={})=>({role,petId,displayId:-111,offsetX:100,offsetY:50,x:-1820,y:-30,width:900,height:680,displayScale1000:1250,observedAt:AT,...changes});
const initial={...DEFAULT_HOST_PREFERENCES,revision:0,updatedAt:null};
const values={hotkeysEnabled:false,scalePercent:125,reducedMotion:true};
function withMemory(action){const db=new DatabaseSync(':memory:'),repo=new SQLiteRepository(db,{persistent:false});try{return action(repo,db);}finally{repo.close();}}
function seed(repo){repo.transaction(tx=>{tx.savePet(pet());tx.savePet(pet('pet-b'));tx.savePreferences(preferences);});}

describe('durable Main-observed host preferences/anchors',()=>{
  it('has fixed opt-in hotkeys, normal scale, ordinary motion and no invented window placement or OS login state',()=>withMemory((repo,db)=>{
    expect(HOST_SCALE_CHOICES).toEqual([50,75,100,125,150,200]);
    repo.transaction(tx=>{
      const store=tx.hostPreferences();expect(store.getPreferences()).toEqual(initial);expect(store.listAnchors()).toEqual([]);
      expect(store.getAnchor('control-center',null)).toBeNull();expect(store.getAnchor('pet','pet-a')).toBeNull();
      expect(store.savePreferences(DEFAULT_HOST_PREFERENCES,0,AT)).toEqual(initial);
      expect(tx.getPreferences()).toBeNull();expect(tx.listPets()).toEqual([]);
    });
    expect(db.prepare('SELECT count(*) AS n FROM host_window_anchors').get().n).toBe(0);
    expect(db.prepare('SELECT updated_at FROM host_preferences').get().updated_at).toBeNull();
  }));

  it('maintains independent explicit settings CAS and idempotency, rejecting stale time/revision or unknown scale/fields',()=>withMemory(repo=>{
    seed(repo);
    repo.transaction(tx=>{
      const s=tx.hostPreferences();expect(s.savePreferences(values,0,AT)).toEqual({...values,revision:1,updatedAt:AT});
      expect(s.savePreferences(values,1,AT+500)).toEqual({...values,revision:1,updatedAt:AT});
      for(const bad of [{...values,scalePercent:80},{...values,hotkeysEnabled:1},{...values,runAtLogin:true},{...values,path:'synthetic'}, {scalePercent:100}])
        expect(()=>s.savePreferences(bad,1,AT+1)).toThrow(/INVALID_RECORD/);
      expect(()=>s.savePreferences(DEFAULT_HOST_PREFERENCES,0,AT)).toThrow(/REVISION_CONFLICT/);
      expect(()=>s.savePreferences(DEFAULT_HOST_PREFERENCES,1,AT-1)).toThrow(/REVISION_CONFLICT/);
      expect(s.savePreferences(DEFAULT_HOST_PREFERENCES,1,AT+1)).toEqual({...DEFAULT_HOST_PREFERENCES,revision:2,updatedAt:AT+1});
      expect(tx.getPreferences()).toEqual(preferences);expect(tx.getPet('pet-a').revision).toBe(0);expect(tx.listOutbox(0,10)).toEqual([]);
    });
  }));

  it('roundtrips separate control-center and each owned pet anchor with negative DIP coordinates and integer DPI',()=>withMemory(repo=>{
    seed(repo);
    const cc=anchor(),a=anchor('pet','pet-a',{displayId:0,width:260,height:295,offsetX:1800,x:-120,displayScale1000:1500}),b=anchor('pet','pet-b',{displayId:2,x:800,y:600,width:310,height:360,displayScale1000:2000});
    repo.transaction(tx=>{
      const s=tx.hostPreferences();for(const entry of [b,a,cc])expect(s.saveAnchor(entry)).toBe(true);
      expect(s.listAnchors()).toEqual([cc,a,b]);expect(s.getAnchor('pet','pet-a')).toEqual(a);expect(s.getAnchor('pet','pet-b')).toEqual(b);
      expect(s.getPreferences()).toEqual(initial);expect(tx.getPreferences()).toEqual(preferences);
    });
  }));

  it('requires actual known pet identity and rejects malformed roles, extra paths, unsafe numbers and impossible extents',()=>withMemory((repo,db)=>{
    seed(repo);
    repo.transaction(tx=>{
      const s=tx.hostPreferences(),valid=anchor();
      for(const invalid of [{...valid,role:'pet',petId:null},{...valid,petId:'pet-a'},{...valid,role:'browser'}, {...valid,displayId:1.1},
        {...valid,displayId:Number.MAX_SAFE_INTEGER+1},{...valid,x:-1_000_001},{...valid,offsetY:1_000_001},{...valid,width:0},{...valid,height:32_769},
        {...valid,displayScale1000:249},{...valid,displayScale1000:8001},{...valid,observedAt:-1},{...valid,rawPath:'not-allowed'}])expect(()=>s.saveAnchor(invalid)).toThrow(/INVALID_RECORD/);
      expect(()=>s.saveAnchor(anchor('pet','unknown'))).toThrow(/NOT_FOUND/);
      expect(()=>s.getAnchor('control-center','pet-a')).toThrow(/INVALID_RECORD/);expect(s.listAnchors()).toEqual([]);
      s.saveAnchor(valid);
    });
    expect(()=>db.prepare(`INSERT INTO host_window_anchors VALUES('pet:unknown','pet','unknown',0,0,0,0,0,100,100,1000,?)`).run(AT)).toThrow(/foreign key/i);
    expect(()=>db.prepare(`INSERT INTO host_window_anchors VALUES('arbitrary','control-center',NULL,0,0,0,0,0,100,100,1000,?)`).run(AT)).toThrow(/check constraint/i);
  }));

  it('uses monotonic observations (including unchanged-geometry high-water mark), never a shared game revision',()=>withMemory(repo=>{
    seed(repo);const a=anchor('pet','pet-a');
    repo.transaction(tx=>{
      const s=tx.hostPreferences();expect(s.saveAnchor(a)).toBe(true);expect(s.saveAnchor({...a,observedAt:AT+100})).toBe(false);
      expect(s.getAnchor(a.role,a.petId).observedAt).toBe(AT+100);
      expect(()=>s.saveAnchor({...a,x:a.x+1,observedAt:AT+99})).toThrow(/OBSERVATION_REGRESSION/);
      const moved={...a,x:a.x+10,offsetX:a.offsetX+10,observedAt:AT+101};expect(s.saveAnchor(moved)).toBe(true);
      expect(s.getAnchor(a.role,a.petId)).toEqual(moved);expect(s.getPreferences()).toEqual(initial);expect(tx.getPreferences()).toEqual(preferences);
    });
  }));

  it('enforces raw SQL singleton/anchor identity and monotonic constraints, and rolls everything back in one transaction',()=>withMemory((repo,db)=>{
    seed(repo);const cc=anchor();
    expect(()=>repo.transaction(tx=>{tx.hostPreferences().savePreferences(values,0,AT);tx.hostPreferences().saveAnchor(cc);tx.setWalletCoins(12);throw new Error('rollback host');})).toThrow(/rollback host/);
    expect(repo.transaction(tx=>[tx.hostPreferences().getPreferences(),tx.hostPreferences().listAnchors(),tx.getWalletCoins()])).toEqual([initial,[],0]);
    repo.transaction(tx=>{tx.hostPreferences().savePreferences(values,0,AT);tx.hostPreferences().saveAnchor(cc);});
    for(const sql of ['DELETE FROM host_preferences','INSERT OR REPLACE INTO host_preferences VALUES(1,0,1,100,0,NULL)',
      'UPDATE host_preferences SET revision=0','UPDATE host_preferences SET revision=revision+1','UPDATE host_preferences SET revision=revision+1,updated_at=0,scale_percent=150',
      'INSERT OR REPLACE INTO host_window_anchors SELECT * FROM host_window_anchors','UPDATE host_window_anchors SET observed_at=observed_at-1',
      "UPDATE host_window_anchors SET role='pet',pet_id='pet-a',owner_key='pet:pet-a'"]){expect(()=>db.exec(sql)).toThrow(/monotonic|replaceable|cannot be deleted/);}
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }));

  it('keeps explicit settings and observed anchors through real WAL reopen, with escaped storage guards',()=>{
    const dir=mkdtempSync(join(tmpdir(),'pet-host-pref-')),path=join(dir,'game.sqlite3'),cc=anchor();
    const source=new DatabaseSync(path),repo=new SQLiteRepository(source,{persistent:true});let escaped;
    try{
      seed(repo);repo.transaction(tx=>{escaped=tx.hostPreferences();escaped.savePreferences(values,0,AT);escaped.saveAnchor(cc);});
      expect(()=>escaped.getPreferences()).toThrow(/INACTIVE/);
      repo.transaction(tx=>{expect(()=>escaped.listAnchors()).toThrow(/INACTIVE/);expect(tx.hostPreferences().getPreferences().revision).toBe(1);});
      repo.close();const opened=new DatabaseSync(path),again=new SQLiteRepository(opened,{persistent:true});
      try{again.transaction(tx=>{expect(tx.hostPreferences().getPreferences()).toEqual({...values,revision:1,updatedAt:AT});expect(tx.hostPreferences().listAnchors()).toEqual([cc]);});}
      finally{again.close();}
    }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
  });
});
